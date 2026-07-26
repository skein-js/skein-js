import type { RunTelemetryContext, RunTelemetryEvent, TelemetrySink } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import type { PostHogTelemetryOptions } from "./posthog-telemetry.js";
import { createPostHogTelemetry, type PostHogClientLike } from "./posthog-telemetry.js";

/** Build a sink that is definitely configured — the `undefined` case has its own tests. */
function sink(options: PostHogTelemetryOptions): TelemetrySink {
  const built = createPostHogTelemetry(options);
  if (!built) throw new Error("expected the sink to be configured");
  return built;
}

const context: RunTelemetryContext = {
  runId: "run-1",
  threadId: "thread-1",
  assistantId: "assistant-1",
  graphId: "agent",
  trigger: "background",
  streamModes: ["values"],
};

interface CapturedEvent {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}

/** A fake PostHog client that records captures — no network, the `webhookDispatcher` test pattern. */
function fakeClient(): PostHogClientLike & { captured: CapturedEvent[] } {
  const captured: CapturedEvent[] = [];
  return {
    captured,
    capture: (event) => captured.push(event),
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

const finished = (overrides: Partial<Extract<RunTelemetryEvent, { type: "run.finished" }>> = {}) =>
  ({
    type: "run.finished",
    context,
    status: "success",
    durationMs: 1234,
    frameCount: 7,
    endedAt: new Date("2026-07-26T00:00:01.000Z"),
    ...overrides,
  }) as RunTelemetryEvent;

describe("createPostHogTelemetry", () => {
  it("returns undefined when PostHog is not configured", () => {
    expect(createPostHogTelemetry({ env: {} })).toBeUndefined();
  });

  it("enables from POSTHOG_API_KEY", () => {
    expect(createPostHogTelemetry({ env: { POSTHOG_API_KEY: "phc_x" } })).toBeDefined();
  });

  it("enables from an injected client with no key at all", () => {
    expect(createPostHogTelemetry({ env: {}, client: fakeClient() })).toBeDefined();
  });

  describe("run lifecycle", () => {
    it("captures a started event with queue latency", () => {
      const client = fakeClient();
      sink({ client }).onRunEvent?.({
        type: "run.started",
        context,
        startedAt: new Date(),
        queuedMs: 250,
      });

      expect(client.captured).toHaveLength(1);
      expect(client.captured[0]).toMatchObject({
        distinctId: "thread-1",
        event: "skein_run_started",
        properties: { queue_ms: 250, graph_id: "agent", run_id: "run-1", trigger: "background" },
      });
    });

    it("captures a finished event with status, duration, and frame count", () => {
      const client = fakeClient();
      sink({ client }).onRunEvent?.(finished());

      expect(client.captured[0]).toMatchObject({
        event: "skein_run_finished",
        properties: { status: "success", duration_ms: 1234, frame_count: 7, is_error: false },
      });
    });

    it("marks a failure and names the error and failing node", () => {
      const client = fakeClient();
      sink({ client }).onRunEvent?.(
        finished({
          status: "error",
          error: { error: "TypeError", name: "TypeError", message: "boom" },
          failingNodes: ["call_model"],
        }),
      );

      expect(client.captured[0]?.properties).toMatchObject({
        status: "error",
        is_error: true,
        error_name: "TypeError",
        error_message: "boom",
        failing_nodes: ["call_model"],
      });
    });

    it("counts a timeout as an error", () => {
      const client = fakeClient();
      sink({ client }).onRunEvent?.(finished({ status: "timeout" }));

      expect(client.captured[0]?.properties).toMatchObject({ is_error: true });
    });

    it("omits an empty failing-nodes list rather than sending a meaningless empty array", () => {
      const client = fakeClient();
      sink({ client }).onRunEvent?.(finished({ failingNodes: [] }));

      expect(client.captured[0]?.properties).not.toHaveProperty("failing_nodes");
    });
  });

  describe("distinct id", () => {
    it("attributes a run to the authenticated user when there is one", () => {
      const client = fakeClient();
      sink({ client }).onRunEvent?.(finished({ context: { ...context, userId: "user-42" } }));

      expect(client.captured[0]?.distinctId).toBe("user-42");
    });

    it("falls back to the thread, so anonymous traffic groups per conversation", () => {
      const client = fakeClient();
      sink({ client }).onRunEvent?.(finished());

      expect(client.captured[0]?.distinctId).toBe("thread-1");
    });

    it("honours a custom resolver", () => {
      const client = fakeClient();
      sink({ client, distinctId: (ctx) => `tenant:${ctx.graphId}` }).onRunEvent?.(finished());

      expect(client.captured[0]?.distinctId).toBe("tenant:agent");
    });
  });

  describe("$ai_generation", () => {
    /** Drive the callback handler the way LangChain would. */
    function emitGeneration(client: PostHogClientLike, output: unknown) {
      const built = sink({ client });
      const handler = built.callbacks?.(context)[0] as Record<string, (...args: unknown[]) => void>;
      handler["handleChatModelStart"]?.(
        { id: ["langchain", "chat_models", "ChatOpenAI"] },
        [],
        "llm-1",
        undefined,
        {
          invocation_params: { model: "gpt-4o-mini" },
        },
      );
      handler["handleLLMEnd"]?.(output, "llm-1");
      return handler;
    }

    it("captures token usage from the modern usage_metadata shape", () => {
      const client = fakeClient();
      emitGeneration(client, {
        generations: [
          [
            {
              message: {
                usage_metadata: { input_tokens: 11, output_tokens: 22, total_tokens: 33 },
              },
            },
          ],
        ],
      });

      expect(client.captured[0]).toMatchObject({
        event: "$ai_generation",
        properties: {
          $ai_model: "gpt-4o-mini",
          $ai_provider: "ChatOpenAI",
          $ai_input_tokens: 11,
          $ai_output_tokens: 22,
          $ai_total_tokens: 33,
          $ai_is_error: false,
          $ai_trace_id: "run-1",
          $ai_span_id: "llm-1",
        },
      });
    });

    it("falls back to the older llmOutput.tokenUsage shape", () => {
      const client = fakeClient();
      emitGeneration(client, {
        llmOutput: { tokenUsage: { promptTokens: 5, completionTokens: 6 } },
      });

      expect(client.captured[0]?.properties).toMatchObject({
        $ai_input_tokens: 5,
        $ai_output_tokens: 6,
      });
    });

    it("emits nothing about tokens when the provider reported none", () => {
      const client = fakeClient();
      emitGeneration(client, {});

      expect(client.captured[0]?.properties).not.toHaveProperty("$ai_input_tokens");
      expect(client.captured[0]?.properties).toMatchObject({ $ai_is_error: false });
    });

    it("omits latency when it never saw the generation start", () => {
      // No `handleChatModelStart` — the handler was attached mid-call, or the integration only fires
      // the end hook. Reporting ~0s would drag PostHog's latency percentiles down with a lie; the
      // same policy token counts follow.
      const client = fakeClient();
      const handler = sink({ client }).callbacks?.(context)[0] as Record<
        string,
        (...args: unknown[]) => void
      >;
      handler["handleLLMEnd"]?.({}, "llm-orphan");

      expect(client.captured[0]?.properties).not.toHaveProperty("$ai_latency");
      expect(client.captured[0]?.properties).toMatchObject({ $ai_span_id: "llm-orphan" });
    });

    it("reports latency when it did see the start", () => {
      const client = fakeClient();
      emitGeneration(client, {});

      expect(client.captured[0]?.properties).toHaveProperty("$ai_latency");
    });

    it("captures a failed generation as an error", () => {
      const client = fakeClient();
      const built = sink({ client });
      const handler = built.callbacks?.(context)[0] as Record<string, (...args: unknown[]) => void>;
      handler["handleChatModelStart"]?.({ id: ["ChatOpenAI"] }, [], "llm-1", undefined, {});
      handler["handleLLMError"]?.(new Error("rate limited"), "llm-1");

      expect(client.captured[0]?.properties).toMatchObject({
        $ai_is_error: true,
        $ai_error: "rate limited",
      });
    });

    it("correlates a generation to the run that produced it", () => {
      const client = fakeClient();
      emitGeneration(client, {});

      expect(client.captured[0]?.properties).toMatchObject({
        $ai_trace_id: "run-1",
        thread_id: "thread-1",
        graph_id: "agent",
      });
    });

    it("attaches no handler when captureGenerations is off", () => {
      const client = fakeClient();
      expect(sink({ client, captureGenerations: false }).callbacks?.(context)).toEqual([]);
    });
  });

  it("flushes and shuts the client down", async () => {
    const client = fakeClient();
    const built = sink({ client });

    await built.flush?.();
    await built.shutdown?.();

    expect(client.flush).toHaveBeenCalledTimes(1);
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });
});
