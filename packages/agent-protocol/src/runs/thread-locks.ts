// A per-key async mutex, used for two things: guarding the run-create decision, and serializing run
// *execution* per thread.
//
// In-process only, which is the whole reason the two cross-instance seams exist beside it — the create
// guard is now decided by `RunRepo.createIfThreadIdle` (an atomic check-and-insert in the driver), and
// execution can be serialized across instances by a `ThreadExecutionGate`. This remains the default and
// is complete for a single instance.

import type { ThreadExecutionGate, ThreadExecutionLease } from "@skein-js/core";

export class ThreadLocks {
  readonly #tails = new Map<string, Promise<unknown>>();

  /** Run `task` after any in-flight task for `key` has settled, serializing access per key. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    // Chain after the previous holder regardless of how it settled.
    const result = previous.then(task, task);
    // The stored tail swallows outcomes so one task's rejection can't reject the next waiter.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    try {
      return await result;
    } finally {
      // Drop the entry once this task is the last in line, so the map doesn't grow unbounded.
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}

/**
 * Run `task` holding exclusive execution rights to `threadId`.
 *
 * With a {@link ThreadExecutionGate} configured the claim is the gate's, so it holds across instances;
 * without one it is `locks`, which holds within this process. Both are released in a `finally`, so a
 * task that throws never leaves the thread claimed.
 *
 * The gate is layered *on top of* the local mutex rather than replacing it: acquiring a cross-instance
 * claim is a round trip, and letting this process' own waiters queue locally first means a burst of
 * `enqueue` runs on one thread costs one acquisition rather than one per run.
 */
export async function withThreadExecution<T>(
  locks: ThreadLocks,
  gate: ThreadExecutionGate | undefined,
  threadId: string,
  task: () => Promise<T>,
): Promise<T> {
  return locks.run(threadId, async () => {
    if (!gate) return task();
    let lease: ThreadExecutionLease;
    try {
      lease = await gate.acquire(threadId);
    } catch (error) {
      // Deliberately fatal to this run: proceeding without the claim is the unsafe direction — it would
      // let two instances write one thread's checkpoints, which is what the gate exists to prevent.
      throw new Error(`could not claim thread "${threadId}" for execution`, { cause: error });
    }
    try {
      return await task();
    } finally {
      await lease.release();
    }
  });
}
