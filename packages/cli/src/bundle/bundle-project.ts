// The build-time compiler for `skein build` / `skein up`: turn a project's TypeScript graphs (+ auth
// + custom embedder) into a self-contained `.skein/build` artifact of plain JS, so the production
// image runs compiled code with no vite/tsx toolchain. It bundles with vite's `build()` API — the
// SAME resolver `skein dev` uses (`resolve.tsconfigPaths`), anchored at the workspace root — so
// tsconfig `paths` / workspace aliases (`@myorg/js`, the Nx/Turborepo/pnpm-workspace pattern) resolve
// identically to dev and are inlined into the bundle, dissolving the monorepo build-context gap.
// Published `node_modules` packages stay external (recorded + pinned into the artifact package.json).

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

import { loadConfig, parseGraphSpec } from "@skein-js/config";
import { providerEmbedPackage, isCustomFunctionPath } from "@skein-js/runtime";
import type { Plugin } from "vite";

import { precomputeSchemas } from "./precompute-schemas.js";
import {
  buildArtifactPackageJson,
  buildProductionConfig,
  type ManifestRewrites,
} from "./write-manifest.js";

/** Peers of `skein-js` the runtime needs to boot, but which a graph may not import itself. */
const SKEIN_RUNTIME_PEERS = ["@langchain/langgraph", "@langchain/langgraph-checkpoint-postgres"];

export interface BundleProjectOptions {
  /** Absolute path to the source `langgraph.json`. */
  configPath: string;
  /** Absolute path to the artifact output dir (e.g. `<configDir>/.skein/build`). */
  outDir: string;
  /** `node_version` from the config, for the bundle target; defaults to 20. */
  nodeVersion?: string;
  /** The CLI's own version, pinned as `skein-js` in the artifact package.json. */
  skeinVersion: string;
}

export interface BuildArtifact {
  outDir: string;
  graphIds: string[];
  /** Externalized bare packages → exact resolved version (what the image installs). */
  externals: Record<string, string>;
}

/** The package name for a bare specifier (`@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`). */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
}

/** A filename-safe token for a graph id (ids are usually simple, but be defensive). */
function safeName(graphId: string): string {
  return graphId.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * A collision-free filename token: `safeName` can map two distinct graph ids to the same token
 * (`"a/b"` and `"a-b"` → `"a-b"`), which would make their bundle entries overwrite each other. Append
 * `-2`, `-3`, … on collision so every graph gets its own output file.
 */
function uniqueSafeName(graphId: string, used: Set<string>): string {
  const base = safeName(graphId);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

/** Node major from `node_version` (e.g. "20", ">=20", "20.11.0") for the bundle target; default 20. */
function nodeMajor(nodeVersion: string | undefined): string {
  return nodeVersion?.trim().match(/\d+/)?.[0] ?? "20";
}

/** Read a `version` from a package.json path, or undefined if unreadable. */
function readVersion(pkgJsonPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      name?: string;
      version?: string;
    };
    return parsed.version;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an installed package's exact version from `fromDir`'s module tree. Tries `<pkg>/package.json`
 * first, then walks up from the package's entry to the owning `package.json` (for packages whose
 * `exports` hides `package.json`). Throws a clear error when the package isn't installed.
 */
function resolveInstalledVersion(pkg: string, fromDir: string): string {
  const require = createRequire(path.join(fromDir, "__skein_resolver__.js"));

  try {
    const version = readVersion(require.resolve(`${pkg}/package.json`));
    if (version) return version;
  } catch {
    // `exports` may not expose package.json — fall back to walking up from the entry.
  }

  try {
    let dir = path.dirname(require.resolve(pkg));
    while (dir !== path.dirname(dir)) {
      const pkgJson = path.join(dir, "package.json");
      if (existsSync(pkgJson)) {
        const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === pkg && parsed.version) return parsed.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through to the error below
  }

  throw new Error(
    `skein build: could not resolve an installed version of "${pkg}". Install it in your project ` +
      `(it is imported by a graph/auth/embed module and must ship in the production image).`,
  );
}

/**
 * A rollup/vite resolver that decides bundle-vs-external on the **resolved** id, not the raw
 * specifier — so tsconfig-path aliases (which resolve to source files) get bundled while true
 * `node_modules` packages are externalized and recorded. Ordering matters: this must resolve first,
 * then externalize, or a bare-looking alias would be marked external before it can resolve to source.
 */
function externalizeNodeModules(externals: Set<string>): Plugin {
  return {
    name: "skein-externalize-node-modules",
    enforce: "post",
    async resolveId(source, importer, options) {
      // Virtual modules and already-relative/absolute ids are bundled by the default pipeline.
      if (source.startsWith("\0") || source.startsWith("/") || source.startsWith(".")) return null;
      if (isBuiltin(source) || source.startsWith("node:")) return { id: source, external: true };

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.id.includes("node_modules")) {
        externals.add(packageNameOf(source));
        return { id: source, external: true };
      }
      // Resolved to a workspace source file (e.g. a tsconfig-path alias) → bundle it.
      return resolved;
    },
  };
}

/**
 * Compile the project into a self-contained `.skein/build` artifact: bundled graph/auth/embed JS, a
 * precomputed `schemas.json`, a production `langgraph.json`, and a pinned `package.json`.
 */
export async function bundleProject(options: BundleProjectOptions): Promise<BuildArtifact> {
  const { configPath, outDir, nodeVersion, skeinVersion } = options;
  // vite is an optionalDependency, host-only; import it lazily so this module loads in the vite-less
  // production image (the CLI graph imports it transitively but `skein start` never calls bundleProject).
  const { build, searchForWorkspaceRoot } = await import("vite");
  const { config, configDir, graphs } = await loadConfig({ configPath });
  const workspaceRoot = searchForWorkspaceRoot(configDir);

  // Assemble the bundle entries and the manifest rewrites side by side. Entry key `foo` → `foo.js`.
  const input: Record<string, string> = {};
  const rewrites: ManifestRewrites = { graphs: {} };

  const usedGraphNames = new Set<string>();
  for (const graphId of graphs.ids) {
    const spec = graphs.spec(graphId);
    const entryKey = `graphs/${uniqueSafeName(graphId, usedGraphNames)}`;
    input[entryKey] = spec.sourceFile;
    rewrites.graphs[graphId] = `./${entryKey}.js:${spec.exportSymbol}`;
  }
  if (config.auth?.path) {
    const spec = parseGraphSpec(config.auth.path, configDir);
    input["auth"] = spec.sourceFile;
    rewrites.auth = `./auth.js:${spec.exportSymbol}`;
  }
  if (config.store?.index?.embed && isCustomFunctionPath(config.store.index.embed)) {
    const spec = parseGraphSpec(config.store.index.embed, configDir);
    input["embed"] = spec.sourceFile;
    rewrites.embed = `./embed.js:${spec.exportSymbol}`;
  }

  // Bundle and precompute schemas concurrently — the bundler produces JS, the schema pass reads the
  // original TS source; independent inputs, so run them together.
  const externals = new Set<string>();
  const [, schemas] = await Promise.all([
    build({
      root: workspaceRoot,
      configFile: false,
      logLevel: "warn",
      resolve: { tsconfigPaths: true },
      plugins: [externalizeNodeModules(externals)],
      build: {
        ssr: true,
        outDir,
        emptyOutDir: true,
        target: `node${nodeMajor(nodeVersion)}`,
        minify: true,
        sourcemap: true,
        rollupOptions: {
          input,
          output: {
            format: "es",
            entryFileNames: "[name].js",
            chunkFileNames: "chunks/[name]-[hash].js",
          },
        },
      },
    }),
    precomputeSchemas(graphs),
  ]);

  // Pin every external + the skein runtime closure to its installed version, resolved from the
  // workspace's module tree (the source of truth for what dev ran against).
  const dependencies: Record<string, string> = {};
  for (const pkg of externals) dependencies[pkg] = resolveInstalledVersion(pkg, workspaceRoot);
  dependencies["skein-js"] = skeinVersion;
  for (const peer of SKEIN_RUNTIME_PEERS) {
    dependencies[peer] = resolveInstalledVersion(peer, workspaceRoot);
  }
  // Runtime deps the bundle can't discover from graph imports, so they must be pinned explicitly:
  //  • a `provider:model` embed dynamically imports `@langchain/<provider>` (never a code import);
  //  • `langgraph.json` `dependencies` — the user's escape hatch for packages loaded by name.
  // The old full-install image happened to carry these; the slim image must add them or break.
  const embedPkg = config.store?.index?.embed && providerEmbedPackage(config.store.index.embed);
  if (embedPkg) dependencies[embedPkg] = resolveInstalledVersion(embedPkg, workspaceRoot);
  for (const dep of config.dependencies ?? []) {
    // Skip local-path deps (".", "./pkg") — those are the project's own source, already bundled.
    if (dep.startsWith(".") || dep.startsWith("/")) continue;
    const pkg = packageNameOf(dep);
    dependencies[pkg] = resolveInstalledVersion(pkg, workspaceRoot);
  }

  await mkdir(outDir, { recursive: true });
  const productionConfig = buildProductionConfig(config, rewrites);
  await Promise.all([
    writeFile(
      path.join(outDir, "langgraph.json"),
      `${JSON.stringify(productionConfig, null, 2)}\n`,
    ),
    writeFile(path.join(outDir, "schemas.json"), `${JSON.stringify(schemas, null, 2)}\n`),
    writeFile(
      path.join(outDir, "package.json"),
      buildArtifactPackageJson(path.basename(configDir), dependencies),
    ),
  ]);

  return { outDir, graphIds: graphs.ids, externals: dependencies };
}
