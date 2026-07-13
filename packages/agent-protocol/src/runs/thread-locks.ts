// A per-key async mutex. The concurrency guard ("does this thread already have an active run?")
// reads then writes with an `await` in between, so two concurrent run-creates could both slip
// through. Serializing the guarded section per thread closes that window in a single process;
// `@skein-js/redis` will replace it with an atomic conditional insert for the multi-instance case.

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
