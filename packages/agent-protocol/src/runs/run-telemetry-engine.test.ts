// Telemetry as the run engine drives it: which events fire for which terminal status, what a
// failure carries, and — most importantly — that a broken sink cannot break a run.
//
// The privacy rule this pins down (docs/errors-and-logging.md): a sink is server-side, like the log,
// so it receives the original `Error` with its stack even when `exposeErrorStacks` is off. That flag
// governs only what reaches a client.

import type { RunTelemetryEvent, TelemetrySink } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { resolveDeps, type ProtocolDeps } from "../deps.js";
import { createProtocolServiceFromContext } from "../service.js";

/** A sink that records every event it is handed. */
function recordingSink(): TelemetrySink & { events: RunTelemetryEvent[] } {
  const events: RunTelemetryEvent[] = [];
  return { name: "recording", events, onRunEvent: (event) => events.push(event) };
}

async function runToCompletion(overrides: Partial<ProtocolDeps>, assistantId = "echo") {
  const service = createProtocolServiceFromContext(createContext(createFixtureDeps(overrides)));
  await service.assistants.registerGraphAssistants();
  return service.runs.createWait({ assistant_id: assistantId, input: { value: "hi" } });
}

const started = (sink: { events: RunTelemetryEvent[] }) =>
  sink.events.find((event) => event.type === "run.started");
const finished = (sink: { events: RunTelemetryEvent[] }) =>
  sink.events.find((event) => event.type === "run.finished");

describe("run telemetry", () => {
  it("emits a started/finished pair for a successful run", async () => {
    const telemetry = recordingSink();
    await runToCompletion({ telemetry });

    expect(telemetry.events.map((event) => event.type)).toEqual(["run.started", "run.finished"]);

    const begin = started(telemetry);
    expect(begin?.context).toMatchObject({
      assistantId: expect.any(String),
      graphId: "echo",
      trigger: "wait",
      streamModes: ["values"],
    });

    const end = finished(telemetry);
    expect(end).toMatchObject({ status: "success" });
    expect(end?.type === "run.finished" && end.durationMs).toBeGreaterThanOrEqual(0);
    expect(end?.type === "run.finished" && end.frameCount).toBeGreaterThan(0);
  });

  it("reports the same run id on both events, so a span can be paired", async () => {
    const telemetry = recordingSink();
    await runToCompletion({ telemetry });

    expect(started(telemetry)?.context.runId).toBe(finished(telemetry)?.context.runId);
  });

  it("reports a failed run with its error, failing node, and original Error", async () => {
    const telemetry = recordingSink();
    await runToCompletion({ telemetry }, "throwing");

    const end = finished(telemetry);
    expect(end?.type === "run.finished" && end.status).toBe("error");
    expect(end?.type === "run.finished" && end.error?.message).toBeTruthy();
    // `describeFailingNodes` names the node from the post-failure snapshot.
    expect(end?.type === "run.finished" && end.failingNodes).toEqual(["boom"]);
    expect(end?.type === "run.finished" && end.cause).toBeInstanceOf(Error);
  });

  it("gives a sink the full stack even when exposeErrorStacks is off", async () => {
    const telemetry = recordingSink();
    await runToCompletion({ telemetry, exposeErrorStacks: false }, "throwing");

    const end = finished(telemetry);
    // The wire payload is stripped...
    expect(end?.type === "run.finished" && end.error?.stack).toBeUndefined();
    // ...but the sink still gets the real Error, because it is server-side like the log.
    expect(end?.type === "run.finished" && end.cause?.stack).toBeTruthy();
  });

  it("reports a run that timed out", async () => {
    const telemetry = recordingSink();
    await runToCompletion({ telemetry, runTimeoutMs: 1 }, "slow");

    expect(finished(telemetry)?.type === "run.finished" && finished(telemetry)).toMatchObject({
      status: "timeout",
    });
  });

  it("reports an interrupted run as interrupted, not failed", async () => {
    const telemetry = recordingSink();
    await runToCompletion({ telemetry }, "interrupting");

    expect(finished(telemetry)).toMatchObject({ status: "interrupted" });
  });

  it("fires even when logRunActivity is off — the record is not chatter", async () => {
    const telemetry = recordingSink();
    await runToCompletion({ telemetry, logRunActivity: false });

    expect(telemetry.events).toHaveLength(2);
  });

  it("runs normally, and reports telemetry as off, when no sink is configured", async () => {
    // The engine skips building a context or reading a metadata map for a server that isn't
    // listening — `telemetryEnabled` is the flag every one of those guards reads.
    expect(resolveDeps(createFixtureDeps()).telemetryEnabled).toBe(false);
    await expect(runToCompletion({})).resolves.toMatchObject({ value: "echo: hi" });
  });

  it("does not fail a run when every sink method throws", async () => {
    const boom = (): never => {
      throw new Error("sink exploded");
    };
    const telemetry: TelemetrySink = {
      name: "hostile",
      onRunEvent: boom,
      callbacks: boom,
      traceMetadata: boom,
      traceTags: boom,
    };
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };

    const values = await runToCompletion({ telemetry, logger });

    // The run completed normally and returned the graph's real output — the hostile sink changed
    // nothing except that a warning was logged.
    expect(values).toMatchObject({ value: "echo: hi" });
    expect(warn).toHaveBeenCalled();
  });

  it("skips the failing-node lookup for a sink that consumes no run events", async () => {
    // Naming the node that threw costs a checkpointer read — a network round trip in production. A
    // trace-only sink (LangSmith's shape: metadata, no `onRunEvent`) must not pay for it.
    const tracesOnly: TelemetrySink = { name: "traces-only", traceMetadata: () => ({}) };
    const deps = resolveDeps(createFixtureDeps({ telemetry: tracesOnly }));

    expect(deps.telemetryEnabled).toBe(true);
    expect(deps.telemetryWantsRunEvents).toBe(false);

    // And a sink that does consume them flips the flag.
    expect(
      resolveDeps(createFixtureDeps({ telemetry: recordingSink() })).telemetryWantsRunEvents,
    ).toBe(true);
  });

  it("reports the run even when closing the bus fails", async () => {
    // `run.finished` is emitted before `bus.close`, so a bus that rejects on shutdown (a Redis blip)
    // can't strand a span-based sink holding a span for a run that is definitively over.
    const telemetry = recordingSink();
    const deps = createFixtureDeps({ telemetry });
    const bus = deps.bus;
    deps.bus = {
      publish: (runId, frame) => bus.publish(runId, frame),
      subscribe: (runId, afterSeq) => bus.subscribe(runId, afterSeq),
      close: () => Promise.reject(new Error("redis went away")),
    };

    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    await expect(
      service.runs.createWait({ assistant_id: "echo", input: { value: "hi" } }),
    ).rejects.toThrow(/redis went away/);

    expect(telemetry.events.map((event) => event.type)).toEqual(["run.started", "run.finished"]);
    expect(finished(telemetry)).toMatchObject({ status: "success" });
  });

  it("feeds several sinks at once", async () => {
    const first = recordingSink();
    const second = recordingSink();
    await runToCompletion({ telemetry: [first, second] });

    expect(first.events).toHaveLength(2);
    expect(second.events).toHaveLength(2);
  });

  it("stamps trace identity onto the graph call so a tracer can attribute it", async () => {
    const seen: Record<string, unknown>[] = [];
    // A sink whose only job is to observe the context it is asked about — the same context the
    // engine turns into the graph call's `metadata`.
    const telemetry: TelemetrySink = {
      name: "observer",
      traceMetadata: (context) => {
        seen.push({ ...context });
        return {};
      },
    };

    await runToCompletion({ telemetry });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ graphId: "echo", trigger: "wait" });
  });
});
