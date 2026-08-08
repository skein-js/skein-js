// The build-time compiler for `skein build` / `skein up`: turn a project's TypeScript graphs (+ auth
// + custom embedder) into a self-contained `.skein/build` artifact of plain JS, so the production
// image runs compiled code with no vite/tsx toolchain. It bundles with vite's `build()` API — the
// SAME resolver `skein dev` uses (`resolve.tsconfigPaths`), anchored at the workspace root — so
// tsconfig `paths` / workspace aliases (`@myorg/js`, the Nx/Turborepo/pnpm-workspace pattern) resolve
// identically to dev and are inlined into the bundle, dissolving the monorepo build-context gap.
// Published `node_modules` packages stay external (recorded + pinned into the artifact package.json).

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, parseGraphSpec } from "@skein-js/config";
import {
  providerEmbedPackage,
  isCustomFunctionPath,
  telemetryRuntimePackages,
} from "@skein-js/runtime";
import type { build as viteBuild, Plugin } from "vite";

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
  /** ECMAScript bundle target derived from the selected runtime; defaults to Node 24 syntax. */
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
export function packageNameOf(specifier: string): string {
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

/** Node major used as the portable JS syntax target; defaults to the Node 24 LTS baseline. */
function nodeMajor(nodeVersion: string | undefined): string {
  return nodeVersion?.trim().match(/\d+/)?.[0] ?? "24";
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

/** One module tree's answer for a package's installed version, or undefined if it isn't there. */
function findInstalledVersion(pkg: string, fromDir: string): string | undefined {
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
    return undefined;
  }
  return undefined;
}

/**
 * Resolve an installed package's exact version, trying each module tree in order.
 *
 * Node's algorithm walks up from each directory, so one entry covers a project *and* anything hoisted
 * above it. More than one is needed because the two kinds of pinned dependency live in different
 * trees: a graph's imports belong to the **project**, while skein's own runtime peers belong to the
 * **CLI's** tree — under pnpm's strict layout a peer of `skein-js` is not reachable from the project
 * at all. Trying the project first still lets a user pin a peer themselves and have that win.
 */
function resolveInstalledVersion(pkg: string, fromDirs: readonly string[]): string {
  for (const fromDir of fromDirs) {
    const version = findInstalledVersion(pkg, fromDir);
    if (version) return version;
  }

  throw new Error(
    `skein build: could not resolve an installed version of "${pkg}". Install it in your project ` +
      `(it is imported by a graph/auth/embed module and must ship in the production image).`,
  );
}

/** What `vite.build()` resolves to. Derived, not imported: vite re-exports none of rolldown's output types. */
export type BundleResult = Awaited<ReturnType<typeof viteBuild>>;

/**
 * Fail the build unless every package the emitted JS still imports is pinned in the artifact's
 * `package.json`.
 *
 * This reads the answer back from the bundler's own output instead of trusting the resolver's
 * bookkeeping, so the two are independent: a package can only escape both by being invisible to
 * rolldown *and* to the plugin. It is the same check the image's compatibility probe performs, run on
 * the host — which is where a missing pin is cheap to fix rather than an opaque `docker build`
 * failure. Issue #6 shipped precisely because nothing asserted this.
 */
export function assertEveryImportIsPinned(
  bundle: BundleResult,
  dependencies: Record<string, string>,
): void {
  // A watcher has no output to inspect; `skein build` never sets `build.watch`, so this only narrows.
  const results = (Array.isArray(bundle) ? bundle : [bundle]).filter(
    (result) => "output" in result,
  );
  // Collected across every result before the scan: a chunk may import one emitted in another output.
  const emittedFiles = new Set(results.flatMap((result) => result.output.map((i) => i.fileName)));
  const imported = new Set<string>();
  let chunksInspected = 0;

  for (const result of results) {
    for (const item of result.output) {
      if (item.type !== "chunk") continue;
      chunksInspected += 1;
      for (const specifier of [...item.imports, ...item.dynamicImports]) {
        // Sibling chunks appear here alongside externals, as relative paths or emitted filenames.
        if (specifier.startsWith(".") || specifier.startsWith("\0")) continue;
        if (path.isAbsolute(specifier) || emittedFiles.has(specifier)) continue;
        if (isBuiltin(specifier) || specifier.startsWith("node:")) continue;
        imported.add(packageNameOf(specifier));
      }
    }
  }

  // Fail closed. A check that silently passes because it found nothing to look at is worth less than
  // no check: that is precisely the state issue #6 shipped in. Every build emits at least one graph
  // chunk, so zero means the output shape changed underneath us, not that the artifact is clean.
  if (chunksInspected === 0) {
    throw new Error(
      "skein build: the bundler returned no inspectable chunks, so the artifact's dependencies " +
        "could not be verified. This is a skein bug — please report it with your vite version.",
    );
  }

  const missing = [...imported].filter((pkg) => !(pkg in dependencies)).sort();
  if (missing.length === 0) return;

  throw new Error(
    `skein build: the bundle imports ${missing.length} package(s) the artifact does not install: ` +
      `${missing.join(", ")}. The production image would fail to start. Install them in your project, ` +
      `or list them under "dependencies" in langgraph.json if they are loaded by name at runtime.`,
  );
}

/**
 * Every externalized package, mapped to the directories that imported it. The importer dirs are the
 * anchors for version resolution: under pnpm's strict layout a package declared on an inlined
 * workspace lib is invisible from the app, and only a walk-up from the *importing file* finds it.
 */
type ExternalImporters = Map<string, Set<string>>;

function recordExternal(
  externals: ExternalImporters,
  specifier: string,
  importer: string | undefined,
): void {
  const pkg = packageNameOf(specifier);
  const importers = externals.get(pkg) ?? new Set<string>();
  // Only real files anchor a resolution — virtual/synthetic importers (`\0…`) point at nothing.
  if (importer && !importer.startsWith("\0")) importers.add(path.dirname(importer));
  externals.set(pkg, importers);
}

/**
 * Whether the production runtime could `import` this file as-is. Mirrors vite's own
 * `canExternalizeFile`: a package whose entry is `.ts`/`.json`/`.wasm`/anything else has to be
 * compiled in, because leaving it external would emit an import the image cannot load.
 *
 * The query/hash is stripped first — a resolver may hand back `…/index.js?foo`, whose raw extension
 * (`.js?foo`) matches nothing and would silently flip a loadable package to inlined.
 */
function isRuntimeLoadable(filePath: string): boolean {
  const extension = path.extname(filePath.replace(/[?#].*$/, ""));
  return extension === "" || extension === ".js" || extension === ".mjs" || extension === ".cjs";
}

/**
 * A rollup/vite resolver that decides bundle-vs-external on the **resolved** id, not the raw
 * specifier — so tsconfig-path aliases (which resolve to source files) get bundled while true
 * `node_modules` packages are externalized and recorded.
 *
 * `enforce: "pre"` is load-bearing, not a preference. Vite runs plugins as
 * `alias → pre → vite core → normal → vite build → post`, and its core resolver answers for every
 * bare specifier — externalizing published packages, resolving the rest to a file. Rolldown stops at
 * the first `resolveId` that answers, so from any later position this hook is never called for the
 * packages it exists to record. That is issue #6: the artifact's `package.json` pinned nothing the
 * graphs import, and the image's compatibility probe died on `ERR_MODULE_NOT_FOUND`.
 *
 * Running first also makes the documented order true: resolve, *then* externalize, so a bare-looking
 * alias resolves to source instead of being externalized on the strength of its shape.
 */
function externalizeNodeModules(externals: ExternalImporters): Plugin {
  return {
    name: "skein-externalize-node-modules",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // Virtual modules and already-relative/absolute ids are bundled by the default pipeline. So is
      // a `#name` subpath import: it is private to the package.json that declares it, so it names no
      // installable package and would be unresolvable the moment it left that package's own tree.
      // Running `pre` is what put these in front of this hook at all — vite's resolver used to answer
      // for them first.
      if (source.startsWith("\0") || source.startsWith("#")) return null;
      if (path.isAbsolute(source) || source.startsWith(".")) return null;
      if (isBuiltin(source) || source.startsWith("node:")) return { id: source, external: true };

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      // Unresolvable, or vite already externalized it (its answer for most published packages).
      if (!resolved || resolved.external) {
        recordExternal(externals, source, importer);
        return resolved ?? { id: source, external: true };
      }
      // A real file inside node_modules. Vite compiles some of these in — it declines to externalize
      // a package that resolves only through a bare `main` field — but the artifact runs beside an
      // installed `node_modules`, so keeping the package external is both cheaper and safer: one copy
      // of every library, and no bundler rewriting of package-relative asset paths.
      if (resolved.id.includes("node_modules") && isRuntimeLoadable(resolved.id)) {
        recordExternal(externals, source, importer);
        return { id: source, external: true };
      }
      // Workspace source through a tsconfig-path alias, or a package the runtime could not import
      // as-is (a `.ts` entry) → bundle it.
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
  // A bring-your-own store (`store.adapter`) is the same shape as auth and the custom embedder: a
  // `path:export` spec pointing at the user's own module. Bundled and repointed for the same reason —
  // and it matters more here than most, because the adapter is what the whole `/store/*` surface runs on.
  if (config.store?.adapter) {
    const spec = parseGraphSpec(config.store.adapter, configDir);
    input["store-adapter"] = spec.sourceFile;
    rewrites.storeAdapter = `./store-adapter.js:${spec.exportSymbol}`;
  }
  // Custom telemetry sinks are `path:export` specs like auth/embed, so they need the same treatment:
  // bundled into the artifact and repointed at the emitted JS. Without this the production config
  // would still name a `.ts` file that isn't in the image, and the container would fail to boot.
  const telemetryPaths = config.telemetry?.paths ?? [];
  if (telemetryPaths.length > 0) {
    rewrites.telemetryPaths = telemetryPaths.map((pathSpec, index) => {
      const spec = parseGraphSpec(pathSpec, configDir);
      const entryKey = `telemetry/${index}`;
      input[entryKey] = spec.sourceFile;
      return `./${entryKey}.js:${spec.exportSymbol}`;
    });
  }

  // Bundle and precompute schemas concurrently — the bundler produces JS, the schema pass reads the
  // original TS source; independent inputs, so run them together.
  const externals: ExternalImporters = new Map();
  const [bundle, schemas] = await Promise.all([
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

  // From here on a failure is fatal to the artifact, and vite has *already* emptied `outDir` and
  // written the new chunks — so throwing would leave bundled JS with no manifest beside it, where a
  // deployable artifact used to be, and `skein start` would report that as a missing config. Clear
  // the directory instead: a failed build should leave no artifact rather than a broken one.
  try {
    return await finishArtifact();
  } catch (error) {
    await rm(outDir, { recursive: true, force: true });
    throw error;
  }

  async function finishArtifact(): Promise<BuildArtifact> {
    // Pin every external + the skein runtime closure to its installed version, resolved from **the
    // project's** module tree — the source of truth for what dev ran against. Not from `workspaceRoot`:
    // in a monorepo the dependency is installed next to the project, and a workspace root commonly has
    // no application dependencies at all (a pnpm workspace hoists nothing by default), so resolving
    // from there fails for every project that is a package inside a repo. Node's own algorithm walks up
    // from here, so a hoisted root install is still found.
    const projectTree = [configDir];
    // skein's own peers are dependencies of `skein-js`, not of the user's project, so the CLI's tree has
    // to be searched as well — see `resolveInstalledVersion`.
    const peerTree = [configDir, path.dirname(fileURLToPath(import.meta.url))];
    const dependencies: Record<string, string> = {};
    // The project answers first, and only what it cannot see falls back to the importers: a package
    // declared on an inlined workspace lib rather than on the app is invisible from `configDir` under
    // pnpm's strict layout, and only a walk-up from the importing file finds it.
    //
    // Order matters twice over. The artifact's `package.json` is flat, so a package imported at two
    // different versions can be pinned at only one — and "the version the app declares" is both the
    // predictable answer and the one a reader can check. Importer dirs are **sorted** rather than left
    // in insertion order because that order comes from whichever concurrent `resolveId` finished first,
    // which would let two builds of the same tree pin different versions.
    for (const [pkg, importerDirs] of externals) {
      dependencies[pkg] = resolveInstalledVersion(pkg, [
        ...projectTree,
        ...[...importerDirs].sort(),
      ]);
    }
    dependencies["skein-js"] = skeinVersion;
    for (const peer of SKEIN_RUNTIME_PEERS) {
      dependencies[peer] = resolveInstalledVersion(peer, peerTree);
    }
    // Runtime deps the bundle can't discover from graph imports, so they must be pinned explicitly:
    //  • a `provider:model` embed dynamically imports `@langchain/<provider>` (never a code import);
    //  • a declared `telemetry` provider dynamically imports its `@skein-js/*` adapter;
    //  • `langgraph.json` `dependencies` — the user's escape hatch for packages loaded by name.
    // The old full-install image happened to carry these; the slim image must add them or break.
    const embedPkg = config.store?.index?.embed && providerEmbedPackage(config.store.index.embed);
    if (embedPkg) dependencies[embedPkg] = resolveInstalledVersion(embedPkg, projectTree);
    for (const pkg of telemetryRuntimePackages(config.telemetry)) {
      dependencies[pkg] = resolveInstalledVersion(pkg, projectTree);
    }
    for (const dep of config.dependencies ?? []) {
      // Skip local-path deps (".", "./pkg") — those are the project's own source, already bundled.
      if (dep.startsWith(".") || dep.startsWith("/")) continue;
      const pkg = packageNameOf(dep);
      dependencies[pkg] = resolveInstalledVersion(pkg, projectTree);
    }

    assertEveryImportIsPinned(bundle, dependencies);

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
}
