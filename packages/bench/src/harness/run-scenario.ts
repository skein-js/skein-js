// One scenario end to end: boot a real server, drive N real SSE clients against it, sample while they
// stream, then settle and read what is retained.

import type { BenchDriver } from "../drivers/bench-driver.js";
import { createTokenStreamGraph } from "../graphs/token-stream-graph.js";
import type { Scenario } from "../scenarios/scenario.js";

import { peak, percentile } from "./percentiles.js";
import { MemorySampler, type MemoryReading } from "./sampler.js";
import { streamRunSlowly } from "./slow-socket-client.js";
import { createThread, streamRun } from "./sse-client.js";

/** Sampling cadence and the post-run quiet period, in milliseconds. */
const SAMPLE_INTERVAL_MS = 100;
const SETTLE_IDLE_MS = 5000;
/** Ceiling on a single throttled stream, so a wedged scenario fails instead of hanging the suite. */
const SLOW_CLIENT_TIMEOUT_MS = 600_000;

/** Everything one scenario run produced. */
export interface ScenarioResult {
  scenario: string;
  driver: string;
  streams: number;
  bootMs: number;
  timeToFirstFrameMs: number;
  framesPerSecond: number;
  latencyP50Ms: number;
  latencyP99Ms: number;
  totalFrames: number;
  durationMs: number;
  memory: MemoryReading;
  /** Whether the settled figures followed a real forced GC, or are an upper bound without one. */
  gcForced: boolean;
}

export interface RunScenarioOptions {
  scenario: Scenario;
  driver: BenchDriver;
  runConcurrency: number;
}

/**
 * Run `scenario` against `driver` and return its measurements.
 *
 * The server is always stopped, including when a client throws — a leaked Postgres pool or container
 * from a failed scenario would corrupt every measurement that follows it in the same process.
 */
export async function runScenario(options: RunScenarioOptions): Promise<ScenarioResult> {
  const { scenario, driver, runConcurrency } = options;

  const graph = createTokenStreamGraph({
    frames: scenario.frames,
    frameBytes: scenario.frameBytes,
    framesPerSecond: scenario.graphFramesPerSecond,
  });

  const server = await driver.start({ graph, runConcurrency });
  const sampler = new MemorySampler({
    intervalMs: SAMPLE_INTERVAL_MS,
    probes: server.probes,
  });

  try {
    // Threads are created up front so thread setup never overlaps the sampling window — otherwise
    // the first samples measure thread creation rather than streaming.
    const threadIds = await Promise.all(
      Array.from({ length: scenario.streams }, () => createThread(server.baseUrl)),
    );

    const runBody = {
      assistant_id: "agent",
      input: { messages: [{ role: "user", content: "bench" }] },
      stream_mode: ["custom", "values"],
    };

    sampler.start();
    const startedAt = performance.now();

    // A throttled client has to be a raw socket. `fetch` (undici) drains the kernel buffer into its
    // own regardless of how slowly the consumer reads, which moves the backlog client-side and hides
    // exactly the server-side growth this scenario exists to expose. See slow-socket-client.ts.
    const results = await Promise.all(
      scenario.clientFramesPerSecond > 0
        ? threadIds.map((threadId) => {
            const url = new URL(server.baseUrl);
            return streamRunSlowly({
              host: url.hostname,
              port: Number(url.port),
              path: `/threads/${threadId}/runs/stream`,
              body: JSON.stringify(runBody),
              framesPerSecond: scenario.clientFramesPerSecond,
              timeoutMs: SLOW_CLIENT_TIMEOUT_MS,
            });
          })
        : threadIds.map((threadId) =>
            streamRun(server.baseUrl, threadId, runBody, { framesPerSecond: 0 }),
          ),
    );

    const durationMs = performance.now() - startedAt;
    const memory = await sampler.settle(SETTLE_IDLE_MS);

    const totalFrames = results.reduce((sum, result) => sum + result.frames, 0);
    const interFrameMs = results.flatMap((result) => result.interFrameMs);

    return {
      scenario: scenario.name,
      driver: driver.name,
      streams: scenario.streams,
      bootMs: server.bootMs,
      timeToFirstFrameMs: peak(results.map((result) => result.timeToFirstFrameMs)),
      framesPerSecond: durationMs > 0 ? (totalFrames / durationMs) * 1000 : 0,
      latencyP50Ms: percentile(interFrameMs, 0.5),
      latencyP99Ms: percentile(interFrameMs, 0.99),
      totalFrames,
      durationMs,
      memory,
      gcForced: typeof (globalThis as { gc?: unknown }).gc === "function",
    };
  } finally {
    sampler.stop();
    await server.stop();
  }
}
