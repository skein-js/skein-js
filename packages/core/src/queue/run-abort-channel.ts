// Cross-instance run cancellation. A cancel, an `interrupt`/`rollback` displacement, or a worker
// shutdown has to reach the process that is *actually executing* the run — and with replicas behind a
// load balancer that is rarely the process that received the request.
//
// The run row already carries the decision (the engine will not overwrite a terminal status), so this
// channel is not what makes a cancel durable. What it carries is the *signal to stop now*: without it,
// a cancelled run keeps burning tokens until the graph finishes on its own, and only then discovers it
// was cancelled.
//
// Deliberately a separate seam from `RunEventBus`, which fans a run's output *out* to readers. This
// carries one control message *in* to the single executor. `@skein-js/redis` implements it over pub/sub
// — exactly what LangGraph Platform uses Redis for.

/**
 * Why a run is being aborted. Mirrors the engine's own `AbortReason`, declared here because it travels
 * between processes: the receiving instance maps it back onto its local cancellation registry, and the
 * terminal status a run settles to depends on which one arrived.
 */
export type RunAbortReason = "cancel" | "timeout" | "interrupt" | "rollback";

/** One inbound abort request. */
export interface RunAbortRequest {
  run_id: string;
  reason: RunAbortReason;
}

/** Handles an abort request that arrived from another instance (or from this one). */
export type RunAbortListener = (request: RunAbortRequest) => void;

/** A live subscription to the abort channel; close it to stop listening. */
export interface RunAbortSubscription {
  close(): Promise<void>;
}

/**
 * Broadcast + receive run-abort requests across instances.
 *
 * Optional on `ProtocolDeps`: with no channel configured, cancellation reaches only runs executing in
 * the receiving process, which is correct and complete for a single instance (the `skein dev` and
 * single-container case) and is what skein did before.
 *
 * **Delivery is best-effort by design.** A dropped message costs promptness, never correctness: the run
 * is already marked terminal in the store, so it will not be resumed, its result is discarded, and the
 * concurrency guard has already been freed. That is why an implementation may use fire-and-forget
 * pub/sub rather than a durable queue.
 */
export interface RunAbortChannel {
  /**
   * Ask whichever instance is executing `run_id` to abort it. Resolves once published, not once
   * handled — there may be no listener at all (the run already finished), which is not an error.
   */
  requestAbort(request: RunAbortRequest): Promise<void>;
  /**
   * Start receiving abort requests. An implementation MAY deliver an instance's own published messages
   * back to it; the engine's registry is idempotent (first reason wins, aborting twice is a no-op), so
   * a loopback delivery is harmless.
   */
  subscribe(listener: RunAbortListener): RunAbortSubscription;
}
