// The run queue + pub/sub seam. Background runs are enqueued; a worker pulls and executes
// them. While a run executes it publishes normalized frames, and any number of clients (even
// on another instance, via Redis) subscribe to replay + live-tail them. The in-memory driver
// implements both for `skein dev`; `@skein-js/redis` implements the cross-instance version.
// Interfaces only here — core defines the contract, drivers provide the behavior.

import type { StreamMode } from "../wire/wire.js";

/**
 * A normalized stream frame produced during a run. Adapters map these onto SSE
 * (`id:`/`event:`/`data:`); `seq` is monotonic per run so a reconnecting client can replay
 * from a `Last-Event-ID` (see docs/streaming.md).
 */
export interface RunFrame {
  /** Monotonic sequence within the run, starting at 1. */
  seq: number;
  /** Frame kind: a LangGraph stream mode, or `"error"` for a failed run. */
  event: StreamMode | "error";
  /** Serializable payload for this frame. */
  data: unknown;
}

/** Identifies a run to execute; the worker resolves the rest through the {@link SkeinStore}. */
export interface QueuedRun {
  run_id: string;
  thread_id: string;
}

/** Durable-ish FIFO of background runs awaiting a worker. */
export interface RunQueue {
  enqueue(run: QueuedRun): Promise<void>;
  /** Pull the next run, or `null` if the queue is empty. */
  dequeue(): Promise<QueuedRun | null>;
}

/** Fan-out of {@link RunFrame}s from the executing worker to subscribed clients. */
export interface RunEventBus {
  /** Publish the next frame for a run. */
  publish(runId: string, frame: RunFrame): Promise<void>;
  /** Signal that a run produced its last frame; subscribers' iterators complete. */
  close(runId: string): Promise<void>;
  /**
   * Subscribe to a run's frames. Frames with `seq > afterSeq` are delivered (past ones
   * replayed, future ones live-tailed); the iterator completes once the run is closed.
   */
  subscribe(runId: string, afterSeq?: number): AsyncIterable<RunFrame>;
}
