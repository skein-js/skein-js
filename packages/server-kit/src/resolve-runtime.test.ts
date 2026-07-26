// The seam that turns adapter options + environment into the background worker's settings. These
// tests assert the resolved concurrency actually *reaches the queue driver* — not merely that the
// option type-checks. `resolveProtocolRuntime` used to call `createProtocolRuntime(deps)` with no
// second argument, which type-checked fine while pinning every adapter at the driver default.

import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import {
  createGraphInvokeHandler,
  DEFAULT_RUN_CONCURRENCY,
  type Logger,
} from "@skein-js/agent-protocol";
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
import { resolveProtocolRuntime, resolveRuntimeDeps } from "./resolve-runtime.js";

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

/** A `Logger` that records what it was told, for asserting what actually reached the engine. */
function capturingLogger(): Logger & { entries: { level: string; message: string }[] } {
  const entries: { level: string; message: string }[] = [];
  const record =
    (level: string) =>
    (message: string): void => {
      entries.push({ level, message });
    };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

// The logger the engine ends up with is exactly the one on the `deps` handed to
// `createProtocolRuntime`, so asserting `deps.logger` here is asserting the engine's logger. The last
// test closes the loop behaviorally: before this seam existed, every one of these resolved correctly
// on paper while the engine silently kept its no-op.
describe("resolveRuntimeDeps — logger precedence", () => {
  const graphs = { echo: buildGraph() };

  it("fills the hole with the adapter's framework default", async () => {
    const framework = capturingLogger();
    const { deps, logger } = await resolveRuntimeDeps(
      { deps: embedInMemoryGraphs(graphs) },
      framework,
    );
    expect(deps.logger).toBe(framework);
    expect(logger).toBe(framework);
  });

  it("prefers an injected deps.logger over the framework default", async () => {
    const injected = capturingLogger();
    const framework = capturingLogger();
    const { deps } = await resolveRuntimeDeps(
      { deps: { ...embedInMemoryGraphs(graphs), logger: injected } },
      framework,
    );
    expect(deps.logger).toBe(injected);
  });

  it("lets an explicit option win over the framework default", async () => {
    const explicit = capturingLogger();
    const { deps } = await resolveRuntimeDeps(
      { deps: embedInMemoryGraphs(graphs), logger: explicit },
      capturingLogger(),
    );
    expect(deps.logger).toBe(explicit);
  });

  it("keeps an injected deps.logger even against an explicit option", async () => {
    // The one field that is never overwritten: filling in place is what keeps post-mount
    // configuration live (see resolveRuntimeDeps), and that is only safe if it only ever fills holes.
    const injected = capturingLogger();
    const { deps } = await resolveRuntimeDeps(
      { deps: { ...embedInMemoryGraphs(graphs), logger: injected }, logger: capturingLogger() },
      capturingLogger(),
    );
    expect(deps.logger).toBe(injected);
  });

  it("installs no default when the adapter is told to stay out of it", async () => {
    const { deps, logger } = await resolveRuntimeDeps(
      { deps: embedInMemoryGraphs(graphs), logger: false },
      capturingLogger(),
    );
    expect(deps.logger).toBeUndefined();
    expect(logger).toBeUndefined();
  });

  it("leaves an injected deps.logger standing even when told to stay out of it", async () => {
    const injected = capturingLogger();
    const { deps } = await resolveRuntimeDeps(
      { deps: { ...embedInMemoryGraphs(graphs), logger: injected }, logger: false },
      capturingLogger(),
    );
    expect(deps.logger).toBe(injected);
  });

  it("logs nothing when neither the caller nor the adapter supplies one", async () => {
    const { deps, logger } = await resolveRuntimeDeps({ deps: embedInMemoryGraphs(graphs) });
    expect(deps.logger).toBeUndefined();
    expect(logger).toBeUndefined();
  });

  it("keeps the deps object identity, so post-mount configuration still lands", async () => {
    // `createGraphInvokeHandler` re-reads its deps per request so a host can configure after
    // mounting. Handing back a copy would silently freeze that out.
    const injected = embedInMemoryGraphs(graphs);
    const { deps } = await resolveRuntimeDeps({ deps: injected }, capturingLogger());
    expect(deps).toBe(injected);

    injected.exposeErrorStacks = true;
    expect(deps.exposeErrorStacks).toBe(true);
  });

  it("never overwrites a logger the caller already put on deps", async () => {
    const injected = capturingLogger();
    const deps = { ...embedInMemoryGraphs(graphs), logger: injected };
    await resolveRuntimeDeps({ deps, logger: capturingLogger() }, capturingLogger());
    expect(deps.logger).toBe(injected);
  });

  it("reaches the engine, so a graph that throws is actually reported", async () => {
    const logger = capturingLogger();
    const exploding = new StateGraph(MessagesAnnotation)
      .addNode("boom", () => {
        throw new Error("kaboom");
      })
      .addEdge("__start__", "boom")
      .compile();

    const { deps } = await resolveRuntimeDeps(
      { deps: embedInMemoryGraphs({ boom: exploding }) },
      logger,
    );
    // The streaming surface: once headers are sent a failure can't be an HTTP status, so the engine
    // logs it itself rather than handing it to the transport. That makes it the cheapest proof that
    // `deps.logger` is live — nothing but the engine could have written this line.
    const response = await createGraphInvokeHandler(deps)({
      method: "POST",
      url: "http://localhost/invoke/boom",
      params: { graph_id: "boom" },
      query: {},
      body: {},
      headers: { accept: "text/event-stream" },
    });

    if (response.kind !== "sse") throw new Error(`expected an SSE response, got ${response.kind}`);
    for await (const _event of response.events) {
      // Drain: the graph only runs as the stream is consumed.
    }

    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: "error", message: expect.stringContaining("kaboom") }),
    );
  });
});
