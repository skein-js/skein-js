// Pure builders for the two JSON files that make the `.skein/build` artifact self-contained: the
// production `langgraph.json` (graph/auth/embed specs rewritten to point at the bundled `.js`) and a
// pinned `package.json` the slim image installs to satisfy the externalized dependencies. Pure and
// side-effect-free so they're trivially unit-testable; the caller (bundle-project) does the I/O.

import type { LanggraphJson } from "@skein-js/config";

/** New `path:export` specs, relative to the artifact dir, for each thing that was bundled. */
export interface ManifestRewrites {
  /** graph id → rewritten spec, e.g. `"./graphs/agent.js:graph"`. */
  graphs: Record<string, string>;
  /** Rewritten `auth.path`, e.g. `"./auth.js:default"` — only when the config declared auth. */
  auth?: string;
  /** Rewritten `store.index.embed`, e.g. `"./embed.js:embed"` — only for a custom-function path. */
  embed?: string;
  /** Rewritten `store.adapter`, e.g. `"./store-adapter.js:store"` — only when the config declared one. */
  storeAdapter?: string;
  /** Rewritten `telemetry.paths`, e.g. `["./telemetry/0.js:sink"]` — one per declared custom sink. */
  telemetryPaths?: string[];
}

/**
 * Produce the artifact's production `langgraph.json`: the source config with every graph/auth/embed
 * spec repointed at the bundled JS, and a **string** `env` (a `.env` file path) dropped — secrets are
 * never baked into the image; runtime env arrives through the environment/compose. An **inline** `env`
 * map is preserved (it's non-secret defaults declared in the config itself). All other fields pass
 * through unchanged, so the langgraph.json contract is otherwise identical.
 */
export function buildProductionConfig(
  source: LanggraphJson,
  rewrites: ManifestRewrites,
): LanggraphJson {
  const config: LanggraphJson = structuredClone(source);

  config.graphs = { ...rewrites.graphs };

  if (rewrites.auth && config.auth) {
    config.auth = { ...config.auth, path: rewrites.auth };
  }
  if (rewrites.embed && config.store?.index) {
    config.store = {
      ...config.store,
      index: { ...config.store.index, embed: rewrites.embed },
    };
  }
  // A bring-your-own store is a `path:export` spec like auth and the custom embedder, so it needs the
  // same repointing — otherwise the production config still names `./src/my-store.ts`, which is not in
  // the image, and the server fails at boot with "failed to import module".
  if (rewrites.storeAdapter && config.store) {
    config.store = { ...config.store, adapter: rewrites.storeAdapter };
  }
  if (rewrites.telemetryPaths && config.telemetry) {
    config.telemetry = { ...config.telemetry, paths: rewrites.telemetryPaths };
  }

  // A string `env` is a path to a `.env` file (a secret, excluded from the image). Drop it so the
  // production config never references a file that isn't there; an inline map stays.
  if (typeof config.env === "string") delete config.env;

  return config;
}

/**
 * Produce the artifact `package.json` the image installs with `npm install --omit=dev`. `dependencies`
 * is the fully-resolved, exact-pinned map (externalized user deps + the skein runtime closure), so the
 * install is deterministic without a lockfile. Keys are sorted for a stable, diff-friendly file.
 */
export function buildArtifactPackageJson(
  appName: string,
  dependencies: Record<string, string>,
): string {
  const sorted = Object.fromEntries(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  const pkg = {
    name: `${appName}-skein-artifact`,
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: sorted,
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
