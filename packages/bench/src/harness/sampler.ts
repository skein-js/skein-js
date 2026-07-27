// Periodic memory sampling while a scenario runs, plus the settle step that separates churn from
// retention. Peak RSS tells you how much a workload allocates; RSS after the server has gone idle and
// been fully collected tells you how much it *kept*. The second number is the one this whole work
// stream is about, so it gets a first-class step rather than being inferred from the tail of a graph.

import { getHeapStatistics } from "node:v8";

import { peak } from "./percentiles.js";

/** Extra per-sample readings a driver can contribute (socket buffers, bus depth, …). */
export type SamplerProbe = () => number;

export interface MemorySamplerOptions {
  /** Milliseconds between samples. */
  intervalMs: number;
  /**
   * Named probes sampled alongside memory. A probe that cannot answer yet (a driver without Redis, a
   * bus predating the frame-count accessor) should simply be omitted by its driver rather than
   * returning a sentinel — the report renders a missing series as `n/a`, which reads honestly.
   */
  probes?: Readonly<Record<string, SamplerProbe>>;
}

/** Everything one sampling session observed. */
export interface MemorySamples {
  rssBytes: number[];
  heapUsedBytes: number[];
  /** Probe series, keyed as they were supplied. */
  probes: Record<string, number[]>;
}

/** The peak of each series, plus the retained figures captured by {@link MemorySampler.settle}. */
export interface MemoryReading {
  rssPeakBytes: number;
  heapUsedPeakBytes: number;
  heapLimitBytes: number;
  /** RSS after the workload finished, the process idled, and a full GC ran. Retention, not churn. */
  rssSettledBytes: number;
  heapUsedSettledBytes: number;
  probePeaks: Record<string, number>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Force a full garbage collection when the harness was started with `--expose-gc`, so the settled
 * reading measures what is genuinely reachable rather than what V8 has not gotten round to freeing.
 *
 * Without the flag this is a no-op and the settled numbers become an upper bound instead of a
 * measurement — still directionally useful, which is why it degrades rather than throwing. The
 * `bench` target passes the flag; a hand-run `node dist/main.js` may not.
 */
export function forceGarbageCollection(): boolean {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (!collect) return false;
  // Twice: the first pass can resurrect finalizer-reachable objects that the second then reclaims.
  collect();
  collect();
  return true;
}

/** Samples memory on an interval until stopped. One instance per scenario run. */
export class MemorySampler {
  readonly #intervalMs: number;
  readonly #probes: Readonly<Record<string, SamplerProbe>>;
  readonly #samples: MemorySamples;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: MemorySamplerOptions) {
    this.#intervalMs = options.intervalMs;
    this.#probes = options.probes ?? {};
    this.#samples = {
      rssBytes: [],
      heapUsedBytes: [],
      probes: Object.fromEntries(Object.keys(this.#probes).map((name) => [name, [] as number[]])),
    };
  }

  /** Take one reading immediately, then every `intervalMs`. Idempotent. */
  start(): void {
    if (this.#timer) return;
    this.#sample();
    // `unref` so a sampler someone forgot to stop can never hold the process open past the report.
    this.#timer = setInterval(() => this.#sample(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #sample(): void {
    const { rss, heapUsed } = process.memoryUsage();
    this.#samples.rssBytes.push(rss);
    this.#samples.heapUsedBytes.push(heapUsed);
    for (const [name, probe] of Object.entries(this.#probes)) {
      this.#samples.probes[name]?.push(probe());
    }
  }

  /**
   * Stop sampling, let the process go quiet, collect, and read what is left. `idleMs` has to outlast
   * the server's own post-run work — terminal status writes, bus closes, socket teardown — or the
   * "retained" figure is really just "not finished yet".
   */
  async settle(idleMs: number): Promise<MemoryReading> {
    this.stop();
    await sleep(idleMs);
    forceGarbageCollection();
    // A short second pause lets anything the GC queued for finalization actually go.
    await sleep(250);
    forceGarbageCollection();

    const settled = process.memoryUsage();
    return {
      rssPeakBytes: peak(this.#samples.rssBytes),
      heapUsedPeakBytes: peak(this.#samples.heapUsedBytes),
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      rssSettledBytes: settled.rss,
      heapUsedSettledBytes: settled.heapUsed,
      probePeaks: Object.fromEntries(
        Object.entries(this.#samples.probes).map(([name, series]) => [name, peak(series)]),
      ),
    };
  }
}
