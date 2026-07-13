// `loadConfig` — the one entry point everything downstream consumes. It finds and validates
// `langgraph.json`, resolves each declared graph to an absolute `path:export` spec, and hands
// back a registry that lazily loads the resolved graph (and its JSON schemas) on demand.
// Loading is lazy + cached so pointing at a config with a graph that needs a key (e.g. an
// LLM) doesn't import that graph until something actually asks for it; a *failed* load is not
// memoized, so a transient error (missing env, syntax slip) can be retried without a restart.

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  getStaticGraphSchema,
  type GraphSchema as GraphIntrospectionSchema,
} from "@langchain/langgraph-api/schema";

import { SkeinConfigError } from "./errors.js";
import { loadGraph, parseGraphSpec, type GraphSpec, type ResolvedGraph } from "./graph-spec.js";
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

export interface LoadConfigOptions {
  /** Directory to resolve `configPath` (and default discovery) against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Path to a `langgraph.json`, absolute or relative to `cwd`. Defaults to `langgraph.json`. */
  configPath?: string;
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

export async function loadConfig(options: LoadConfigOptions = {}): Promise<SkeinConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.resolve(cwd, options.configPath ?? "langgraph.json");
  const configDir = path.dirname(configPath);

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
      return memoize(graphCache, graphId, () => loadGraph(spec));
    },
    async schemas(graphId) {
      const spec = specFor(graphId);
      return memoize(schemaCache, graphId, () => getStaticGraphSchema(spec));
    },
  };

  return { config, configPath, configDir, graphs };
}
