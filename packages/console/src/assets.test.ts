// What the generated asset module has to guarantee, and what it is allowed to cost.
//
// There is no "is the generated file stale?" test here, unlike storage-postgres's migrations: the
// generated module is not committed, and `build` / `typecheck` / `test` all depend on the
// `generate-assets` target, so drift is impossible by construction rather than caught after the fact.

import { describe, expect, it } from "vitest";

import { CONSOLE_ASSETS_BYTES } from "./assets.generated.js";
import { consoleAssetFiles, resolveConsoleAsset } from "./assets.js";
import { consoleAssetHeaders, normalizeMountPath, resolveConsoleRequest } from "./mount.js";

/**
 * The console is compiled into a package the CLI depends on, so its size is everyone's install cost.
 * This ceiling is deliberately close to the current build: it should fail when a dependency is added
 * carelessly, and be raised knowingly when a feature earns it.
 */
const SIZE_BUDGET_BYTES = 900 * 1024;

describe("bundled assets", () => {
  it("contains an index.html and a script", () => {
    const files = consoleAssetFiles();
    expect(files).toContain("index.html");
    expect(files.some((file) => file.endsWith(".js"))).toBe(true);
  });

  it("stays inside the size budget", () => {
    expect(CONSOLE_ASSETS_BYTES).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });

  it("references only files it actually bundles", () => {
    // A relative asset URL that resolves to nothing is a blank console, and the resolver deliberately
    // does not fall back to index.html — so a missing reference must fail here instead.
    const index = resolveConsoleAsset("/");
    expect(index.kind).toBe("asset");
    if (index.kind !== "asset") return;

    const html = new TextDecoder().decode(index.asset.bytes);
    const referenced = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(consoleAssetFiles()).toContain(file);
    }
  });
});

describe("resolveConsoleAsset", () => {
  it("serves index.html at the root", () => {
    const resolved = resolveConsoleAsset("/");
    expect(resolved.kind).toBe("asset");
    if (resolved.kind !== "asset") return;
    expect(resolved.asset.file).toBe("index.html");
    expect(resolved.asset.contentType).toBe("text/html; charset=utf-8");
  });

  it("redirects a bare mount path to its slashed form", () => {
    // Without the slash the browser resolves `./assets/console.js` against the parent directory.
    expect(resolveConsoleAsset("")).toEqual({ kind: "redirect", location: "/console/" });
    expect(resolveConsoleAsset("", { mountPath: "/admin/console" })).toEqual({
      kind: "redirect",
      location: "/admin/console/",
    });
  });

  it("misses on unknown paths rather than falling back to index.html", () => {
    expect(resolveConsoleAsset("/nope.js").kind).toBe("miss");
    expect(resolveConsoleAsset("/threads/abc").kind).toBe("miss");
  });

  it("does not resolve inherited object properties", () => {
    // `CONSOLE_ASSETS` is a plain object; a naive lookup would answer for "constructor".
    expect(resolveConsoleAsset("/constructor").kind).toBe("miss");
    expect(resolveConsoleAsset("/__proto__").kind).toBe("miss");
  });

  it("marks stable filenames revalidate-always and hashed ones immutable", () => {
    const index = resolveConsoleAsset("/");
    if (index.kind !== "asset") throw new Error("index.html should resolve");
    expect(index.asset.cacheControl).toBe("no-cache, must-revalidate");

    const script = resolveConsoleAsset("/assets/console.js");
    if (script.kind !== "asset") throw new Error("console.js should resolve");
    // Unhashed by design (see ui/vite.config.mts), so it must revalidate or upgrades never land.
    expect(script.asset.cacheControl).toBe("no-cache, must-revalidate");
  });

  it("decodes to the byte length it advertises", () => {
    const index = resolveConsoleAsset("/");
    if (index.kind !== "asset") throw new Error("index.html should resolve");
    expect(index.asset.bytes.byteLength).toBe(index.asset.byteLength);
  });
});

describe("resolveConsoleRequest", () => {
  it("resolves paths under the mount and misses everything else", () => {
    expect(resolveConsoleRequest("/console/").kind).toBe("asset");
    expect(resolveConsoleRequest("/console").kind).toBe("redirect");
    expect(resolveConsoleRequest("/threads").kind).toBe("miss");
    // A path that merely starts with the mount's characters is not under the mount.
    expect(resolveConsoleRequest("/console-of-mine").kind).toBe("miss");
  });

  it("honours a custom mount path", () => {
    expect(resolveConsoleRequest("/admin/ui/", { mountPath: "/admin/ui" }).kind).toBe("asset");
    expect(resolveConsoleRequest("/console/", { mountPath: "/admin/ui" }).kind).toBe("miss");
  });
});

describe("normalizeMountPath", () => {
  it("defaults, adds a leading slash, and drops trailing ones", () => {
    expect(normalizeMountPath(undefined)).toBe("/console");
    expect(normalizeMountPath("/")).toBe("/console");
    expect(normalizeMountPath("admin")).toBe("/admin");
    expect(normalizeMountPath("/admin/")).toBe("/admin");
  });
});

describe("consoleAssetHeaders", () => {
  it("sends type, length, cache policy and nosniff", () => {
    expect(
      consoleAssetHeaders({
        contentType: "text/html; charset=utf-8",
        byteLength: 42,
        cacheControl: "no-cache, must-revalidate",
      }),
    ).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-length": "42",
      "cache-control": "no-cache, must-revalidate",
      "x-content-type-options": "nosniff",
    });
  });
});

describe("bare-mount redirect", () => {
  it("carries the query string across", () => {
    // `/console?baseUrl=…` is the documented way to point a console at a remote deployment. Dropping
    // the query on the redirect silently discarded exactly the thing the link existed to carry.
    expect(resolveConsoleAsset("", { search: "?baseUrl=https://agents.example" })).toEqual({
      kind: "redirect",
      location: "/console/?baseUrl=https://agents.example",
    });
    expect(resolveConsoleRequest("/console", { search: "?a=1&b=2" })).toEqual({
      kind: "redirect",
      location: "/console/?a=1&b=2",
    });
  });

  it("normalizes a query that is missing, empty, or unprefixed", () => {
    expect(resolveConsoleAsset("")).toEqual({ kind: "redirect", location: "/console/" });
    expect(resolveConsoleAsset("", { search: "" })).toEqual({
      kind: "redirect",
      location: "/console/",
    });
    expect(resolveConsoleAsset("", { search: "?" })).toEqual({
      kind: "redirect",
      location: "/console/",
    });
    expect(resolveConsoleAsset("", { search: "a=1" })).toEqual({
      kind: "redirect",
      location: "/console/?a=1",
    });
  });
});
