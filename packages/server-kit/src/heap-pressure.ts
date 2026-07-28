// An ongoing watch on how close this process is to its heap ceiling.
//
// Bounding the leaks is not the same as knowing when a deployment is near its
// limit. Without this, the first signal an operator gets is an OOM kill — which on Cloud Run or
// Kubernetes looks like an unexplained restart, not like a memory problem. The boot-time check
// (`heap-headroom.ts`) catches a *mis-sized* container before any traffic; this catches a container that
// is sized correctly and is filling up anyway.
//
// Heap only, deliberately: `used_heap_size` excludes external memory, so a process killed for RSS —
// large Buffers, many sockets — never trips this. That is the right scope (skein's own retention is JS
// objects: buffered frames, mirrored graph state) but it is a real gap rather than an implied one, and
// docs/deploy.md says so.
//
// Two design choices carry most of the value:
//
// - **It warns on a crossing, not on a sample.** A monitor that logs every 30s during sustained pressure
//   is noise, gets filtered, and then nobody sees the one that mattered either. A latch plus a
//   re-arm band below it means one line per episode.
// - **The payload is the triage, not the number.** "Heap at 91%" tells an operator nothing they can act
//   on. The same line with in-flight runs and buffered frames next to it distinguishes *too many
//   concurrent runs* from *one slow client buffering* from *a genuine leak* — which is exactly the
//   triage table in docs/deploy.md.

import { getHeapStatistics } from "node:v8";

import type { Logger } from "@skein-js/agent-protocol";
import { SkeinConfigError } from "@skein-js/config/errors";

import { positiveIntegerFromEnv } from "./env-numbers.js";

/** Percent of the heap limit at which to warn. */
export const DEFAULT_HEAP_WARN_PERCENT = 85;

/**
 * How far below the warn threshold usage must fall before another warning can fire.
 *
 * Hysteresis, not a fixed floor: a process hovering at exactly the threshold would otherwise warn, drop a
 * megabyte, warn again, and produce the per-sample noise the latch exists to prevent. Derived from the
 * threshold rather than hardcoded because the threshold is operator-settable — a fixed 70% band with
 * `SKEIN_HEAP_WARN_PERCENT=60` would re-arm on the very samples that trip the warning, turning the latch
 * into exactly the flood it exists to prevent.
 *
 * Wider than the GC sawtooth: measured in `node:22-slim`, a busy process swings ~12–15 points between
 * collections, so a narrower band would warn once per cycle on a healthy instance.
 */
export const HEAP_REARM_MARGIN_PERCENT = 15;

/** The default re-arm point, for docs and tests: 85% warn − 15 margin. */
export const HEAP_REARM_PERCENT = DEFAULT_HEAP_WARN_PERCENT - HEAP_REARM_MARGIN_PERCENT;

/** How often to sample. Long enough to cost nothing, short enough to catch an episode. */
export const DEFAULT_HEAP_SAMPLE_MS = 30_000;

/** Extra context gathered at warn time — whatever the host can cheaply answer. */
export interface HeapPressureContext {
  /** Runs executing on this instance right now. */
  inFlightRuns?: number;
  /** Frames the in-memory event bus is holding, when that bus is in use. */
  bufferedFrames?: number;
}

/** Whatever the injected scheduler returns; only ever passed back to the injected clearer. */
export type IntervalHandle = { unref?: () => void };

export interface HeapPressureMonitorOptions {
  /** Where the warning goes. No logger → the monitor does nothing at all. */
  logger?: Logger;
  /** Percent of the heap limit at which to warn. `0` disables the monitor. */
  warnPercent?: number;
  /** Sampling interval in ms. */
  sampleMs?: number;
  /** Called at warn time only, so gathering context costs nothing on a healthy process. */
  context?: () => HeapPressureContext;
  /** Injected for tests. */
  heapStatistics?: () => { heap_size_limit: number; used_heap_size: number };
  /** Injected for tests. */
  rss?: () => number;
  /**
   * Injected for tests. Typed loosely on purpose: the handle only ever travels from here to
   * `clearInterval` below, so a real `Timeout` and a fake `{ unref }` both fit.
   */
  setInterval?: (callback: () => void, ms: number) => IntervalHandle;
  clearInterval?: (handle: IntervalHandle) => void;
}

export interface HeapPressureMonitor {
  /** Stop sampling. Idempotent. */
  stop(): void;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1048576)}MB`;
}

/**
 * Start watching heap usage. Returns a handle to stop it; call that where the run worker is stopped.
 *
 * The interval is `unref`'d, so it can never hold the event loop open through shutdown — an embedded
 * host with no force-exit timer of its own would otherwise experience a clean shutdown as a hang.
 *
 * Off is a supported configuration: no logger, or `warnPercent: 0`, and nothing is scheduled.
 */
export function startHeapPressureMonitor(
  options: HeapPressureMonitorOptions = {},
): HeapPressureMonitor {
  const {
    logger,
    warnPercent = DEFAULT_HEAP_WARN_PERCENT,
    sampleMs = DEFAULT_HEAP_SAMPLE_MS,
    context,
    heapStatistics = getHeapStatistics,
    rss = () => process.memoryUsage().rss,
    setInterval: schedule = (callback, ms) => setInterval(callback, ms),
    clearInterval: unschedule = (handle) => clearInterval(handle as NodeJS.Timeout),
  } = options;

  if (!logger || warnPercent <= 0 || sampleMs <= 0) return { stop: () => {} };

  // At a threshold below the margin this floors at 0 and the monitor latches after its first warning
  // for the life of the process. That is the safe direction — under-reporting rather than flooding — and
  // such a threshold is already saying "tell me once".
  const rearmPercent = Math.max(0, warnPercent - HEAP_REARM_MARGIN_PERCENT);

  // True once warned, until usage falls back under the re-arm band. This latch is the whole difference
  // between one line per episode and one line per sample.
  let warned = false;

  const sample = (): void => {
    const { heap_size_limit: limit, used_heap_size: used } = heapStatistics();
    if (limit <= 0) return;
    const percent = (used / limit) * 100;

    if (warned) {
      if (percent < rearmPercent) warned = false;
      return;
    }
    if (percent < warnPercent) return;

    warned = true;
    const extra = context?.() ?? {};
    // Named parts rather than a bare percentage: this line is read once, in an incident, by someone
    // deciding whether to scale out, lower concurrency, or go looking for a leak.
    const details = [
      `heap ${megabytes(used)}/${megabytes(limit)} (${Math.round(percent)}%)`,
      `rss ${megabytes(rss())}`,
      extra.inFlightRuns !== undefined ? `runs in flight ${extra.inFlightRuns}` : undefined,
      extra.bufferedFrames !== undefined ? `buffered frames ${extra.bufferedFrames}` : undefined,
    ].filter(Boolean);
    logger.warn?.(
      `skein: heap pressure — ${details.join(", ")}. ` +
        `Many runs in flight suggests lowering SKEIN_RUN_CONCURRENCY; a large buffered-frame count ` +
        `suggests a slow SSE consumer (see SKEIN_MEMORY_BUS_MAX_FRAMES_PER_RUN); neither suggests a ` +
        `leak. Next warning only after usage drops below ${rearmPercent}%.`,
    );
  };

  const handle = schedule(sample, sampleMs);
  // Never hold the process open for a diagnostic.
  handle.unref?.();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unschedule(handle);
    },
  };
}

/**
 * Resolve the monitor's tuning from the environment, following the same rule as the other knobs:
 * explicit wins, but the environment is read *and validated* either way, so a typo fails at boot
 * rather than sitting unnoticed in a deployment.
 *
 * `SKEIN_HEAP_WARN_PERCENT` accepts `0` to disable, which is why it cannot use
 * `positiveIntegerFromEnv`.
 */
export function resolveHeapPressureOptions(
  explicit: { warnPercent?: number; sampleMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): { warnPercent: number; sampleMs: number } {
  const warnPercent = explicit.warnPercent ?? percentFromEnv(env["SKEIN_HEAP_WARN_PERCENT"]);
  const sampleMs =
    explicit.sampleMs ??
    positiveIntegerFromEnv(["SKEIN_HEAP_SAMPLE_MS"], env) ??
    DEFAULT_HEAP_SAMPLE_MS;
  return { warnPercent: warnPercent ?? DEFAULT_HEAP_WARN_PERCENT, sampleMs };
}

/** A 0–100 percentage, where `0` means off. Blank counts as unset. */
function percentFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new SkeinConfigError(
      `SKEIN_HEAP_WARN_PERCENT must be an integer between 0 and 100 (got "${raw}").`,
    );
  }
  return value;
}
