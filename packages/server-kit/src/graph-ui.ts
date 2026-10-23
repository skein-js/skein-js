import { readFile } from "node:fs/promises";
import path from "node:path";

import type { LanggraphJson } from "@skein-js/config";
import { SkeinHttpError } from "@skein-js/core";

import { originalNativeUrl } from "./native-http.js";

interface UiFile {
  basename: string;
  contents: Uint8Array;
}
type UiFiles = Map<string, UiFile[]>;
const watches = new Map<string, Promise<UiFiles>>();

function escapeAttribute(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

async function readCompiledUi(
  config: LanggraphJson,
  configDir: string,
): Promise<UiFiles | undefined> {
  const root = path.join(configDir, "ui");
  let manifest: Record<string, { assets: string[] }>;
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, "schemas.json"), "utf8"),
    ) as typeof manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const files: UiFiles = new Map();
  for (const graphId of Object.keys(config.ui ?? {})) {
    const assets = manifest[graphId]?.assets;
    if (!Array.isArray(assets) || !assets.length)
      throw new Error(`Built UI manifest has no assets for "${graphId}".`);
    const loaded: UiFile[] = [];
    for (const basename of assets) {
      if (
        typeof basename !== "string" ||
        basename !== path.basename(basename) ||
        basename === "." ||
        basename === ".."
      )
        throw new Error("Built UI manifest contains an invalid asset name.");
      const filename = path.resolve(root, "public", graphId, basename);
      if (!filename.startsWith(`${path.resolve(root, "public")}${path.sep}`))
        throw new Error("Built UI asset escapes its artifact directory.");
      loaded.push({ basename, contents: new Uint8Array(await readFile(filename)) });
    }
    files.set(graphId, loaded);
  }
  return files;
}

/** Development delegates compilation/watch to the public upstream API; artifacts only read assets. */
export async function loadGraphUiHandler(
  config: LanggraphJson,
  configDir: string,
): Promise<((request: Request) => Promise<Response | undefined>) | undefined> {
  if (!config.ui || !Object.keys(config.ui).length) return undefined;
  let files = await readCompiledUi(config, configDir);
  if (!files) {
    const key = JSON.stringify([configDir, config.ui, config.ui_config]);
    let pending = watches.get(key);
    if (!pending) {
      pending = (async () => {
        const { build, watch } = await import(/* webpackIgnore: true */ "@langchain/langgraph-ui");
        // watch() resolves before its first output and has no build-error callback. A public build
        // validates sources and seeds assets before the server accepts bootstrap requests.
        await build({
          cwd: configDir,
          defs: config.ui,
          config: config.ui_config,
          output: ".skein/ui",
        });
        const results = (await readCompiledUi(config, path.join(configDir, ".skein")))!;
        await watch({
          cwd: configDir,
          defs: config.ui,
          config: config.ui_config,
          onOutput: (graphId, output) => {
            results.set(graphId, output);
          },
        });
        return results;
      })();
      watches.set(key, pending);
      void pending.catch(() => watches.delete(key));
    }
    files = await pending;
  }
  const registry = files;
  return async (request) => {
    const url = new URL(request.url);
    const match = /^\/ui\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return undefined;
    let graphId: string;
    let basename: string | undefined;
    try {
      graphId = decodeURIComponent(match[1]!);
      basename = match[2] ? decodeURIComponent(match[2]) : undefined;
    } catch {
      throw SkeinHttpError.badRequest("Invalid UI path encoding.");
    }
    const assets = registry.get(graphId);
    if (!assets?.length) return new Response("UI not found", { status: 404 });
    if (request.method === "GET" && basename) {
      const asset = assets.find((file) => file.basename === basename);
      if (!asset) return new Response("Asset not found", { status: 404 });
      const mime: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      return new Response(new Uint8Array(asset.contents), {
        headers: {
          "content-type": mime[path.extname(basename)] ?? "application/octet-stream",
          "cache-control": "no-cache",
        },
      });
    }
    if (request.method !== "POST" || basename) return undefined;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw SkeinHttpError.badRequest("UI bootstrap requires JSON.");
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("name" in body) ||
      typeof body.name !== "string"
    )
      throw SkeinHttpError.badRequest("UI bootstrap requires a component name.");
    const assetUrl = (basename: string) =>
      escapeAttribute(
        new URL(
          `${encodeURIComponent(graphId)}/${encodeURIComponent(basename)}`,
          originalNativeUrl(request),
        ).href,
      );
    const html = assets
      .filter((file) => file.basename.endsWith(".css"))
      .map((file) => `<link rel="stylesheet" href="${assetUrl(file.basename)}" />`);
    const script = assets.find((file) => file.basename.endsWith(".js"));
    if (script) {
      const stableName = graphId.replace(/[^a-zA-Z0-9]/g, "_");
      const render = `__LGUI_${stableName}.render(${JSON.stringify(body.name)}, "{{shadowRootId}}")`;
      html.push(
        `<script src="${assetUrl(script.basename)}" onload="${escapeAttribute(render)}"></script>`,
      );
    }
    return new Response(html.join("\n"), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}
