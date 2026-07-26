// Everything the run engine needs to report a run to a telemetry backend: how to describe a run
// (`toRunTelemetryContext`), how to emit an event without ever perturbing the run (`emitRunEvent`),
// and how to stamp trace identity onto the graph call so a tracer's spans nest under the run
// instead of floating free (`telemetryCallOptions`).
//
// Kept out of the engine for the same reason `run-input.ts` is: the mapping is worth testing on its
// own, and the engine is long enough already.
//
// Everything here is best-effort and must NEVER throw — it runs alongside a live run, and on the
// failure path a second failure would hide the first. Same contract as `run-log.ts`.

import type {
  Metadata,
  Run,
  RunKwargs,
  RunTelemetryContext,
  RunTelemetryEvent,
  RunTrigger,
} from "@skein-js/core";

import type { ResolvedDeps } from "../deps.js";

import { normalizeModes } from "./run-input.js";

/** Trace identity the engine owns, stamped on every run's graph call when telemetry is configured. */
export interface TelemetryCallOptions {
  metadata?: Record<string, unknown>;
  tags?: string[];
  runName?: string;
  callbacks?: unknown[];
}

/**
 * Describe a run for a telemetry backend. `graphId` comes from the assistant, which the engine has
 * already loaded — it is the dimension you group by when comparing agents, and the assistant id
 * alone doesn't give it to you.
 */
export function toRunTelemetryContext(
  run: Run,
  kwargs: RunKwargs,
  graphId: string,
  trigger: RunTrigger,
): RunTelemetryContext {
  const context: RunTelemetryContext = {
    runId: run.run_id,
    threadId: run.thread_id,
    assistantId: run.assistant_id,
    graphId,
    trigger,
    streamModes: normalizeModes(kwargs.stream_mode),
  };
  // `auth_user.identity` is the authenticated principal, present only when an AuthEngine ran.
  const identity = kwargs.auth_user?.identity;
  if (typeof identity === "string" && identity.length > 0) context.userId = identity;
  if (run.metadata != null) context.metadata = run.metadata as Metadata;
  return context;
}

/**
 * Hand an event to the configured sink. Fire-and-forget by design: the sink is not awaited, so a
 * backend doing inline I/O delays nothing, and a throw is logged rather than propagated.
 *
 * `deps.telemetry` is already throw-guarded by `combineTelemetrySinks`; this second guard covers the
 * case where a sink returns a rejecting promise from a method declared `void`.
 */
export function emitRunEvent(deps: ResolvedDeps, event: RunTelemetryEvent): void {
  if (!deps.telemetryEnabled) return;
  try {
    deps.telemetry.onRunEvent?.(event);
  } catch (error) {
    deps.logger.warn(`telemetry: ${event.type} was dropped`, error);
  }
}

/**
 * The trace identity to merge into a run's LangGraph call options. Two things happen here:
 *
 *  1. skein stamps **vendor-neutral** identity (`run_id`, `thread_id`, `assistant_id`, `graph_id`,
 *     `user_id`) plus a `skein` tag and a `runName` of the graph id. Every callback-based tracer —
 *     LangSmith, Langfuse, Braintrust, OpenLLMetry — reads `metadata`, so this alone turns an
 *     anonymous root trace into an attributable one.
 *  2. Each sink adds whatever its own backend needs on top (LangSmith's `session_id`, which is what
 *     groups a thread's runs in its Threads view). Sink keys are applied *first*, so skein's
 *     neutral identity wins a collision — a sink can extend the identity but not rewrite it.
 *
 * Returns an empty object when no sink is configured, so the engine spreads nothing.
 */
export function telemetryCallOptions(
  deps: ResolvedDeps,
  context: RunTelemetryContext,
): TelemetryCallOptions {
  if (!deps.telemetryEnabled) return {};

  const fromSinks = deps.telemetry.traceMetadata?.(context) ?? {};
  const metadata: Record<string, unknown> = {
    ...fromSinks,
    run_id: context.runId,
    thread_id: context.threadId,
    graph_id: context.graphId,
    ...(context.assistantId !== undefined ? { assistant_id: context.assistantId } : {}),
    ...(context.userId !== undefined ? { user_id: context.userId } : {}),
  };

  const options: TelemetryCallOptions = {
    metadata,
    tags: ["skein", `graph:${context.graphId}`, ...(deps.telemetry.traceTags?.(context) ?? [])],
    runName: context.graphId,
  };

  const callbacks = deps.telemetry.callbacks?.(context) ?? [];
  // Only set `callbacks` when a sink actually supplied handlers: an empty array is not inert to
  // LangChain — it replaces the inherited callback manager, which would silence the global tracer
  // that `LANGSMITH_TRACING=true` installs.
  if (callbacks.length > 0) options.callbacks = callbacks;

  return options;
}
