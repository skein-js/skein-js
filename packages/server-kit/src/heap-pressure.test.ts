// Driven by an injected clock and injected heap readings — no real memory, no real timers. Asserting on
// actual heap usage would make these tests depend on whatever the machine running them happens to be
// doing, which is the failure mode `docs/testing.md` calls out for memory work generally.

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HEAP_SAMPLE_MS,
  DEFAULT_HEAP_WARN_PERCENT,
  HEAP_REARM_PERCENT,
  resolveHeapPressureOptions,
  startHeapPressureMonitor,
  type HeapPressureMonitorOptions,
} from "./heap-pressure.js";

const MB = 1048576;
const LIMIT = 1000 * MB;

/** A monitor whose samples are driven by hand, collecting the warnings it emits. */
function monitorOn(usagePercents: number[], options: Partial<HeapPressureMonitorOptions> = {}) {
  const warnings: string[] = [];
  let tick = (): void => {};
  let cleared = 0;
  let index = 0;

  const monitor = startHeapPressureMonitor({
    logger: { warn: (message: string) => warnings.push(message) } as never,
    heapStatistics: () => ({
      heap_size_limit: LIMIT,
      used_heap_size:
        ((usagePercents[Math.min(index, usagePercents.length - 1)] ?? 0) / 100) * LIMIT,
    }),
    rss: () => 512 * MB,
    setInterval: (callback) => {
      tick = callback;
      return { unref: () => {} };
    },
    clearInterval: () => {
      cleared += 1;
    },
    ...options,
  });

  /** Advance one sampling interval, moving to the next usage reading. */
  const step = (): void => {
    tick();
    index += 1;
  };
  return { warnings, step, monitor, clearCount: () => cleared };
}

describe("startHeapPressureMonitor", () => {
  it("warns once when usage crosses the threshold", () => {
    const { warnings, step } = monitorOn([50, 90]);

    step();
    expect(warnings).toHaveLength(0);
    step();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("90%");
  });

  // The point of the latch. A monitor that logs every 30s during sustained pressure is noise that gets
  // filtered out — and then the one that mattered is filtered too.
  it("stays silent while pressure persists", () => {
    const { warnings, step } = monitorOn([90, 91, 95, 99]);

    for (let i = 0; i < 4; i += 1) step();

    expect(warnings).toHaveLength(1);
  });

  it("warns again only after usage falls below the re-arm band", () => {
    // Above, sustained, down to just inside the band (not enough), then properly below, then up again.
    const { warnings, step } = monitorOn([90, 95, 75, 60, 90]);

    step(); // warn
    step(); // still latched
    step(); // 75% — above the re-arm band, so still latched
    expect(warnings).toHaveLength(1);
    step(); // 60% — re-armed
    step(); // 90% again
    expect(warnings).toHaveLength(2);
  });

  it("does not re-arm at exactly the re-arm percent", () => {
    const { warnings, step } = monitorOn([90, HEAP_REARM_PERCENT, 90]);

    step();
    step();
    step();

    expect(warnings).toHaveLength(1);
  });

  it("warns at exactly the threshold", () => {
    const { warnings, step } = monitorOn([DEFAULT_HEAP_WARN_PERCENT]);

    step();

    expect(warnings).toHaveLength(1);
  });

  it("honours a custom threshold", () => {
    const { warnings, step } = monitorOn([60], { warnPercent: 50 });

    step();

    expect(warnings).toHaveLength(1);
  });

  // The triage payload: the number alone is not actionable, the context next to it is.
  it("includes in-flight runs and buffered frames when the host can answer", () => {
    const { warnings, step } = monitorOn([90], {
      context: () => ({ inFlightRuns: 12, bufferedFrames: 480_000 }),
    });

    step();

    expect(warnings[0]).toContain("runs in flight 12");
    expect(warnings[0]).toContain("buffered frames 480000");
    expect(warnings[0]).toContain("rss 512MB");
  });

  // Gathering context can mean walking a bus's channels, so it must not happen on every healthy sample.
  it("gathers context only when it warns", () => {
    const context = vi.fn(() => ({ inFlightRuns: 1 }));
    const { step } = monitorOn([50, 60, 90], { context });

    step();
    step();
    expect(context).not.toHaveBeenCalled();
    step();
    expect(context).toHaveBeenCalledTimes(1);
  });

  it("clears its interval exactly once however many times it is stopped", () => {
    const { monitor, clearCount } = monitorOn([90]);

    monitor.stop();
    monitor.stop();
    monitor.stop();

    // Counted, not just observed: a boolean would pass with the `stopped` latch deleted.
    expect(clearCount()).toBe(1);
  });

  // The band is derived from the threshold rather than fixed. With a fixed 70% floor, an operator asking
  // for earlier notice (`SKEIN_HEAP_WARN_PERCENT=60`) would re-arm on the very samples that trip the
  // warning — a flat, healthy 65% would then log forever, one line every other sample.
  it("does not flood at a threshold below the default re-arm point", () => {
    const { warnings, step } = monitorOn([65, 65, 65, 65, 65, 65], { warnPercent: 60 });

    for (let i = 0; i < 6; i += 1) step();

    expect(warnings).toHaveLength(1);
  });

  it("re-arms relative to a custom threshold", () => {
    // 60% warn → 45% re-arm. 50% is not low enough; 40% is.
    const { warnings, step } = monitorOn([65, 50, 65, 40, 65], { warnPercent: 60 });

    step();
    step();
    step();
    expect(warnings).toHaveLength(1);
    step();
    step();
    expect(warnings).toHaveLength(2);
  });

  it("names the re-arm point it will actually use", () => {
    const { warnings, step } = monitorOn([65], { warnPercent: 60 });

    step();

    expect(warnings[0]).toContain("below 45%");
  });

  describe("off is a supported configuration", () => {
    it("schedules nothing without a logger", () => {
      const schedule = vi.fn();

      startHeapPressureMonitor({ setInterval: schedule });

      expect(schedule).not.toHaveBeenCalled();
    });

    it("schedules nothing at warnPercent 0", () => {
      const schedule = vi.fn();

      startHeapPressureMonitor({
        logger: { warn: () => {} } as never,
        warnPercent: 0,
        setInterval: schedule,
      });

      expect(schedule).not.toHaveBeenCalled();
    });
  });

  // A diagnostic must never be the reason a process won't exit — an embedded host with no force-exit
  // timer would experience that as a hang on shutdown.
  it("unrefs its interval", () => {
    const unref = vi.fn();

    startHeapPressureMonitor({
      logger: { warn: () => {} } as never,
      setInterval: () => ({ unref }),
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("ignores a nonsensical heap limit rather than dividing by zero", () => {
    const { warnings, step } = monitorOn([90], {
      heapStatistics: () => ({ heap_size_limit: 0, used_heap_size: 100 }),
    });

    step();

    expect(warnings).toHaveLength(0);
  });
});

describe("resolveHeapPressureOptions", () => {
  it("defaults when nothing is set", () => {
    expect(resolveHeapPressureOptions({}, {})).toEqual({
      warnPercent: DEFAULT_HEAP_WARN_PERCENT,
      sampleMs: DEFAULT_HEAP_SAMPLE_MS,
    });
  });

  it("reads both knobs from the environment", () => {
    expect(
      resolveHeapPressureOptions(
        {},
        { SKEIN_HEAP_WARN_PERCENT: "90", SKEIN_HEAP_SAMPLE_MS: "5000" },
      ),
    ).toEqual({ warnPercent: 90, sampleMs: 5000 });
  });

  // `0` is the documented off-switch, so it must survive rather than falling back to the default —
  // which is why this can't use the positive-integer helper.
  it("keeps an explicit 0 as off", () => {
    expect(resolveHeapPressureOptions({}, { SKEIN_HEAP_WARN_PERCENT: "0" }).warnPercent).toBe(0);
  });

  it("lets explicit values win, and treats blank as unset", () => {
    expect(
      resolveHeapPressureOptions({ warnPercent: 50 }, { SKEIN_HEAP_WARN_PERCENT: "90" })
        .warnPercent,
    ).toBe(50);
    expect(resolveHeapPressureOptions({}, { SKEIN_HEAP_WARN_PERCENT: "  " }).warnPercent).toBe(
      DEFAULT_HEAP_WARN_PERCENT,
    );
  });

  it("throws on a percentage outside 0-100 or a malformed value", () => {
    expect(() => resolveHeapPressureOptions({}, { SKEIN_HEAP_WARN_PERCENT: "101" })).toThrow();
    expect(() => resolveHeapPressureOptions({}, { SKEIN_HEAP_WARN_PERCENT: "-1" })).toThrow();
    expect(() => resolveHeapPressureOptions({}, { SKEIN_HEAP_WARN_PERCENT: "high" })).toThrow();
    expect(() => resolveHeapPressureOptions({}, { SKEIN_HEAP_SAMPLE_MS: "0" })).toThrow();
  });
});
