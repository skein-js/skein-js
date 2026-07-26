import { describe, expect, it, vi } from "vitest";

import {
  anySinkWantsRunEvents,
  combineTelemetrySinks,
  type RunTelemetryContext,
  type TelemetrySink,
} from "./telemetry.js";

const context: RunTelemetryContext = {
  runId: "run-1",
  threadId: "thread-1",
  assistantId: "assistant-1",
  graphId: "agent",
  trigger: "background",
  streamModes: ["values"],
};

const startedEvent = {
  type: "run.started",
  context,
  startedAt: new Date("2026-07-26T00:00:00.000Z"),
} as const;

/** A sink that records what it was called with, so a test can assert it was reached. */
function recordingSink(name: string): TelemetrySink & { events: string[] } {
  const events: string[] = [];
  return {
    name,
    events,
    onRunEvent: (event) => events.push(event.type),
    callbacks: () => [`${name}-handler`],
    traceMetadata: () => ({ [`${name}_key`]: name }),
    traceTags: () => [name],
  };
}

/** A sink that fails every way it can. */
function throwingSink(name: string): TelemetrySink {
  const boom = (): never => {
    throw new Error(`${name} exploded`);
  };
  return {
    name,
    onRunEvent: boom,
    callbacks: boom,
    traceMetadata: boom,
    traceTags: boom,
    flush: () => Promise.reject(new Error(`${name} flush failed`)),
    shutdown: () => Promise.reject(new Error(`${name} shutdown failed`)),
  };
}

describe("combineTelemetrySinks", () => {
  it("returns a working no-op sink for an empty list", async () => {
    const combined = combineTelemetrySinks([]);

    expect(() => combined.onRunEvent?.(startedEvent)).not.toThrow();
    expect(combined.callbacks?.(context)).toEqual([]);
    expect(combined.traceMetadata?.(context)).toEqual({});
    expect(combined.traceTags?.(context)).toEqual([]);
    await expect(combined.flush?.()).resolves.toBeUndefined();
    await expect(combined.shutdown?.()).resolves.toBeUndefined();
  });

  it("fans events out to every sink", () => {
    const first = recordingSink("first");
    const second = recordingSink("second");

    combineTelemetrySinks([first, second]).onRunEvent?.(startedEvent);

    expect(first.events).toEqual(["run.started"]);
    expect(second.events).toEqual(["run.started"]);
  });

  it("merges callbacks, metadata, and tags across sinks", () => {
    const combined = combineTelemetrySinks([recordingSink("a"), recordingSink("b")]);

    expect(combined.callbacks?.(context)).toEqual(["a-handler", "b-handler"]);
    expect(combined.traceMetadata?.(context)).toEqual({ a_key: "a", b_key: "b" });
    expect(combined.traceTags?.(context)).toEqual(["a", "b"]);
  });

  it("isolates a throwing sink so its neighbours still run", () => {
    const before = recordingSink("before");
    const after = recordingSink("after");
    const combined = combineTelemetrySinks([before, throwingSink("bad"), after]);

    expect(() => combined.onRunEvent?.(startedEvent)).not.toThrow();
    expect(before.events).toEqual(["run.started"]);
    expect(after.events).toEqual(["run.started"]);

    // The healthy sinks' contributions survive; the throwing one contributes nothing.
    expect(combined.callbacks?.(context)).toEqual(["before-handler", "after-handler"]);
    expect(combined.traceMetadata?.(context)).toEqual({ before_key: "before", after_key: "after" });
    expect(combined.traceTags?.(context)).toEqual(["before", "after"]);
  });

  it("reports a throwing sink by name instead of swallowing it silently", () => {
    const report = vi.fn();

    combineTelemetrySinks([throwingSink("bad")], report).onRunEvent?.(startedEvent);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[1]).toBe("bad");
    expect((report.mock.calls[0]?.[0] as Error).message).toBe("bad exploded");
  });

  it("catches an async sink's rejection instead of letting it kill the process", async () => {
    // `onRunEvent` is declared `void`, but TypeScript's void-return bivariance accepts an `async`
    // method there — and that is the natural thing to write for a sink that does I/O. A dropped
    // rejection is an unhandled rejection, which on Node >=15 terminates the process.
    const report = vi.fn();
    const telemetry: TelemetrySink = {
      name: "async-bad",
      onRunEvent: (() =>
        Promise.reject(
          new Error("collector unreachable"),
        )) as unknown as TelemetrySink["onRunEvent"],
    };

    combineTelemetrySinks([telemetry], report).onRunEvent?.(startedEvent);
    await Promise.resolve();
    await Promise.resolve();

    expect(report).toHaveBeenCalledWith(expect.any(Error), "async-bad");
    expect((report.mock.calls[0]?.[0] as Error).message).toBe("collector unreachable");
  });

  it("does not disturb an async sink that resolves normally", async () => {
    const report = vi.fn();
    const seen: string[] = [];
    const telemetry: TelemetrySink = {
      name: "async-good",
      onRunEvent: ((event: { type: string }) => {
        seen.push(event.type);
        return Promise.resolve();
      }) as unknown as TelemetrySink["onRunEvent"],
    };

    combineTelemetrySinks([telemetry], report).onRunEvent?.(startedEvent);
    await Promise.resolve();

    expect(seen).toEqual(["run.started"]);
    expect(report).not.toHaveBeenCalled();
  });

  it("survives a reporter that itself throws", () => {
    const combined = combineTelemetrySinks([throwingSink("bad")], () => {
      throw new Error("reporter exploded");
    });

    expect(() => combined.onRunEvent?.(startedEvent)).not.toThrow();
  });

  it("flushes every sink even when one rejects", async () => {
    const flushed = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const healthy: TelemetrySink = { name: "healthy", flush: flushed };

    await expect(
      combineTelemetrySinks([throwingSink("bad"), healthy], report).flush?.(),
    ).resolves.toBeUndefined();

    expect(flushed).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.any(Error), "bad");
  });

  it("shuts every sink down even when one rejects", async () => {
    const stopped = vi.fn().mockResolvedValue(undefined);
    const healthy: TelemetrySink = { name: "healthy", shutdown: stopped };

    await expect(
      combineTelemetrySinks([throwingSink("bad"), healthy]).shutdown?.(),
    ).resolves.toBeUndefined();

    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("names itself after its members, so a log line says which sink threw", () => {
    expect(combineTelemetrySinks([recordingSink("solo")]).name).toBe("solo");
    expect(combineTelemetrySinks([recordingSink("a"), recordingSink("b")]).name).toBe("[a, b]");
  });

  it("reports which sinks consume run events, so callers can skip work nothing reads", () => {
    // Building a failure report costs a checkpointer round trip; a trace-only sink must not pay it.
    expect(anySinkWantsRunEvents([{ name: "traces-only", traceMetadata: () => ({}) }])).toBe(false);
    expect(anySinkWantsRunEvents([{ name: "events", onRunEvent: () => {} }])).toBe(true);
    expect(
      anySinkWantsRunEvents([{ name: "traces-only" }, { name: "events", onRunEvent: () => {} }]),
    ).toBe(true);
    expect(anySinkWantsRunEvents([])).toBe(false);
  });

  it("skips a null sink rather than throwing on it", () => {
    const healthy = recordingSink("healthy");
    // A loader that returns `undefined` for an unconfigured provider is the expected source here.
    const combined = combineTelemetrySinks([undefined as unknown as TelemetrySink, healthy]);

    expect(() => combined.onRunEvent?.(startedEvent)).not.toThrow();
    expect(healthy.events).toEqual(["run.started"]);
  });
});
