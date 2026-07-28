// Packaging guard for every publishable package. skein is ESM-only, but consumers still reach for
// `require()` — Node's require(esm) (20.19+/22.12+) and every CJS-emitting bundler resolve through
// the `require` condition. Without a matching condition they fail with ERR_PACKAGE_PATH_NOT_EXPORTED,
// which reads like the package is broken rather than like a module-format mismatch. `default` is the
// catch-all that matches it, and it must come last (conditional exports match in declaration order).
// See docs/bundling.md.
//
// This lives in test-support because it is a workspace-level assertion, not a per-package one.
// `packages/test-support/project.json` gives the `test` target an explicit input covering every
// `packages/*/package.json`, because Nx's default inputs only cover this project's own files plus
// its dependencies — without that, editing another package's manifest would replay a cached pass
// and this guard would never run.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * `skein-js` is a CLI, not a library: it has no exports and its entry runs a command on import. It
 * is published, but the library export contract below deliberately does not apply — see
 * docs/bundling.md ("never bundle the CLI").
 */
const BIN_ONLY_PACKAGES = new Set(["skein-js"]);

interface WorkspacePackage {
  readonly directory: string;
  readonly manifest: Record<string, unknown>;
}

/** Every `packages/*` manifest that `nx release` publishes (i.e. not marked private). */
function readPublishablePackages(): WorkspacePackage[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const manifestPath = path.join(packagesDir, entry.name, "package.json");
      if (!existsSync(manifestPath)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      return manifest.private === true ? [] : [{ directory: entry.name, manifest }];
    });
}

const publishablePackages = readPublishablePackages();
const libraryPackages = publishablePackages.filter(
  (pkg) => !BIN_ONLY_PACKAGES.has(pkg.manifest.name as string),
);

describe("publishable package manifests", () => {
  it("finds every publishable package", () => {
    // Guards the discovery itself: a broken glob would silently make every case below vacuous.
    expect(publishablePackages.length).toBe(16);
    expect(libraryPackages.length).toBe(15);
  });

  it.each(libraryPackages.map((pkg) => [pkg.manifest.name as string, pkg] as const))(
    "%s resolves under both import and require",
    (_name, pkg) => {
      const exports = pkg.manifest.exports as Record<string, Record<string, string>> | undefined;
      const rootExport = exports?.["."];
      expect(rootExport, "must declare a root export").toBeDefined();

      // Order is the contract, not just the keys: `types` must resolve first and `default` last.
      expect(Object.keys(rootExport ?? {})).toEqual(["types", "import", "default"]);
      expect(rootExport?.types).toBe("./dist/index.d.ts");
      expect(rootExport?.import).toBe("./dist/index.js");
      expect(rootExport?.default).toBe(rootExport?.import);
    },
  );

  // The same contract for every *subpath* (`@skein-js/config/errors`, `@skein-js/server-kit/dev`).
  // Asserting only `.` left the newer surface unguarded: reorder a subpath's conditions or drop its
  // `default` and `require()` breaks with `ERR_PACKAGE_PATH_NOT_EXPORTED` for every CJS-emitting
  // bundler, with nothing failing here.
  it.each(
    libraryPackages.flatMap((pkg) =>
      Object.entries((pkg.manifest.exports ?? {}) as Record<string, Record<string, string>>)
        .filter(([subpath]) => subpath !== ".")
        .map(
          ([subpath, conditions]) =>
            [`${pkg.manifest.name as string}${subpath.slice(1)}`, subpath, conditions] as const,
        ),
    ),
  )("%s resolves under both import and require", (_name, subpath, conditions) => {
    expect(Object.keys(conditions)).toEqual(["types", "import", "default"]);
    const stem = subpath.slice(2); // "./errors" -> "errors"
    expect(conditions.types).toBe(`./dist/${stem}.d.ts`);
    expect(conditions.import).toBe(`./dist/${stem}.js`);
    expect(conditions.default).toBe(conditions.import);
  });

  // Self-guarding, like the package count above: the subpath cases are generated, so if every subpath
  // disappeared the `it.each` would assert nothing at all rather than failing.
  it("still has subpath exports to check", () => {
    const subpaths = libraryPackages.flatMap((pkg) =>
      Object.keys((pkg.manifest.exports ?? {}) as Record<string, unknown>).filter(
        (subpath) => subpath !== ".",
      ),
    );
    expect(subpaths.sort()).toEqual(["./dev", "./errors"]);
  });

  it.each(libraryPackages.map((pkg) => [pkg.manifest.name as string, pkg] as const))(
    "%s is ESM-only and side-effect free",
    (_name, pkg) => {
      expect(pkg.manifest.type).toBe("module");
      expect(pkg.manifest.sideEffects).toBe(false);
    },
  );

  it.each([...BIN_ONLY_PACKAGES])(
    "%s stays require()-unresolvable — it is a bin that runs on import",
    (name) => {
      const pkg = publishablePackages.find((candidate) => candidate.manifest.name === name);
      const rootExport = (pkg?.manifest.exports as Record<string, Record<string, string>>)["."];
      // No `default`/`require` condition on purpose: resolving it would let a CJS bundler pull the
      // CLI into a module graph, where importing it parses argv and runs a command.
      expect(Object.keys(rootExport ?? {})).toEqual(["types", "import"]);
    },
  );
});
