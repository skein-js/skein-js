// The telemetry contract: how a run reports itself to a tracing or analytics backend. Lives in core
// with the other injectable seams (`AuthEngine`, `SkeinStore`) so both the loader that builds a sink
// and the engine that drives one depend on this interface rather than on each other — and so core
// keeps its zero-dependency property. `@skein-js/langsmith`, `@skein-js/posthog`, and
// `@skein-js/otel` are three implementations; anyone can write a fourth.
//
// "Sink", not "adapter": in skein an *adapter* is an HTTP framework shim (@skein-js/express and
// friends — see docs/building-an-adapter.md), and reusing the word here would name two unrelated
// things the same.
//
// Telemetry is a *third* surface, alongside logs and the wire. The three carry deliberately
// different amounts of detail (docs/errors-and-logging.md):
//
//   the wire  → what is safe to hand a caller  (`RunError`, stack only when `exposeErrorStacks`)
//   the log   → everything, for the operator   (the original `Error`, always)
//   a sink    → everything, for the operator   (server-side, so it is treated exactly like the log)
//
// A sink therefore receives the full `Error` — stack and `cause` chain intact — regardless of
// `exposeErrorStacks`. That flag governs only what leaves the server toward a client.

import type { RunError } from "../errors/run-error.js";
import type { Metadata, RunStatus, StreamMode } from "../wire/wire.js";

/**
 * How a run was started. `background` runs are the ones that waited in the queue first; `invoke` is
 * the non-chat `POST /invoke/:graph_id` surface, which has no thread, no run row, and no assistant.
 */
export type RunTrigger = "wait" | "stream" | "background" | "invoke";

/** Who and what a run is, as a telemetry backend needs to see it. Stable across both run events. */
export interface RunTelemetryContext {
  runId: string;
  threadId: string;
  /**
   * Absent for an `invoke` trigger: that surface addresses a graph directly, with no assistant in
   * between. Always present for a real run.
   */
  assistantId?: string;
  /** The graph behind the assistant — the dimension you group by when comparing agents. */
  graphId: string;
  /** The authenticated caller's `identity`, when an `AuthEngine` is configured. */
  userId?: string;
  trigger: RunTrigger;
  /** The stream modes the caller asked for, normalized. */
  streamModes: StreamMode[];
  /** The run's own metadata, as stored on the run row. */
  metadata?: Metadata;
}

/** A run reached `running` and is about to drive the graph. */
export interface RunStartedEvent {
  type: "run.started";
  context: RunTelemetryContext;
  startedAt: Date;
  /** How long the run sat in the queue before a worker picked it up. Background runs only. */
  queuedMs?: number;
}

/** A run settled. Emitted for every terminal status, including cancellation and interruption. */
export interface RunFinishedEvent {
  type: "run.finished";
  context: RunTelemetryContext;
  status: RunStatus;
  /** Wall-clock time from `running` to settled. */
  durationMs: number;
  /** How many frames the run published on the bus — a cheap proxy for how much the graph produced. */
  frameCount: number;
  endedAt: Date;
  /** Why the run failed, for an `error`/`timeout` status. The same payload the client is given. */
  error?: RunError;
  /**
   * The node(s) the graph was in when it threw, best-effort. Empty when it could not be identified
   * (a failure before the graph started), and names the *parent* node for a failure inside a
   * subgraph — see `describeFailingNodes` in @skein-js/agent-protocol.
   */
  failingNodes?: readonly string[];
  /**
   * The original thrown `Error`, with its stack and `cause` chain — **regardless of
   * `exposeErrorStacks`**, which governs the wire, not this. Present only alongside {@link error},
   * and only when a real throw produced it (a timeout has an {@link error} but nothing was thrown).
   */
  cause?: Error;
}

/** Everything the engine reports about a run's life. */
export type RunTelemetryEvent = RunStartedEvent | RunFinishedEvent;

/**
 * A telemetry backend, injected as `ProtocolDeps.telemetry`. Every method is optional: an analytics
 * backend implements {@link onRunEvent}, a tracing backend implements {@link callbacks} and
 * {@link traceMetadata}, and either may implement both.
 *
 * **Nothing here may throw or block a run.** The engine guards every call and never awaits
 * {@link onRunEvent}, but a sink that does its own I/O inline still slows every run it observes —
 * buffer and flush instead. {@link flush} is called on shutdown precisely so a buffering sink can
 * be the well-behaved default.
 */
export interface TelemetrySink {
  /** Identifies the sink in log lines when one of its methods throws. */
  readonly name: string;
  /**
   * Called at each run lifecycle transition. Fire-and-forget: the engine does not await it, so a
   * promise returned here is not observed. Must not throw (the engine catches, but the event is
   * then lost).
   */
  onRunEvent?(event: RunTelemetryEvent): void;
  /**
   * LangChain callback handlers to attach to this run's graph call, so a tracer's spans nest under
   * the run instead of floating free. Typed `unknown[]` to keep core free of `@langchain/core`;
   * the engine passes them through to LangGraph unchanged.
   */
  callbacks?(context: RunTelemetryContext): unknown[];
  /** Extra metadata to stamp on the graph call — how a backend groups runs (LangSmith threads). */
  traceMetadata?(context: RunTelemetryContext): Record<string, unknown>;
  /** Extra tags to stamp on the graph call. */
  traceTags?(context: RunTelemetryContext): string[];
  /**
   * Drain anything buffered. Called on runtime shutdown — a batching exporter that skips this loses
   * the tail of every process, which is exactly the telemetry you most wanted after a crash.
   */
  flush?(): Promise<void>;
  /** Release the underlying client. Called after {@link flush} on shutdown. */
  shutdown?(): Promise<void>;
}

/** Reports a sink that threw, so the caller can log it. Never itself throws. */
export type TelemetrySinkErrorReporter = (error: unknown, sinkName: string) => void;

/**
 * Run `body`, swallowing anything it throws and handing it to `report`.
 *
 * Catches **rejections as well as throws**. `onRunEvent` is declared to return `void`, but
 * TypeScript's void-return bivariance happily accepts an `async` method there, and that is the
 * natural thing to write for a sink that does I/O. A rejected promise dropped on the floor would be
 * an unhandled rejection — which on Node ≥15 terminates the process, exactly the failure mode this
 * guard exists to prevent.
 */
function guard(
  sinkName: string,
  report: TelemetrySinkErrorReporter | undefined,
  body: () => unknown,
): void {
  const fail = (error: unknown): void => {
    try {
      report?.(error, sinkName);
    } catch {
      // A reporter that throws would defeat the whole point of this guard.
    }
  };
  try {
    const returned = body();
    // Duck-typed rather than `instanceof Promise`, so a thenable from another realm is caught too.
    if (typeof (returned as { then?: unknown } | undefined)?.then === "function") {
      void (returned as Promise<unknown>).then(undefined, fail);
    }
  } catch (error) {
    fail(error);
  }
}

/** Whether any of these sinks actually consumes run lifecycle events. */
export function anySinkWantsRunEvents(sinks: readonly TelemetrySink[]): boolean {
  return sinks.some((sink) => typeof sink?.onRunEvent === "function");
}

/**
 * Fan one sink's worth of calls out to many, isolating each: a sink that throws (or whose `flush`
 * rejects) cannot stop its neighbours from being called, and cannot perturb the run that triggered
 * it. Always returns a sink, so a caller never has to branch on "is telemetry configured" — an
 * empty list yields one that does nothing.
 *
 * `resolveDeps` funnels every configured sink through here, so the isolation holds even for a single
 * sink passed on its own.
 */
export function combineTelemetrySinks(
  sinks: readonly TelemetrySink[],
  report?: TelemetrySinkErrorReporter,
): TelemetrySink {
  const active = sinks.filter((sink): sink is TelemetrySink => sink != null);
  const name =
    active.length === 1 ? (active[0]?.name ?? "none") : `[${active.map((s) => s.name).join(", ")}]`;

  const collect = <T>(
    method: (sink: TelemetrySink) => ((context: RunTelemetryContext) => T[]) | undefined,
    context: RunTelemetryContext,
  ): T[] => {
    const merged: T[] = [];
    for (const sink of active) {
      guard(sink.name, report, () => {
        const produce = method(sink);
        if (produce) merged.push(...produce.call(sink, context));
      });
    }
    return merged;
  };

  // `allSettled`, not `all`: one sink whose flush rejects must not abandon the others' buffered
  // events, and shutdown must not reject because a backend was unreachable.
  const drain = async (method: "flush" | "shutdown"): Promise<void> => {
    await Promise.allSettled(
      active.map(async (sink) => {
        try {
          await sink[method]?.();
        } catch (error) {
          report?.(error, sink.name);
        }
      }),
    );
  };

  return {
    name,
    onRunEvent(event) {
      for (const sink of active) {
        guard(sink.name, report, () => sink.onRunEvent?.(event));
      }
    },
    callbacks: (context) => collect((sink) => sink.callbacks, context),
    traceTags: (context) => collect((sink) => sink.traceTags, context),
    traceMetadata(context) {
      const merged: Record<string, unknown> = {};
      for (const sink of active) {
        guard(sink.name, report, () => Object.assign(merged, sink.traceMetadata?.(context)));
      }
      return merged;
    },
    flush: () => drain("flush"),
    shutdown: () => drain("shutdown"),
  };
}
