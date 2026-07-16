// The injected contract for the whole package. Nothing here is a singleton: the engine, services,
// and handlers are all built from a `ProtocolDeps` the caller supplies, so `@skein-js/agent-protocol`
// stays free of any particular server, storage driver, queue, or CLI. `@skein-js/config`'s
// `GraphRegistry` structurally satisfies `GraphResolver`, but we depend on the minimal interface so
// this package never has to know `@skein-js/config` exists.

import type { BaseCheckpointSaver, CompiledGraph } from "@langchain/langgraph";
import type { AuthEngine, GraphSchema, RunEventBus, RunQueue, SkeinStore } from "@skein-js/core";

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

/**
 * Delivers a run-completion webhook: POST `payload` (as JSON) to `url`. Injected so the transport is
 * swappable and tests can capture deliveries without a network. Should resolve once sent and reject
 * on failure — the engine calls it best-effort (a rejection is logged, never fails the run).
 *
 * Security: `url` is client-supplied, so the dispatcher makes a *server-side* request to a target the
 * caller chose (an SSRF surface) and sends it the run's final `values`. The default dispatcher
 * restricts the scheme to `http(s)` but, since skein is self-hosted and internal webhook targets are a
 * legitimate use, does **not** block private/loopback hosts. Deployments that accept untrusted
 * `webhook` URLs should inject a dispatcher that validates the resolved host against an allowlist.
 */
export type WebhookDispatcher = (url: string, payload: unknown) => Promise<void>;

/** A minimal structured logger. Defaults to a no-op so nothing is required. */
export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** Everything the engine, services, and handlers need — all injected, no globals. */
export interface ProtocolDeps {
  /**
   * Protocol resource rows (assistants, threads, runs, store items). Its `store` repo is also
   * bridged into each graph run as a LangGraph `BaseStore` (see `SkeinBaseStore`), so graph nodes
   * reach long-term cross-thread memory via `getStore()`.
   */
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
  /**
   * When true, the run engine logs per-run activity — start/finish (with status + duration), each
   * tool call and tool result, and interrupts — through {@link logger}. Off by default; `skein dev
   * --verbose` turns it on. Zero cost when off (the engine skips the stream inspection entirely).
   */
  logRunActivity?: boolean;
  /** Optional per-run wall-clock timeout in ms. When set, a run exceeding it becomes `"timeout"`. */
  runTimeoutMs?: number;
  /**
   * Delivers run-completion webhooks (the run's `webhook` field). Defaults to a `globalThis.fetch`
   * POST with a JSON body; inject to customize transport/retries or to capture deliveries in tests.
   */
  webhookDispatcher?: WebhookDispatcher;
  /**
   * Optional auth engine. When set, every request is authenticated (401 on failure) and authorized
   * per resource + action (403 on deny), with ownership filters scoping reads and stamping writes.
   * Absent means no authentication/authorization — every request is allowed (the current behavior).
   */
  auth?: AuthEngine;
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Minimal shape of the global `fetch` we rely on — declared locally so this file needs neither the
// DOM lib nor @types/node's web-globals (the workspace compiles with `lib: ["ES2023"]`). Node 18+
// provides `fetch` at runtime; if a host lacks it, inject a `webhookDispatcher` instead.
type GlobalFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number }>;

/** POST the payload as JSON via the global `fetch`. The default {@link WebhookDispatcher}. */
const fetchWebhookDispatcher: WebhookDispatcher = async (url, payload) => {
  // Only http(s): reject other schemes (`file:`, `data:`, …) up front rather than hand them to fetch.
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    throw new Error(`Webhook URL "${url}" is not a valid absolute URL`);
  }
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error(`Webhook URL scheme "${scheme}" is not allowed (only http/https)`);
  }
  const send = (globalThis as { fetch?: GlobalFetch }).fetch;
  if (!send) {
    throw new Error("global fetch is unavailable; inject a webhookDispatcher to deliver webhooks");
  }
  const response = await send(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Webhook POST to ${url} failed with status ${response.status}`);
  }
};

/** Fill in the optional deps (`clock`, `logger`, `webhookDispatcher`) so the rest can rely on them. */
export interface ResolvedDeps extends ProtocolDeps {
  clock: Clock;
  logger: Logger;
  webhookDispatcher: WebhookDispatcher;
}

export function resolveDeps(deps: ProtocolDeps): ResolvedDeps {
  return {
    ...deps,
    clock: deps.clock ?? (() => new Date()),
    logger: deps.logger ?? noopLogger,
    webhookDispatcher: deps.webhookDispatcher ?? fetchWebhookDispatcher,
  };
}
