// Per-run cancellation, kept in one small stateful place. Each executing run registers an
// `AbortController`; a cancel or timeout aborts its signal (which LangGraph's `stream`/`invoke`
// honor) and records *why*, so the engine's catch can distinguish a cancel from a timeout from a
// genuine graph error. This registry is per-process — cross-instance cancel is a `@skein-js/redis`
// concern layered on top later.

/** Why a run was aborted. Absent (`null`) means the run failed on its own. */
export type AbortReason = "cancel" | "timeout";

/** Handle handed to the engine for a run: the signal to thread into the graph, and the reason box. */
export interface RunControl {
  signal: AbortSignal;
  /** Mutable so the aborter can record the reason the engine reads after the abort fires. */
  reason: { current: AbortReason | null };
  /** Abort *this* run (e.g. the engine's own timeout); records the reason like an external cancel. */
  abort(reason: AbortReason): void;
}

interface ControlEntry {
  controller: AbortController;
  reason: { current: AbortReason | null };
  abort(reason: AbortReason): void;
}

export class RunControlRegistry {
  readonly #entries = new Map<string, ControlEntry>();

  /** Start tracking a run and return its abort signal + reason box. */
  register(runId: string): RunControl {
    const controller = new AbortController();
    const reason: { current: AbortReason | null } = { current: null };
    const abort = (next: AbortReason): void => {
      // First reason wins; aborting twice is a no-op on the already-aborted controller.
      if (reason.current === null) reason.current = next;
      controller.abort();
    };
    this.#entries.set(runId, { controller, reason, abort });
    return { signal: controller.signal, reason, abort };
  }

  /** Abort a tracked run with a reason. Returns false if the run isn't currently executing. */
  abort(runId: string, reason: AbortReason): boolean {
    const entry = this.#entries.get(runId);
    if (!entry) return false;
    entry.abort(reason);
    return true;
  }

  /** Stop tracking a run once it has settled. */
  clear(runId: string): void {
    this.#entries.delete(runId);
  }

  /** Whether a run is currently being tracked (i.e. executing). */
  isTracking(runId: string): boolean {
    return this.#entries.has(runId);
  }
}
