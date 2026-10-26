import type { QueuedRun, RunConsumer } from "@skein-js/core";

/** Pending entries stay in the queue; only an available thread occupies execution capacity. */
export function consumePartitionedMemoryRuns(
  items: QueuedRun[],
  waiters: Array<() => void>,
  active: Set<string>,
  claimedThreads: Set<string>,
  tryProcess: (run: QueuedRun) => Promise<boolean>,
  concurrency: number,
): RunConsumer {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error("Queue concurrency must be a positive integer.");
  let consuming = true;
  const running = new Set<Promise<void>>();
  const deferred = new Map<string, ReturnType<typeof setTimeout>>();
  const wake = (): void => {
    for (const notify of waiters.splice(0)) notify();
  };
  const releaseThread = (threadId: string): void => {
    claimedThreads.delete(threadId);
    deferred.delete(threadId);
    wake();
  };
  const loop = (async () => {
    while (consuming) {
      if (running.size >= concurrency) {
        await Promise.race(running);
        continue;
      }
      const index = items.findIndex((item) => !claimedThreads.has(item.thread_id));
      if (index < 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
        continue;
      }
      const run = items.splice(index, 1)[0]!;
      active.add(run.run_id);
      claimedThreads.add(run.thread_id);
      let busy = false;
      const task = Promise.resolve()
        .then(() => tryProcess(run))
        .then((handled) => {
          if (handled === false) {
            busy = true;
            items.unshift(run); // Head of this partition, ahead of every later eligible same-thread run.
          }
        })
        .catch(() => undefined)
        .finally(() => {
          active.delete(run.run_id);
          running.delete(task);
          if (busy && consuming) {
            const timer = setTimeout(() => releaseThread(run.thread_id), 50);
            timer.unref();
            deferred.set(run.thread_id, timer);
          } else releaseThread(run.thread_id);
          wake();
        });
      running.add(task);
    }
  })();
  return {
    async close(force = false) {
      consuming = false;
      for (const [threadId, timer] of deferred) {
        clearTimeout(timer);
        releaseThread(threadId);
      }
      wake();
      if (!force) {
        await loop;
        await Promise.all(running);
      }
    },
  };
}
