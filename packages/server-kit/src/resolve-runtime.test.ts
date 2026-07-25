// The seam that turns adapter options + environment into the background worker's settings. These
// tests assert the resolved concurrency actually *reaches the queue driver* — not merely that the
// option type-checks. `resolveProtocolRuntime` used to call `createProtocolRuntime(deps)` with no
// second argument, which type-checked fine while pinning every adapter at the driver default.

import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { DEFAULT_RUN_CONCURRENCY } from "@skein-js/agent-protocol";
import type {
  QueuedRun,
  RunConsumer,
  RunConsumerOptions,
  RunProcessor,
  RunQueue,
} from "@skein-js/core";
import { MemoryRunQueue } from "@skein-js/storage-memory";
import { afterEach, describe, expect, it, vi } from "vitest";

import { embedInMemoryGraphs } from "./in-memory-deps.js";
import { resolveProtocolRuntime } from "./resolve-runtime.js";

/** A minimal, real compiled graph — enough to be a valid `ResolvedGraph` map value. */
function buildGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({ messages: [] }))
    .addEdge("__start__", "noop")
    .addEdge("noop", "__end__")
    .compile();
}

/** Wraps the real memory queue, capturing the options the worker hands to `consume()`. */
class RecordingRunQueue implements RunQueue {
  readonly #inner = new MemoryRunQueue();
  consumedWith?: RunConsumerOptions;

  async enqueue(run: QueuedRun): Promise<void> {
    await this.#inner.enqueue(run);
  }

  consume(process: RunProcessor, options: RunConsumerOptions = {}): RunConsumer {
    this.consumedWith = options;
    return this.#inner.consume(process, options);
  }
}

/** Resolve a runtime over a recording queue, then shut the worker down so no loop outlives the test. */
async function consumeOptionsFor(worker?: {
  maxConcurrency?: number;
}): Promise<RunConsumerOptions | undefined> {
  const queue = new RecordingRunQueue();
  const deps = embedInMemoryGraphs({ echo: buildGraph() }, { queue });
  const { runtime } = await resolveProtocolRuntime({ deps, ...(worker ? { worker } : {}) });
  try {
    return queue.consumedWith;
  } finally {
    await runtime.worker.stop();
  }
}

describe("resolveProtocolRuntime — worker concurrency", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts the worker at the default concurrency", async () => {
    expect(await consumeOptionsFor()).toEqual({ concurrency: DEFAULT_RUN_CONCURRENCY });
  });

  it("forwards an explicit maxConcurrency all the way to the queue", async () => {
    expect(await consumeOptionsFor({ maxConcurrency: 3 })).toEqual({ concurrency: 3 });
  });

  it("falls back to SKEIN_RUN_CONCURRENCY when no worker option is given", async () => {
    vi.stubEnv("SKEIN_RUN_CONCURRENCY", "5");
    expect(await consumeOptionsFor()).toEqual({ concurrency: 5 });
  });

  it("accepts the LangGraph-compatible N_JOBS_PER_WORKER", async () => {
    vi.stubEnv("N_JOBS_PER_WORKER", "7");
    expect(await consumeOptionsFor()).toEqual({ concurrency: 7 });
  });

  it("lets an explicit option win over the environment", async () => {
    vi.stubEnv("SKEIN_RUN_CONCURRENCY", "5");
    expect(await consumeOptionsFor({ maxConcurrency: 2 })).toEqual({ concurrency: 2 });
  });
});
