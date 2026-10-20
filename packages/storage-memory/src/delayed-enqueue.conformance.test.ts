import type { RunQueue } from "@skein-js/core";
import { runRunQueueConformance } from "@skein-js/test-support";

import { MemoryRunQueue } from "./memory-queue.js";

// Force the subsequent enqueue to arrive after the delayed run has executed. A slow database or
// Redis round trip can cross the deadline too, so the shared suite must allow this valid ordering.
runRunQueueConformance("memory with a stalled subsequent enqueue", (): RunQueue => {
  const queue = new MemoryRunQueue();
  let finishDelayedRun!: () => void;
  const delayedRunFinished = new Promise<void>((resolve) => {
    finishDelayedRun = resolve;
  });

  return {
    enqueue: async (run, options) => {
      if (run.run_id === "now") await delayedRunFinished;
      await queue.enqueue(run, options);
    },
    consume: (processor, options) =>
      queue.consume(async (run) => {
        await processor(run);
        if (run.run_id === "later") finishDelayedRun();
      }, options),
  };
});
