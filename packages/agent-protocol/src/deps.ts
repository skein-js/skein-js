// The injected contract for the whole package. Nothing here is a singleton: the engine, services,
// and handlers are all built from a `ProtocolDeps` the caller supplies, so `@skein-js/agent-protocol`
// stays free of any particular server, storage driver, queue, or CLI. `@skein-js/config`'s
// `GraphRegistry` structurally satisfies `GraphResolver`, but we depend on the minimal interface so
// this package never has to know `@skein-js/config` exists.

import type { BaseCheckpointSaver, CompiledGraph } from "@langchain/langgraph";
import type { GraphSchema, RunEventBus, RunQueue, SkeinStore } from "@skein-js/core";

/** A factory export: called (optionally with per-run config) to produce a compiled graph. */
export type CompiledGraphFactory = (config: {
  configurable?: Record<string, unknown>;
}) => CompiledGraph<string> | Promise<CompiledGraph<string>>;

/** A resolved graph: either a compiled graph or a factory that produces one per config. */
export type ResolvedGraph = CompiledGraph<string> | CompiledGraphFactory;

/** JSON schemas extracted from a graph (and any subgraphs), keyed by subgraph namespace. */
export type GraphSchemas = Record<string, GraphSchema>;

/**
 * How the engine turns a `graph_id` into something runnable and introspectable. Deliberately
 * minimal — `@skein-js/config`'s `GraphRegistry` already satisfies it.
 */
export interface GraphResolver {
  /** Declared graph ids, used to auto-register one assistant per graph at startup. */
  readonly ids: string[];
  /** Load (and cache) the resolved graph for an id — a compiled graph or a per-config factory. */
  load(graphId: string): Promise<ResolvedGraph>;
  /** The graph's JSON schemas (input/output/state/config), for assistant introspection. */
  schemas(graphId: string): Promise<GraphSchemas>;
}

/** A source of the current time; injected so tests are deterministic. */
export type Clock = () => Date;

/** A minimal structured logger. Defaults to a no-op so nothing is required. */
export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Everything the engine, services, and handlers need — all injected, no globals. */
export interface ProtocolDeps {
  /** Protocol resource rows (assistants, threads, runs, store items). */
  store: SkeinStore;
  /** Resolves graph ids to runnable graphs and their schemas. */
  graphs: GraphResolver;
  /** Hands background runs to a worker. */
  queue: RunQueue;
  /** Fans run frames out to streaming clients (replay + live-tail). */
  bus: RunEventBus;
  /** LangGraph checkpointer — owns graph state, history, and interrupt/resume. */
  checkpointer: BaseCheckpointSaver;
  /** Time source; defaults to `() => new Date()`. */
  clock?: Clock;
  /** Structured logger; defaults to a no-op. */
  logger?: Logger;
  /** Optional per-run wall-clock timeout in ms. When set, a run exceeding it becomes `"timeout"`. */
  runTimeoutMs?: number;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Fill in the optional deps (`clock`, `logger`) so the rest of the code can rely on them. */
export interface ResolvedDeps extends ProtocolDeps {
  clock: Clock;
  logger: Logger;
}

export function resolveDeps(deps: ProtocolDeps): ResolvedDeps {
  return {
    ...deps,
    clock: deps.clock ?? (() => new Date()),
    logger: deps.logger ?? noopLogger,
  };
}
