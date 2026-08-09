// The agent surface skein drives, named structurally rather than by importing a runtime's class.
//
// Why this exists: `ResolvedGraph` was `CompiledGraph<string> | CompiledGraphFactory`, so serving the
// Agent Protocol with anything other than a LangGraph.js graph required `as unknown as` — not because
// skein needed a compiled graph, but because it had no name for the far smaller surface it actually
// calls. A measurement (docs/proposals/standalone-agent-protocol.md, phase 1) drove the whole protocol
// — runs, thread state, history, SSE streaming — from a hand-written object with three methods.
//
// So this type is that measurement written down. `stream` and `getState` are required because every
// run needs them; everything else is optional because the measurement showed a useful server without
// them. LangGraph's own `CompiledGraph` satisfies it by construction, which is what keeps the widening
// additive: no existing `GraphResolver` stops compiling.
//
// Deliberately NOT a plugin seam. There is no capability registry, no `/info` advertisement, and no
// second interface behind it — a runtime is not a seam skein has evidence for, and an optional method
// is the smallest thing that expresses "this agent cannot do that".

import { SkeinHttpError, type Checkpoint, type Interrupt } from "@skein-js/core";

/**
 * A snapshot of one thread's state, as the runtime reports it.
 *
 * Shaped to accept LangGraph's `StateSnapshot` verbatim — hence `createdAt`/`parentConfig` rather than
 * the wire's `created_at`/`parent_checkpoint`. `thread-mirror.ts` is what projects this onto the wire
 * {@link import("@skein-js/core").ThreadState}; every field it reads is here and nothing else is.
 */
export interface AgentStateSnapshot {
  /** Current state values. */
  readonly values: unknown;
  /** Nodes still to execute. Non-empty means the agent paused — skein reports `interrupted`. */
  readonly next: readonly string[];
  /** Where this snapshot came from. Its `configurable` carries the checkpoint coordinates. */
  readonly config?: { configurable?: Record<string, unknown> } | undefined;
  /** Checkpoint metadata, passed through to the wire untouched. */
  readonly metadata?: Record<string, unknown> | undefined;
  /** ISO timestamp. */
  readonly createdAt?: string | undefined;
  /** The parent snapshot's config, if this one has a parent. */
  readonly parentConfig?: { configurable?: Record<string, unknown> } | undefined;
  /** Tasks in this step — the carrier for pending interrupts and per-node failures. */
  readonly tasks: readonly AgentStateTask[];
}

/** One task within a step. Accepts LangGraph's `PregelTaskDescription`. */
export interface AgentStateTask {
  readonly id: string;
  readonly name: string;
  /** A failure, in whatever shape the runtime records it; skein JSON-encodes it for the wire. */
  readonly error?: unknown;
  /** Interrupts this task raised, keyed onto the thread by task id. */
  readonly interrupts: readonly Interrupt[];
  readonly result?: unknown;
}

/**
 * What skein calls on a resolved agent.
 *
 * Two methods are required and the rest are optional, and the split is empirical: phase 1 served
 * `/runs/wait`, `/runs/stream`, `/threads/{id}`, `/threads/{id}/state` and `/threads/{id}/history`
 * with `stream` + `getState` + `getStateHistory` alone.
 *
 * An absent optional method is a *handled* condition, not a crash — see `requireAgentCapability`.
 */
export interface AgentGraph {
  /**
   * REQUIRED. Run the agent, yielding one chunk per step. A `[mode, data]` tuple is unwrapped into
   * that stream mode (`chunkToFrameBody`); anything else is published as an `updates` payload.
   */
  stream(
    input: unknown,
    options?: unknown,
  ): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;

  /**
   * REQUIRED. The thread's authoritative state after a run. skein classifies the terminal status from
   * `next` and mirrors `values` + interrupts onto the thread row.
   */
  getState(config: { configurable?: Record<string, unknown> }): Promise<AgentStateSnapshot>;

  /** `GET`/`POST /threads/{id}/history`. Newest first; `limit` must bound at the source. */
  getStateHistory?(
    config: { configurable?: Record<string, unknown> },
    options?: unknown,
  ): AsyncIterable<AgentStateSnapshot>;

  /** `POST /threads/{id}/state` — fork the thread at a checkpoint. */
  updateState?(
    config: { configurable?: Record<string, unknown> },
    values: unknown,
    asNode?: string,
  ): Promise<{ configurable?: Record<string, unknown> }>;

  /** `POST /threads` carrying `supersteps` — seed state without replaying it. */
  bulkUpdateState?(
    config: { configurable?: Record<string, unknown> },
    supersteps: unknown,
  ): Promise<{ configurable?: Record<string, unknown> }>;

  /** The `events` stream mode. Its payload is the runtime's own contract with its clients. */
  streamEvents?(input: unknown, options?: unknown): AsyncIterable<unknown>;

  /** `POST /invoke/{graph_id}` — the simplified, thread-free surface. */
  invoke?(input: unknown, options?: unknown): Promise<unknown>;

  /** `GET /assistants/{id}/graph`. */
  getGraphAsync?(options?: unknown): Promise<{ toJSON(): unknown }>;

  /** `GET /assistants/{id}/subgraphs`. */
  getSubgraphsAsync?(namespace?: string, recurse?: boolean): AsyncIterable<[string, unknown]>;
}

/** Called with the run's `configurable` to build an agent per run. */
export type AgentGraphFactory = (config: {
  configurable?: Record<string, unknown>;
}) => AgentGraph | Promise<AgentGraph>;

/** The optional methods, for the error a missing one produces. */
export type AgentGraphCapability = Exclude<
  {
    [K in keyof AgentGraph]-?: undefined extends AgentGraph[K] ? K : never;
  }[keyof AgentGraph],
  undefined
>;

/** A checkpoint pointer read back out of a runtime's `configurable`. */
export type AgentCheckpointRef = Pick<Checkpoint, "thread_id" | "checkpoint_ns" | "checkpoint_id">;

/**
 * Narrow an agent to one that implements `capability`, or throw a handled 422.
 *
 * Before this existed, calling an optional method on an agent that lacked it was an unhandled
 * `TypeError` and the client got a bare **500** — measured, not theorised: phase 1's runner returned
 * 500 from both `POST /threads/{id}/state` and `GET /assistants/{id}/graph`.
 *
 * 422 rather than 501, deliberately. `@langchain/langgraph-sdk`'s `AsyncCaller` retries any status
 * outside `STATUS_NO_RETRY = [400,401,402,403,404,405,406,407,408,409,422]`, so a 501 would cost the
 * official client five requests and exponential backoff to learn something that will never change on
 * the next attempt. 422 is in that list, and "the request cannot be processed as sent" is honest: the
 * route exists and the body is well-formed, but this agent cannot serve it.
 */
export function requireAgentCapability<K extends AgentGraphCapability>(
  graph: AgentGraph,
  capability: K,
): AgentGraph & Required<Pick<AgentGraph, K>> {
  if (typeof graph[capability] !== "function") {
    throw SkeinHttpError.unprocessable(
      `This agent does not implement "${capability}", which this endpoint requires.`,
      { code: "agent_capability_missing", details: { capability } },
    );
  }
  return graph as AgentGraph & Required<Pick<AgentGraph, K>>;
}
