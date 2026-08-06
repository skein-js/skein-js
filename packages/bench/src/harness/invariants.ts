// The pass/fail half of the benchmark: the bounds that must hold, checked as *mechanisms* rather than
// as timings.
//
// The benchmark's numbers are not gateable. Runner co-tenancy moves throughput and p99 by tens of
// percent, so a threshold on them is either so loose it catches nothing or so tight it fails on a busy
// machine — which is why `docs/testing.md` forbids asserting on memory in Vitest and why the runtime
// matrices in CI assert conformance rather than speed. What *is* gateable is whether a bound still
// bounds: those are integer facts about structures the harness already probes, and they hold on a
// loaded runner exactly as they do on an idle laptop.
//
// Each invariant below is the standing proof of a shipped phase. If one fails, the phase it belongs to
// has regressed, and the message says which.

import {
  DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN,
  DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS,
} from "@skein-js/storage-memory";

import type { Scenario } from "../scenarios/scenario.js";

import type { ScenarioResult } from "./run-scenario.js";

/**
 * Ceiling on what the server may hold per stream, in bytes.
 *
 * Derived from the failure it exists to catch, not tuned to the current number. Before P1 the whole
 * undelivered stream sat in the server's write buffer — measured at ~1.26 MB per connection on the
 * slow-client scenario. After it, the buffer is the socket's own high-water mark, measured at ~67 KB.
 * 256 KB sits an order of magnitude clear of the regression and ~4x clear of the healthy value, so it
 * separates "bounded per socket" from "the whole stream" without tracking either.
 */
const MAX_SSE_BUFFERED_BYTES_PER_STREAM = 256 * 1024;

/** One failed bound, with enough context to name the phase that regressed. */
export interface InvariantViolation {
  scenario: string;
  invariant: string;
  detail: string;
}

/**
 * A probe reading, or `undefined` when the driver does not measure it.
 *
 * Drivers omit probes they cannot measure rather than reporting a placeholder zero (see
 * `BenchServer.probes`), so a missing key must *skip* its invariant. Treating absent as `0` would pass
 * every bound trivially on any driver without that probe — a green gate proving nothing, which is worse
 * than no gate.
 */
function probe(result: ScenarioResult, name: string): number | undefined {
  return Object.hasOwn(result.memory.probePeaks, name) ? result.memory.probePeaks[name] : undefined;
}

/**
 * Check every bound that applies to `result`.
 *
 * Returns the violations rather than throwing, so one scenario's regression does not hide the rest and
 * the report still prints in full.
 */
export function checkInvariants(scenario: Scenario, result: ScenarioResult): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  const fail = (invariant: string, detail: string): void => {
    violations.push({ scenario: result.scenario, invariant, detail });
  };

  // P1 — SSE backpressure. The server writes into the socket and waits for drain, so an undelivered
  // backlog stays in the client's and the kernel's buffers, not on the server's heap.
  const bufferedBytes = probe(result, "sseBufferedBytes");
  if (bufferedBytes !== undefined) {
    const perStream = bufferedBytes / result.streams;
    if (perStream > MAX_SSE_BUFFERED_BYTES_PER_STREAM) {
      fail(
        "P1 sse-backpressure",
        `${Math.round(perStream / 1024)} KB buffered per stream ` +
          `(${result.streams} streams, ${Math.round(bufferedBytes / 1024)} KB total); ` +
          `bound is ${MAX_SSE_BUFFERED_BYTES_PER_STREAM / 1024} KB. A whole undelivered stream is ` +
          `being held server-side — the write path is no longer honouring backpressure.`,
      );
    }
  }

  // P3 — bus retention. Finished runs stay replayable for a late join, but only the most recent N: a
  // channel per run held forever was the original leak.
  const trackedChannels = probe(result, "busTrackedChannels");
  if (trackedChannels !== undefined && trackedChannels > DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS) {
    fail(
      "P3 bus-retention",
      `${trackedChannels} channels tracked against a ${DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS}-run ` +
        `retention cap (${result.streams} streams ran). Finished runs are not being evicted.`,
    );
  }

  // P3 — per-run frame cap. `long-run` is the scenario that reaches it; the others stay far below, so
  // this only ever binds where eviction is actually exercised.
  const bufferedFrames = probe(result, "busBufferedFrames");
  if (bufferedFrames !== undefined && trackedChannels !== undefined) {
    const cap = DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN * Math.max(trackedChannels, 1);
    if (bufferedFrames > cap) {
      fail(
        "P3 bus-frame-cap",
        `${bufferedFrames} frames buffered across ${trackedChannels} channels, above the ` +
          `${DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN}-per-run cap (${cap}). A run's frames are not ` +
          `being trimmed.`,
      );
    }
  }

  // Delivery. Backpressure delays frames; it must not discard them. Asserted as "no fewer than the
  // graph produced" rather than an exact count, because the protocol adds its own frames per stream
  // (metadata, terminal) and pinning that total would fail on an unrelated protocol change.
  if (scenario.expectsCompleteDelivery) {
    const produced = scenario.streams * scenario.frames;
    if (result.totalFrames < produced) {
      fail(
        "delivery",
        `${result.totalFrames} frames delivered, ${produced} produced ` +
          `(${scenario.streams} streams x ${scenario.frames}). Frames were dropped, not delayed.`,
      );
    }
  }

  return violations;
}

/** Render violations for a terminal, grouped so a multi-scenario failure reads as a list. */
export function formatViolations(violations: readonly InvariantViolation[]): string {
  return violations
    .map(({ scenario, invariant, detail }) => `  ✗ [${scenario}] ${invariant}: ${detail}`)
    .join("\n");
}
