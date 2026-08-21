// Progress signals: the half of a conversation that is not the answer.
//
// The acknowledgement is early by necessity — Slack retries after three seconds — so progress cannot
// ride the response. Every guarantee here is deliberately the opposite of `deliver`'s.

import { describe, expect, it, vi } from "vitest";

import type { Channel } from "../channel/channel.js";

import { fanOutRunSignals } from "./signals.js";

const framesOf = (count: number) => ({
  async *subscribe() {
    for (let seq = 1; seq <= count; seq += 1) {
      yield { seq, event: "updates", data: {} };
      await Promise.resolve();
    }
  },
});

const channelOf = (overrides: Partial<Channel>): Channel =>
  ({ name: "twilio", verify: vi.fn(), parseEvent: vi.fn(), ...overrides }) as Channel;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("fanOutRunSignals", () => {
  it("signals immediately, before the first frame", async () => {
    // A graph whose first node takes ten seconds would otherwise show nothing for ten seconds, which
    // is exactly the window an indicator exists to cover.
    const onSignal = vi.fn().mockResolvedValue(undefined);
    fanOutRunSignals({
      channel: channelOf({ onSignal, signals: { kinds: ["progress"] } }),
      runId: "run-1",
      target: "whatsapp:+254",
      frames: { async *subscribe() {} },
      logger: { warn: vi.fn() },
    });

    await settle();
    expect(onSignal).toHaveBeenCalledWith({ kind: "progress", runId: "run-1" }, "whatsapp:+254");
  });

  it("does nothing at all for a channel that asked for nothing", async () => {
    // A GitHub channel should cost exactly what an API run costs.
    const onSignal = vi.fn();
    fanOutRunSignals({
      channel: channelOf({ onSignal }),
      runId: "run-1",
      target: "x",
      frames: framesOf(3),
      logger: { warn: vi.fn() },
    });

    await settle();
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("keeps signalling as the run produces frames", async () => {
    const onSignal = vi.fn().mockResolvedValue(undefined);
    fanOutRunSignals({
      channel: channelOf({ onSignal, signals: { kinds: ["progress"] } }),
      runId: "run-1",
      target: "x",
      frames: framesOf(3),
      logger: { warn: vi.fn() },
    });

    await settle();
    // One up front, one per frame.
    expect(onSignal.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("swallows a failing indicator rather than failing the run", async () => {
    // A failed indicator is cosmetic. Surfacing it would turn it into a delivered error.
    const warn = vi.fn();
    fanOutRunSignals({
      channel: channelOf({
        onSignal: vi.fn().mockRejectedValue(new Error("Twilio said no")),
        signals: { kinds: ["progress"] },
      }),
      runId: "run-1",
      target: "x",
      frames: framesOf(2),
      logger: { warn },
    });

    await settle();
    expect(warn).toHaveBeenCalled();
  });

  it("stops when the run settles", async () => {
    const onSignal = vi.fn().mockResolvedValue(undefined);
    fanOutRunSignals({
      channel: channelOf({ onSignal, signals: { kinds: ["progress"] } }),
      runId: "run-1",
      target: "x",
      frames: framesOf(1),
      logger: { warn: vi.fn() },
    });

    await settle();
    const afterSettle = onSignal.mock.calls.length;
    await settle();
    expect(onSignal.mock.calls.length).toBe(afterSettle);
  });

  it("returns synchronously, so the acknowledgement never waits on a provider", async () => {
    // The provider is waiting on the 2xx. A slow indicator must not be the reason it times out.
    let resolveSignal: (() => void) | undefined;
    const onSignal = vi.fn(() => new Promise<void>((resolve) => (resolveSignal = resolve)));

    const before = Date.now();
    fanOutRunSignals({
      channel: channelOf({ onSignal, signals: { kinds: ["progress"] } }),
      runId: "run-1",
      target: "x",
      frames: framesOf(1),
      logger: { warn: vi.fn() },
    });

    expect(Date.now() - before).toBeLessThan(10);
    resolveSignal?.();
  });
});
