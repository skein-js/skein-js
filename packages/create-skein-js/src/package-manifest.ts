// The generated project's package.json. Built as an object and JSON-stringified rather than as
// lines of text, because a manifest has no comments to preserve and JSON.stringify's two-space
// output is already what Prettier produces.
//
// The scripts are the skein CLI lifecycle end to end — that is the on-ramp this scaffolder exists to
// hand someone:
//   dev           in-memory, hot reload, zero setup
//   dev:services  the Postgres + Redis `start` needs, locally
//   build         bundle the graphs to plain JS in .skein/build
//   start         serve that bundle — the production entrypoint

import { CORE_VERSIONS, PROVIDER_DETAILS, TOOLCHAIN_VERSIONS } from "./dependency-versions.js";
import type { ScaffoldOptions } from "./scaffold-options.js";

/** Sort keys so two manifests differing only in insertion order come out byte-identical. */
function sortedByKey(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

function scriptsFor(options: ScaffoldOptions): Record<string, string> {
  const memory = "skein dev --port 2024";
  const durable = `${memory} --store postgres --queue redis`;
  const durableIsDefault = options.devStorage === "postgres";
  return {
    // The drop-in for `langgraph dev`: TypeScript loaded in-process, hot reload, and dev state
    // persisted to .skein/ across restarts. In-memory by default — nothing to install, nothing to
    // start — unless the scaffold was told to develop against durable drivers instead.
    dev: durableIsDefault ? durable : memory,
    // `start`, and `dev` on the durable axis, need these locally.
    // `--wait`, not a bare `up -d`: without it this returns once the containers are *created*, and
    // the documented `dev:services && build && start` chain then races first-boot `initdb`. The
    // compose file declares healthchecks for both services precisely so this can block on them.
    "dev:services": "docker compose -f compose.dev.yaml up -d --wait",
    // Whichever spelling `dev` is not. Both are always emitted, so choosing one at scaffold time
    // never takes the other away — and the durable one is otherwise a pair of flags the generated
    // project never mentions, which is how "develop against Postgres" came to be undiscoverable.
    ...(durableIsDefault ? { "dev:memory": memory } : { "dev:postgres": durable }),
    // `--artifact-only` stops at .skein/build instead of invoking Docker, so `build` + `start` work
    // on a machine with no Docker daemon. Drop the flag (or use `skein up`) to get an image.
    build: "skein build --artifact-only",
    // `skein start` serves the *artifact*, so it needs the artifact's own `langgraph.json`: a bare
    // `skein start` resolves `langgraph.json` from the cwd and dies on the missing `schemas.json`
    // beside it, which made the generated README's "Ship it" steps fail at the last one.
    //
    // Run through the bin shim, from the project root. The URIs in `.env` are picked up because
    // `skein start` reads a conventional `.env` from its working directory as well as from the
    // config's — the artifact has none of its own by design (it is the Docker build context).
    start: "skein start -c .skein/build/langgraph.json",
    typecheck: "tsc --noEmit",
    test: "vitest run",
  };
}

function dependenciesFor(options: ScaffoldOptions): Record<string, string> {
  const dependencies: Record<string, string> = {
    "@langchain/core": CORE_VERSIONS["@langchain/core"],
    "@langchain/langgraph": CORE_VERSIONS["@langchain/langgraph"],
  };

  if (options.provider !== "none") {
    const provider = PROVIDER_DETAILS[options.provider];
    dependencies[provider.packageName] = provider.versionRange;
    // Only the agent graph uses zod (for its tool schema), so it follows the provider.
    dependencies["zod"] = CORE_VERSIONS["zod"];
    // Likewise `langchain`, which is where `createAgent` lives — the agent graph is the only
    // template that imports it, and it is only emitted when a provider was chosen.
    dependencies["langchain"] = CORE_VERSIONS["langchain"];
  }

  return sortedByKey(dependencies);
}

function devDependenciesFor(options: ScaffoldOptions): Record<string, string> {
  return sortedByKey({
    // The SDK is a devDependency because it is what you test and script against; the server itself
    // never imports it.
    "@langchain/langgraph-sdk": CORE_VERSIONS["@langchain/langgraph-sdk"],
    "@types/node": TOOLCHAIN_VERSIONS["@types/node"],
    "skein-js": options.skeinVersionRange,
    typescript: TOOLCHAIN_VERSIONS["typescript"],
    vitest: TOOLCHAIN_VERSIONS["vitest"],
  });
}

/** Render the generated project's `package.json`. */
export function renderPackageManifest(options: ScaffoldOptions): string {
  const manifest = {
    name: options.packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: scriptsFor(options),
    dependencies: dependenciesFor(options),
    devDependencies: devDependenciesFor(options),
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}
