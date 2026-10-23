import { pathToFileURL } from "node:url";

import {
  parseGraphSpec,
  SkeinConfigError,
  type LanggraphJson,
  type ModuleImporter,
} from "@skein-js/config";

import { loadGraphUiHandler } from "./graph-ui.js";

type FetchApplication = (request: Request) => Response | Promise<Response>;

/** Load the same path:export notation as graphs; preserve Hono's receiver for its fetch method. */
export async function loadConfigHttpHandler(
  config: LanggraphJson,
  options: { configDir: string; importModule?: ModuleImporter },
): Promise<((request: Request) => Promise<Response | undefined>) | undefined> {
  const app = config.http?.["app"];
  const ui = await loadGraphUiHandler(config, options.configDir);
  if (app === undefined) return ui;
  if (typeof app !== "string") throw new SkeinConfigError("http.app must be a path:export string.");
  const spec = parseGraphSpec(app, options.configDir);
  const importer =
    options.importModule ??
    ((file: string) => import(pathToFileURL(file).href) as Promise<Record<string, unknown>>);
  const module = await importer(spec.sourceFile);
  const exported = module[spec.exportSymbol];
  let fetch: FetchApplication;
  if (typeof exported === "function") fetch = exported as FetchApplication;
  else if (
    typeof exported === "object" &&
    exported !== null &&
    "fetch" in exported &&
    typeof exported.fetch === "function"
  )
    fetch = exported.fetch.bind(exported) as FetchApplication;
  else
    throw new SkeinConfigError(
      `http.app "${app}" must export a Fetch function or an object with fetch().`,
    );
  return async (request) => {
    const applicationRequest = request.clone();
    let response: Response | undefined;
    try {
      response = await fetch(applicationRequest);
      if (!(response instanceof Response)) throw new TypeError("http.app must return a Response.");
      if (response.status === 404) {
        // A discarded response may itself stream the request clone. Cancellation must not wait
        // for the original body, which protocol fallthrough has yet to read.
        void response.body?.cancel().catch(() => undefined);
        return ui?.(request);
      }
      void request.body?.cancel().catch(() => undefined);
      return response;
    } finally {
      // A handled response may directly stream its request body; keep that branch alive.
      if (!response || response.status === 404 || response.body !== applicationRequest.body)
        void applicationRequest.body?.cancel().catch(() => undefined);
    }
  };
}
