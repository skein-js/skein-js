// `loadConfig` — the one entry point everything downstream consumes. It finds and validates
// `langgraph.json`, resolves each declared graph to an absolute `path:export` spec, and hands
// back a registry that lazily loads the resolved graph (and its JSON schemas) on demand.
// Loading is lazy + cached so pointing at a config with a graph that needs a key (e.g. an
// LLM) doesn't import that graph until something actually asks for it; a *failed* load is not
// memoized, so a transient error (missing env, syntax slip) can be retried without a restart.

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { GraphSchema as GraphIntrospectionSchema } from "@langchain/langgraph-api/schema";

import { SkeinConfigError } from "./errors.js";
import {
  loadGraph,
  parseGraphSpec,
  type GraphSpec,
  type ModuleImporter,
  type ResolvedGraph,
} from "./graph-spec.js";
import { parseLanggraphJson, type LanggraphJson } from "./langgraph-json.js";

/** JSON schemas extracted from a graph (and any subgraphs), keyed by subgraph namespace. */
export type GraphSchemas = Record<string, GraphIntrospectionSchema>;

/** The graphs declared in `langgraph.json`, resolved and loadable on demand. */
export interface GraphRegistry {
  /** Declared graph ids, in config order. */
  readonly ids: string[];
  /** The resolved absolute spec for a graph id. Throws if the id is unknown. */
  spec(graphId: string): GraphSpec;
  /** Load (and cache) the resolved graph for an id — a compiled graph or a per-config factory. */
  load(graphId: string): Promise<ResolvedGraph>;
  /** Extract the graph's JSON schemas via langgraph-api (for assistant introspection). */
  schemas(graphId: string): Promise<GraphSchemas>;
}

/** The result of {@link loadConfig}: the validated config plus its declared, on-demand graphs. */
export interface SkeinConfig {
  /** The validated `langgraph.json` contents. */
  config: LanggraphJson;
  /** Absolute path to the loaded `langgraph.json`. */
  configPath: string;
  /** Directory holding `langgraph.json` — the base for resolving graph paths + `env`. */
  configDir: string;
  /** The declared graphs. */
  graphs: GraphRegistry;
}

/** Options for {@link loadConfig} — where to find `langgraph.json` and how to import its graphs. */
export interface LoadConfigOptions {
  /** Directory to resolve `configPath` (and default discovery) against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Path to a `langgraph.json`, absolute or relative to `cwd`. Defaults to `langgraph.json`. */
  configPath?: string;
  /**
   * How graph modules are imported for execution. Defaults to a native dynamic `import()`. `skein
   * dev` injects a vite-backed importer so TypeScript graphs load and hot-reload through vite
   * without a separate TS-loader process. Schema introspection is unaffected — it statically
   * analyses the TypeScript source and never executes the module.
   */
  importModule?: ModuleImporter;
  /**
   * Precomputed graph schemas, keyed by graph id — supplied by `skein build`/`skein start` for a
   * pre-compiled production image. When present, `schemas(id)` returns these instead of statically
   * analysing TypeScript source: the image ships bundled JS with no `.ts` to introspect, and this
   * also keeps `getStaticGraphSchema` (and its `worker_threads` parser) out of the runtime entirely.
   */
  staticSchemas?: Record<string, GraphSchemas>;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new SkeinConfigError(`Could not read langgraph.json at "${filePath}".`, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new SkeinConfigError(`langgraph.json at "${filePath}" is not valid JSON.`, { cause });
  }
}

/**
 * Find, read, and validate a `langgraph.json`, resolve each declared graph to an absolute
 * `path:export` spec, and return a {@link SkeinConfig} whose {@link GraphRegistry} loads a resolved
 * graph (and its JSON schemas) on demand. This is the entry point every downstream consumer
 * (`buildRuntime`, the adapters, the CLI) builds on.
 *
 * Loading is lazy and cached: pointing at a config whose graph needs a key (e.g. an LLM) doesn't
 * import that graph until something asks for it, and a *failed* load is not memoized — a transient
 * error (missing env, a syntax slip) can be retried without a restart.
 *
 * @throws {SkeinConfigError} when the file is missing, is not valid JSON, or fails schema validation.
 *
 * @example
 * ```ts
 * import { loadConfig } from "@skein-js/config";
 *
 * const { graphs } = await loadConfig(); // finds ./langgraph.json
 * const agent = await graphs.load("agent");
 * ```
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<SkeinConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, options.configPath ?? "langgraph.json");
  const configDir = path.dirname(configPath);
  const { importModule, staticSchemas } = options;

  const config = parseLanggraphJson(await readJsonFile(configPath));

  const specs = new Map<string, GraphSpec>();
  for (const [graphId, spec] of Object.entries(config.graphs)) {
    specs.set(graphId, parseGraphSpec(spec, configDir));
  }

  const graphCache = new Map<string, Promise<ResolvedGraph>>();
  const schemaCache = new Map<string, Promise<GraphSchemas>>();
  const specFor = (graphId: string): GraphSpec => {
    const spec = specs.get(graphId);
    if (!spec) throw new SkeinConfigError(`Unknown graph "${graphId}".`);
    return spec;
  };

  // Memoize a promise, but evict it if it rejects so the next call can retry a transient failure.
  const memoize = <T>(cache: Map<string, Promise<T>>, graphId: string, work: () => Promise<T>) => {
    const cached = cache.get(graphId);
    if (cached) return cached;
    const pending = work().catch((error: unknown) => {
      cache.delete(graphId);
      throw error;
    });
    cache.set(graphId, pending);
    return pending;
  };

  const graphs: GraphRegistry = {
    ids: [...specs.keys()],
    spec: specFor,
    // async so an unknown id (specFor throwing) surfaces as a rejection, never a synchronous
    // throw — callers uniformly `await graphs.load(id)`.
    async load(graphId) {
      const spec = specFor(graphId);
      return memoize(graphCache, graphId, () => loadGraph(spec, importModule));
    },
    async schemas(graphId) {
      // Production (pre-compiled image): serve schemas baked at build time, so the runtime never
      // parses TypeScript (there is none) or spawns the schema worker. `specFor` still validates the
      // id so an unknown graph rejects consistently with the dynamic path.
      if (staticSchemas) {
        specFor(graphId);
        const baked = staticSchemas[graphId];
        if (!baked) throw new SkeinConfigError(`No precomputed schema for graph "${graphId}".`);
        return baked;
      }
      const spec = specFor(graphId);
      // Static analysis of the TypeScript source — no module execution — so this works the same
      // whether graphs load natively or through a custom `importModule` (vite `skein dev`).
      //
      // Imported here rather than at module scope. `getStaticGraphSchema` drags `@langchain/langgraph-api`
      // (and its TypeScript parser) in with it, and this barrel is reachable from every framework
      // adapter — so a static import puts a whole TypeScript toolchain into the module graph of a
      // production server, which either bakes its schemas at build time or never asks for one. Reaching
      // this line is precisely the case that needs it. See `static-imports.test.ts`.
      return memoize(schemaCache, graphId, async () => {
        const { getStaticGraphSchema } = await import("@langchain/langgraph-api/schema");
        return getStaticGraphSchema(spec);
      });
    },
  };

  return { config, configPath, configDir, graphs };
}
