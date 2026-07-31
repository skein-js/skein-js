// Per-thread execution serialization across instances.
//
// One run at a time per thread is the invariant everything else rests on: LangGraph checkpoints are a
// linear history, so two runs writing one thread interleave their supersteps and corrupt it. In a single
// process an async mutex is enough. Across instances it is not — and this is the seam that fixes it.
//
// Distinct from the *creation* guard (`RunRepo.createIfThreadIdle`), which decides whether a second run
// may be queued at all. This one decides when a queued run may start, which is what
// `multitask_strategy: "enqueue"` ordering and `interrupt`/`rollback` waiting for the displaced run both
// depend on.

/**
 * A held claim on a thread. Released exactly once, in the `finally` of the work it guards.
 *
 * There is no renewal method, deliberately: an implementation that needs a keep-alive should own it
 * internally rather than make every caller remember to heartbeat around a graph run it does not control
 * the duration of.
 */
export interface ThreadExecutionLease {
  release(): Promise<void>;
}

/**
 * Grants the exclusive right to execute on a thread.
 *
 * Optional on `ProtocolDeps`. Absent means the in-process mutex the engine already uses — correct for a
 * single instance, and what skein did before. `@skein-js/storage-postgres` provides a cross-instance
 * implementation.
 *
 * **A run holds its lease for its whole execution**, which can be minutes. That rules out a
 * short-TTL lease with no renewal: expiring one mid-run hands the thread to a second executor while the
 * first is still writing, which is precisely the corruption the gate prevents. An implementation must
 * either hold the claim for as long as the connection lives (a Postgres session lock) or renew it
 * itself.
 */
export interface ThreadExecutionGate {
  /**
   * Wait until no other executor holds `threadId`, then claim it.
   *
   * Must be FIFO-ish enough not to starve a waiter, and must not resolve two callers at once for the
   * same thread. Rejecting is allowed (an unreachable backend); the engine treats a rejection as fatal
   * to that run rather than proceeding unguarded, because proceeding is the unsafe direction.
   */
  acquire(threadId: string): Promise<ThreadExecutionLease>;
}
