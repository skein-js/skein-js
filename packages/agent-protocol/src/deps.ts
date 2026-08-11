// The injected contract for the whole package. Nothing here is a singleton: the engine, services,
// and handlers are all built from a `ProtocolDeps` the caller supplies, so `@skein-js/agent-protocol`
// stays free of any particular server, storage driver, queue, or CLI. `@skein-js/config`'s
// `GraphRegistry` structurally satisfies `GraphResolver`, but we depend on the minimal interface so
// this package never has to know `@skein-js/config` exists.

import {
  anySinkWantsRunEvents,
  combineTelemetrySinks,
  type AuthEngine,
  type DeliveryQueue,
  type GraphSchema,
  type RunAbortChannel,
  type RunEventBus,
  type RunQueue,
  type SkeinStore,
  type StoreRepo,
  type ThreadExecutionGate,
  type ThreadTtlConfig,
  type TelemetrySink,
} from "@skein-js/core";

import type { WebhookDeliveryConfig } from "./deliveries/delivery-config.js";
import type { AgentGraph, AgentGraphFactory } from "./graphs/agent-graph.js";
import type { ThreadCheckpointer } from "./graphs/thread-checkpointer.js";
import type { IdempotencyConfig } from "./idempotency/idempotency-config.js";
import { withStoreItems } from "./store/with-store-items.js";

/**
 * A factory export: called (optionally with per-run config) to produce a graph.
 *
 * @deprecated Renamed to {@link AgentGraphFactory} — the engine drives an `AgentGraph`, which a
 * LangGraph `CompiledGraph` satisfies structurally. Kept as an alias; slated for removal in a future
 * major.
 */
export type CompiledGraphFactory = AgentGraphFactory;

/**
 * A resolved agent: a compiled graph, a plain {@link AgentGraph}, or a factory producing either.
 *
 * `AgentGraph` is the structural name for what skein actually calls. A LangGraph `CompiledGraph`
 * satisfies it by construction (asserted in `graphs/agent-graph.test.ts`), so this covers the old
 * `CompiledGraph<string> | CompiledGraphFactory` union without naming either — which is what keeps
 * `@langchain/langgraph` out of this package's generated `.d.ts`, not just out of its runtime graph.
 * Every existing `GraphResolver`, including `@skein-js/config`'s `GraphRegistry`, keeps compiling.
 */
export type ResolvedGraph = AgentGraph | AgentGraphFactory;

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
export type WebhookDispatcher = (
  url: string,
  payload: unknown,
  attempt?: DeliveryAttempt,
) => Promise<void>;

/**
 * What this POST is an attempt at — supplied on every delivery the outbox drives.
 *
 * Optional so every existing dispatcher keeps compiling and working; a custom one that ignores it
 * still delivers, it just leaves the receiver without a dedup key.
 */
export interface DeliveryAttempt {
  /** Stable across every retry of this callback. **The receiver's dedup key.** */
  deliveryId: string;
  /** Which attempt this is, counting the inline first one. */
  attempt: number;
  /**
   * The headers to send verbatim, already assembled.
   *
   * A map rather than individual fields, so a dispatcher forwards whatever skein decided to send
   * without having to know the names — which is what lets signing land later without every custom
   * dispatcher needing an update.
   */
  headers: Record<string, string>;
}

/**
 * The headers that carry a delivery's identity to the receiver.
 *
 * `X-Skein-Delivery-Id` is the load-bearing one. Delivery is **at-least-once**: a POST that timed out
 * after the receiver had already processed it is indistinguishable, from here, from one that never
 * arrived — so it is retried, and the receiver sees it twice. Dedup on this id and that is a non-event;
 * ignore it and skein's reliability improvement becomes the receiver's duplicate-processing bug.
 */
export function deliveryHeaders(deliveryId: string, attempt: number): Record<string, string> {
  return {
    "x-skein-delivery-id": deliveryId,
    "x-skein-attempt": String(attempt),
  };
}

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
  /**
   * Replaces **only** {@link store}'s long-term-memory repo — bring-your-own store, from
   * `langgraph.json`'s `store.adapter` or injected directly. Everything else (assistants, threads,
   * runs, crons, idempotency) keeps using {@link store}.
   *
   * A separate field rather than asking callers to compose, because `{ ...postgresStore, store: mine }`
   * is a trap: `maxPageSize` and `durable` are class getters on both bundled drivers, and object spread
   * copies own enumerable properties only, so both silently become `undefined` — invisibly, since both
   * are optional on the interface. `resolveDeps` performs the substitution through `withStoreItems`, so
   * the bounds survive by construction rather than by every caller remembering.
   *
   * Accepts a `StoreRepo`. To use a LangGraph `BaseStore` (`PostgresStore`, `InMemoryStore`, …), wrap
   * it with `fromBaseStore` first.
   */
  storeItems?: StoreRepo;
  /** Resolves graph ids to runnable graphs and their schemas. */
  graphs: GraphResolver;
  /** Hands background runs to a worker. */
  queue: RunQueue;
  /** Fans run frames out to streaming clients (replay + live-tail). */
  bus: RunEventBus;
  /**
   * Carries run-abort requests between instances, so a cancel routed to one replica stops a run
   * executing on another. Absent means single-process cancellation — correct and complete for one
   * instance, and what skein did before. `@skein-js/redis` provides an implementation.
   */
  abortChannel?: RunAbortChannel;
  /**
   * Serializes run *execution* per thread across instances. Absent means the engine's in-process mutex,
   * which is correct for a single instance and is what skein did before.
   * `@skein-js/storage-postgres` provides `createPostgresThreadExecutionGate`.
   */
  threadExecutionGate?: ThreadExecutionGate;
  /**
   * Owns graph state, history, and interrupt/resume.
   *
   * Typed structurally ({@link ThreadCheckpointer}) rather than as LangGraph's `BaseCheckpointSaver`,
   * which is an abstract class no hand-written stand-in can satisfy without a cast. A real
   * `BaseCheckpointSaver` still satisfies it, so this is additive.
   */
  checkpointer: ThreadCheckpointer;
  /**
   * Bridges the long-term-memory repo into whatever store type the agent runtime expects, so nodes
   * reach cross-thread memory the runtime-native way (LangGraph: `getStore()`).
   *
   * A **function**, not an interface, and injected rather than imported: building a LangGraph
   * `BaseStore` means `class SkeinBaseStore extends BaseStore`, a *value* import of
   * `@langchain/langgraph` — which is precisely what would put a graph runtime back into this
   * package's install. `@skein-js/langgraph` supplies one; every on-ramp wires it. Absent means no
   * store is attached, which is correct for a runtime that has no such concept.
   *
   * Called per run with the effective repo, so a `storeItems` override is honoured.
   */
  storeBridge?: (store: StoreRepo) => unknown;
  /**
   * Builds a **throwaway** checkpointer for one `POST /invoke/{graph_id}` call, so a graph that needs
   * one runs while nothing persists.
   *
   * Cannot reuse {@link checkpointer}: that one is durable, and the invoke surface's whole contract is
   * that a call leaves no thread behind. Injected for the same reason as {@link storeBridge} — the
   * only in-tree implementation is `new MemorySaver()`, a value import of `@langchain/langgraph`.
   * Absent means no checkpointer is attached, which is correct for an agent that needs none.
   */
  ephemeralCheckpointer?: () => unknown;
  /**
   * Clones a checkpoint before it is re-put under another thread id (`POST /threads/{id}/copy`,
   * `keep_latest` prune, `rollback`).
   *
   * Injected for the same reason as {@link storeBridge}: LangGraph's `copyCheckpoint` is a *value*
   * import, and it was the last one keeping a graph runtime in this package's install. Absent means
   * the checkpoint is re-put as-is, which is correct whenever `put` does not retain what it is given.
   */
  cloneCheckpoint?: (checkpoint: unknown) => unknown;
  /**
   * skein's own version, reported by `GET /info`. Absent when the host does not know or does not care.
   *
   * Injected rather than read here: a library cannot read its own `package.json` at runtime (bundlers
   * rewrite `import.meta.url` — docs/bundling.md), while an *application* can and does. The `skein`
   * CLI passes its version through; an embedder may pass its own.
   */
  serverVersion?: string;
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
  /**
   * Whether this server serves the crons resource — reported as `flags.crons` by `GET /info`.
   *
   * Defaults to true. Set false when `http.disable_crons` has removed the routes and stopped the
   * scheduler, so the handshake stays honest: Studio feature-detects this flag and would otherwise
   * offer a cron UI whose every call 404s.
   */
  cronsEnabled?: boolean;
  /**
   * Thread expiry policy (`langgraph.json` `checkpointer.ttl`). Present → the runtime starts a thread
   * TTL sweeper; absent → threads live until something deletes them.
   *
   * Carried on the deps rather than passed per-adapter for the same reason `cronsEnabled` is: it is
   * resolved once where the config is read, and every adapter forwards deps without knowing about it.
   */
  threadTtl?: ThreadTtlConfig;
  /**
   * When true, a failed run's stack trace travels **to the client**: the `error` SSE frame and the
   * persisted `Run.error` both carry `stack`. Off by default, because a stack names server file
   * paths, dependency versions, and sometimes argument values that a production caller has no
   * business seeing — LangGraph Platform never puts one on the wire either. `skein dev` turns it on;
   * `skein start` and production leave it off.
   *
   * Server-side logging is unaffected either way: the engine always hands the original `Error` to
   * {@link logger}, so stacks and `cause` chains are in the logs regardless of this flag.
   */
  exposeErrorStacks?: boolean;
  /** Optional per-run wall-clock timeout in ms. When set, a run exceeding it becomes `"timeout"`. */
  runTimeoutMs?: number;
  /**
   * Retention for `Idempotency-Key` records (`langgraph.json` `skein.idempotency`).
   *
   * Tuning only — absent means the defaults, **not** that the header is ignored. Honouring a key is
   * not an opt-in: a caller who sends one has been promised their retry will not start a second run,
   * and a server that quietly ignored it would break exactly the guarantee the header is for.
   *
   * Carried on the deps rather than passed per-adapter for the same reason `threadTtl` is: resolved
   * once where the config is read, and every adapter forwards deps without knowing about it.
   */
  idempotency?: IdempotencyConfig;
  /**
   * Delivers run-completion webhooks (the run's `webhook` field). Defaults to a `globalThis.fetch`
   * POST with a JSON body; inject to customize transport or to capture deliveries in tests.
   *
   * Note this is the transport only. Retries, dead-lettering and replay are the outbox's job now (see
   * {@link webhooks}), because they need a write inside the run's own finalize transaction — a window
   * that closes before any injected dispatcher runs.
   */
  webhookDispatcher?: WebhookDispatcher;
  /**
   * How run-completion callbacks are retried and bounded (`langgraph.json` `skein.webhooks`).
   *
   * Tuning only — absent means the defaults, **not** that callbacks are fire-once. `retries.max_attempts:
   * 1` is how you ask for the pre-outbox behaviour. Whether a delivery is *durable* is a property of
   * the store driver, not of this: a store with a `deliveries` repo records the callback in the run's
   * finalize transaction either way.
   *
   * Carried on the deps rather than passed per-adapter for the same reason {@link idempotency} is:
   * resolved once where the config is read, and every adapter forwards deps without knowing about it.
   */
  webhooks?: WebhookDeliveryConfig;
  /**
   * Where an undelivered run-completion callback waits between attempts.
   *
   * **This is the production path.** With it — `RedisDeliveryQueue` in a Redis deployment — the whole
   * retry schedule is BullMQ's: delayed jobs, exponential backoff with jitter, and re-delivery of a
   * job whose worker was killed mid-POST. Absent, skein falls back to polling the outbox for rows
   * whose `next_attempt_at` has arrived, which is correct but process-local and lost on restart, and
   * is the development path.
   *
   * Note what does *not* depend on this: whether a callback is durable at all. That comes from the
   * store recording it in the run's finalize transaction, so a deployment with a Postgres store and
   * no delivery queue still cannot lose a notification — it just schedules the retries less well.
   */
  deliveryQueue?: DeliveryQueue;
  /**
   * Optional auth engine. When set, every request is authenticated (401 on failure) and authorized
   * per resource + action (403 on deny), with ownership filters scoping reads and stamping writes.
   * Absent means no authentication/authorization — every request is allowed (the current behavior).
   */
  auth?: AuthEngine;
  /**
   * Where runs report themselves — traces (LangSmith, Langfuse) and lifecycle events (PostHog,
   * OpenTelemetry). Absent means no telemetry, which costs nothing: the engine skips building any
   * context. Pass an array to feed several backends at once.
   *
   * A sink is server-side, like {@link logger} — it receives a failure's full `Error`, stack and
   * `cause` chain included, regardless of {@link exposeErrorStacks} (which governs only what reaches
   * a client). Nothing a sink does can fail a run: every call is guarded. See docs/observability.md.
   */
  telemetry?: TelemetrySink | TelemetrySink[];
}

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * True when nothing was injected and {@link resolveDeps} filled in the discarding default. Callers
 * use this to skip *assembling* an expensive log payload, not to skip logging: the failed-run report
 * costs a checkpointer read to name the node that threw, and paying that to hand it to a function
 * that drops it is pure waste on a path that already went wrong.
 */
export function isNoopLogger(logger: Logger): boolean {
  return logger === noopLogger;
}

// Minimal shape of the global `fetch` we rely on — declared locally so this file needs neither the
// DOM lib nor @types/node's web-globals (the workspace compiles with `lib: ["ES2023"]`). Node 18+
// provides `fetch` at runtime; if a host lacks it, inject a `webhookDispatcher` instead.
type GlobalFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignalLike;
  },
) => Promise<{ ok: boolean; status: number }>;

/** Just enough of `AbortSignal` to hand one to `fetch`, for the same reason `GlobalFetch` is local. */
type AbortSignalLike = { readonly aborted: boolean };

/**
 * `AbortSignal.timeout` if the runtime has it. Probed rather than assumed, matching how `fetch` itself
 * is treated here: a host old enough to lack it still delivers webhooks, just without the bound.
 */
function timeoutSignal(ms: number): AbortSignalLike | undefined {
  const ctor = (globalThis as { AbortSignal?: { timeout?: (ms: number) => AbortSignalLike } })
    .AbortSignal;
  return ctor?.timeout?.(ms);
}

/**
 * How long a webhook POST may take before it is aborted.
 *
 * Without one, `fetch` waits as long as the target keeps the socket open — and delivery is awaited
 * before `startRunExecution` resolves, so an unresponsive target used to hold a run (and, before the
 * delivery was hoisted out of the thread lock, every other run on that thread) indefinitely.
 *
 * Five seconds, chosen against the shutdown budget rather than picked round: the CLI arms its
 * force-exit at `DEFAULT_SHUTDOWN_GRACE_MS` (5s) + its own buffer (3s) = 8s after SIGTERM. A timeout
 * longer than that would let the process be killed mid-POST rather than the POST being abandoned
 * cleanly, which is precisely the case this bound exists to make well-defined. Raise it with
 * `SKEIN_WEBHOOK_TIMEOUT_MS` if your receiver is genuinely slower — and raise
 * `SKEIN_SHUTDOWN_GRACE_MS` alongside it, or the two disagree again.
 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * The effective timeout, read at delivery time rather than at module load — an embedded host may set
 * the variable after importing skein, and a value that only ever mattered per-request should not be
 * frozen by import order.
 */
function webhookTimeoutMs(): number {
  const raw = process.env["SKEIN_WEBHOOK_TIMEOUT_MS"]?.trim();
  if (!raw) return DEFAULT_WEBHOOK_TIMEOUT_MS;
  const value = Number(raw);
  // Invalid or non-positive falls back rather than throwing: this runs inside a best-effort delivery
  // whose failure is only logged, so throwing here would replace a working default with silence.
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

/** POST the payload as JSON via the global `fetch`. The default {@link WebhookDispatcher}. */
const fetchWebhookDispatcher: WebhookDispatcher = async (url, payload, attempt) => {
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
  const timeoutMs = webhookTimeoutMs();
  const signal = timeoutSignal(timeoutMs);
  let response: Awaited<ReturnType<GlobalFetch>>;
  try {
    response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...attempt?.headers },
      body: JSON.stringify(payload),
      // `AbortSignal.timeout` rather than a manual controller + `setTimeout`: it needs no clearing, so
      // it cannot keep the event loop alive past a delivery that finished early.
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // A timeout arrives as an `AbortError`/`TimeoutError`, which on its own reads like a client bug
    // rather than an unresponsive receiver.
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`Webhook POST to ${url} timed out after ${timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Webhook POST to ${url} failed with status ${response.status}`);
  }
};

/**
 * Fill in the optional deps (`clock`, `logger`, `webhookDispatcher`, `telemetry`) so the rest can
 * rely on them.
 */
export interface ResolvedDeps extends ProtocolDeps {
  clock: Clock;
  logger: Logger;
  webhookDispatcher: WebhookDispatcher;
  /**
   * Always present — the combined form of {@link ProtocolDeps.telemetry}, a no-op when none was
   * configured, so callers never branch on "is telemetry on". Every method is guarded against
   * throwing. {@link telemetryEnabled} is what tells you whether anything is actually listening.
   */
  telemetry: TelemetrySink;
  /**
   * Whether any sink was configured. The engine checks this before doing telemetry-only work
   * (building a context, reading a metadata map), so an unconfigured server pays nothing.
   */
  telemetryEnabled: boolean;
  /**
   * Whether any sink actually consumes run lifecycle events. Separate from {@link telemetryEnabled}
   * because reporting a *failure* costs a checkpointer read (to name the node that threw) — a
   * network round trip in production. A trace-only sink (LangSmith contributes metadata and no
   * `onRunEvent`) must not pay for a field nothing reads.
   */
  telemetryWantsRunEvents: boolean;
}

export function resolveDeps(deps: ProtocolDeps): ResolvedDeps {
  const logger = deps.logger ?? noopLogger;
  const sinks =
    deps.telemetry === undefined
      ? []
      : Array.isArray(deps.telemetry)
        ? deps.telemetry
        : [deps.telemetry];
  return {
    ...deps,
    // A bring-your-own store repo is folded into `store` here, so every reader downstream — the
    // services, the auth decorator, the `SkeinBaseStore` handed to graph runs — sees one `SkeinStore`
    // and none of them needs to know an adapter is in play. `withStoreItems` carries the prototype
    // getters the spread would otherwise drop.
    store: deps.storeItems ? withStoreItems(deps.store, deps.storeItems) : deps.store,
    clock: deps.clock ?? (() => new Date()),
    logger,
    webhookDispatcher: deps.webhookDispatcher ?? fetchWebhookDispatcher,
    // Even a single sink goes through `combineTelemetrySinks`, so the throw-isolation guard applies
    // uniformly and the engine never has to wonder whether a given sink is trustworthy.
    telemetry: combineTelemetrySinks(sinks, (error, sinkName) => {
      logger.warn(`telemetry sink "${sinkName}" threw; the event was dropped`, error);
    }),
    telemetryEnabled: sinks.length > 0,
    telemetryWantsRunEvents: anySinkWantsRunEvents(sinks),
  };
}
