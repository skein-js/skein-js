// The mapping from a run to what a telemetry backend sees, tested on its own. The engine-level
// behavior (which events fire, for which statuses) lives in run-telemetry-engine.test.ts.

import type { Run, RunKwargs, RunTelemetryContext, TelemetrySink } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps, type Logger, type ProtocolDeps } from "../deps.js";

import { emitRunEvent, telemetryCallOptions, toRunTelemetryContext } from "./run-telemetry.js";

const run = {
  run_id: "run-1",
  thread_id: "thread-1",
  assistant_id: "assistant-1",
  created_at: "2026-07-26T00:00:00.000Z",
  updated_at: "2026-07-26T00:00:00.000Z",
  status: "running",
  metadata: { tenant: "acme" },
} as unknown as Run;

const context: RunTelemetryContext = {
  runId: "run-1",
  threadId: "thread-1",
  assistantId: "assistant-1",
  graphId: "agent",
  trigger: "wait",
  streamModes: ["values"],
};

function resolve(overrides: Partial<ProtocolDeps> = {}) {
  return resolveDeps(createFixtureDeps(overrides));
}

describe("toRunTelemetryContext", () => {
  it("describes a run, taking the graph id from the assistant", () => {
    const built = toRunTelemetryContext(run, { stream_mode: "values" }, "agent", "background");

    expect(built).toEqual({
      runId: "run-1",
      threadId: "thread-1",
      assistantId: "assistant-1",
      graphId: "agent",
      trigger: "background",
      streamModes: ["values"],
      metadata: { tenant: "acme" },
    });
  });

  it("normalizes stream modes the way the graph call does", () => {
    // `messages-tuple` is the SDK's alias for the graph's `messages` mode.
    const built = toRunTelemetryContext(run, { stream_mode: "messages-tuple" }, "agent", "wait");
    expect(built.streamModes).toEqual(["messages"]);

    // No mode requested is `values`, matching `normalizeModes`.
    expect(toRunTelemetryContext(run, {}, "agent", "wait").streamModes).toEqual(["values"]);
  });

  it("carries the authenticated principal as userId, and omits it when unauthenticated", () => {
    const kwargs: RunKwargs = {
      auth_user: {
        identity: "user-42",
        display_name: "Ada",
        is_authenticated: true,
        permissions: [],
      },
    };

    expect(toRunTelemetryContext(run, kwargs, "agent", "wait").userId).toBe("user-42");
    expect(toRunTelemetryContext(run, {}, "agent", "wait").userId).toBeUndefined();
  });
});

describe("emitRunEvent", () => {
  const event = {
    type: "run.started",
    context,
    startedAt: new Date("2026-07-26T00:00:00.000Z"),
  } as const;

  it("does nothing when no sink is configured", () => {
    expect(() => emitRunEvent(resolve(), event)).not.toThrow();
  });

  it("hands the event to the sink", () => {
    const onRunEvent = vi.fn();
    emitRunEvent(resolve({ telemetry: { name: "test", onRunEvent } }), event);

    expect(onRunEvent).toHaveBeenCalledWith(event);
  });

  it("swallows a throwing sink and warns instead of failing the run", () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } satisfies Logger;
    const telemetry: TelemetrySink = {
      name: "bad",
      onRunEvent: () => {
        throw new Error("sink exploded");
      },
    };

    expect(() => emitRunEvent(resolve({ telemetry, logger }), event)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("bad");
  });
});

describe("telemetryCallOptions", () => {
  it("returns nothing to merge when no sink is configured", () => {
    expect(telemetryCallOptions(resolve(), context)).toEqual({});
  });

  it("stamps vendor-neutral run identity every tracer can read", () => {
    const options = telemetryCallOptions(resolve({ telemetry: { name: "test" } }), context);

    expect(options.metadata).toEqual({
      run_id: "run-1",
      thread_id: "thread-1",
      assistant_id: "assistant-1",
      graph_id: "agent",
    });
    expect(options.tags).toEqual(["skein", "graph:agent"]);
    expect(options.runName).toBe("agent");
  });

  it("omits assistant_id for the invoke surface, which has no assistant", () => {
    const options = telemetryCallOptions(resolve({ telemetry: { name: "test" } }), {
      ...context,
      assistantId: undefined,
      trigger: "invoke",
    });

    expect(options.metadata).not.toHaveProperty("assistant_id");
    expect(options.metadata).toMatchObject({ graph_id: "agent" });
  });

  it("includes user_id only when the run carries a principal", () => {
    const deps = resolve({ telemetry: { name: "test" } });

    expect(telemetryCallOptions(deps, { ...context, userId: "user-42" }).metadata).toMatchObject({
      user_id: "user-42",
    });
    expect(telemetryCallOptions(deps, context).metadata).not.toHaveProperty("user_id");
  });

  it("merges a sink's own metadata and tags", () => {
    const telemetry: TelemetrySink = {
      name: "langsmith",
      traceMetadata: (ctx) => ({ session_id: ctx.threadId }),
      traceTags: () => ["langsmith"],
    };

    const options = telemetryCallOptions(resolve({ telemetry }), context);

    expect(options.metadata).toMatchObject({ session_id: "thread-1", run_id: "run-1" });
    expect(options.tags).toEqual(["skein", "graph:agent", "langsmith"]);
  });

  it("lets skein's identity win when a sink tries to overwrite it", () => {
    // A sink may extend the identity but must not rewrite it — otherwise a trace could claim to
    // belong to a different run than the one that produced it.
    const telemetry: TelemetrySink = {
      name: "confused",
      traceMetadata: () => ({ run_id: "not-the-run", thread_id: "not-the-thread" }),
    };

    expect(telemetryCallOptions(resolve({ telemetry }), context).metadata).toMatchObject({
      run_id: "run-1",
      thread_id: "thread-1",
    });
  });

  it("passes a sink's callback handlers through", () => {
    const handler = { name: "tracer" };
    const telemetry: TelemetrySink = { name: "langfuse", callbacks: () => [handler] };

    expect(telemetryCallOptions(resolve({ telemetry }), context).callbacks).toEqual([handler]);
  });

  it("leaves callbacks unset when no sink supplies a handler", () => {
    // An empty array is NOT inert to LangChain: it replaces the inherited callback manager, which
    // would silence the global tracer `LANGSMITH_TRACING=true` installs.
    const options = telemetryCallOptions(resolve({ telemetry: { name: "metrics-only" } }), context);

    expect(options).not.toHaveProperty("callbacks");
  });

  it("survives a sink that throws from every contribution method", () => {
    const boom = (): never => {
      throw new Error("nope");
    };
    const telemetry: TelemetrySink = {
      name: "bad",
      traceMetadata: boom,
      traceTags: boom,
      callbacks: boom,
    };

    const options = telemetryCallOptions(resolve({ telemetry }), context);

    expect(options.metadata).toMatchObject({ run_id: "run-1" });
    expect(options.tags).toEqual(["skein", "graph:agent"]);
  });
});
