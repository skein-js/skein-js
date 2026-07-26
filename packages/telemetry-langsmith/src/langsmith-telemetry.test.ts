import type { RunTelemetryContext } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createLangSmithTelemetry, isLangSmithTracingEnabled } from "./langsmith-telemetry.js";

const context: RunTelemetryContext = {
  runId: "run-1",
  threadId: "thread-1",
  assistantId: "assistant-1",
  graphId: "agent",
  trigger: "wait",
  streamModes: ["values"],
};

describe("createLangSmithTelemetry", () => {
  it("returns undefined when LangSmith is not configured", () => {
    expect(createLangSmithTelemetry({ env: {} })).toBeUndefined();
  });

  it("enables on an API key from either the current or the legacy env var", () => {
    expect(createLangSmithTelemetry({ env: { LANGSMITH_API_KEY: "lsv2_pt_x" } })).toBeDefined();
    expect(createLangSmithTelemetry({ env: { LANGCHAIN_API_KEY: "lsv2_pt_x" } })).toBeDefined();
  });

  it("enables on an explicit project name even with an empty environment", () => {
    expect(createLangSmithTelemetry({ env: {}, projectName: "my-agents" })).toBeDefined();
  });

  it("does NOT switch tracing on merely because a credential is present", () => {
    // Enabling tracing starts uploading user messages to a third party. Finding a key in the
    // environment — common, since plenty of tooling uses LangSmith — is not consent for that.
    const env: Record<string, string | undefined> = { LANGSMITH_API_KEY: "lsv2_pt_x" };
    createLangSmithTelemetry({ env });

    expect(env["LANGSMITH_TRACING"]).toBeUndefined();
  });

  it("switches tracing on only when explicitly asked", () => {
    const env: Record<string, string | undefined> = { LANGSMITH_API_KEY: "lsv2_pt_x" };
    createLangSmithTelemetry({ env, enableTracing: true });

    expect(env["LANGSMITH_TRACING"]).toBe("true");
  });

  it("never writes a credential into the environment", () => {
    // A key assigned to `process.env` is readable by every module in the process and inherited by
    // every child process spawned afterwards. Read it, don't spread it.
    const env: Record<string, string | undefined> = {};
    createLangSmithTelemetry({ env, projectName: "my-agents", enableTracing: true });

    expect(env["LANGSMITH_API_KEY"]).toBeUndefined();
    expect(env["LANGSMITH_ENDPOINT"]).toBeUndefined();
    // The project name is not a secret, and the tracer needs it to file traces correctly.
    expect(env["LANGSMITH_PROJECT"]).toBe("my-agents");
  });

  it("never overrides configuration the operator already set", () => {
    const env: Record<string, string | undefined> = {
      LANGSMITH_API_KEY: "from-env",
      LANGSMITH_PROJECT: "from-env-project",
    };
    createLangSmithTelemetry({ env, projectName: "from-code-project", enableTracing: true });

    expect(env["LANGSMITH_API_KEY"]).toBe("from-env");
    expect(env["LANGSMITH_PROJECT"]).toBe("from-env-project");
  });

  it("respects a deliberate LANGSMITH_TRACING=false", () => {
    // An operator who turned tracing off meant it; only an *unset* value is ours to fill in.
    const env: Record<string, string | undefined> = {
      LANGSMITH_API_KEY: "lsv2_pt_x",
      LANGSMITH_TRACING: "false",
    };
    createLangSmithTelemetry({ env, enableTracing: true });

    expect(env["LANGSMITH_TRACING"]).toBe("false");
  });

  it("reports whether the global tracer is already on", () => {
    expect(isLangSmithTracingEnabled({ LANGSMITH_TRACING: "true" })).toBe(true);
    expect(isLangSmithTracingEnabled({ LANGCHAIN_TRACING_V2: "1" })).toBe(true);
    expect(isLangSmithTracingEnabled({ LANGSMITH_TRACING: "false" })).toBe(false);
    expect(isLangSmithTracingEnabled({})).toBe(false);
  });

  it("groups a thread's runs by setting session_id — the whole point of the integration", () => {
    const sink = createLangSmithTelemetry({ env: { LANGSMITH_API_KEY: "lsv2_pt_x" } });

    expect(sink?.traceMetadata?.(context)).toMatchObject({
      session_id: "thread-1",
      skein_assistant_id: "assistant-1",
      skein_trigger: "wait",
    });
  });

  it("carries the authenticated user as ls_user_id when there is one", () => {
    const sink = createLangSmithTelemetry({ env: { LANGSMITH_API_KEY: "lsv2_pt_x" } });

    expect(sink?.traceMetadata?.({ ...context, userId: "user-42" })).toMatchObject({
      ls_user_id: "user-42",
    });
    expect(sink?.traceMetadata?.(context)).not.toHaveProperty("ls_user_id");
  });

  it("omits assistant identity on the invoke surface, which has none", () => {
    const sink = createLangSmithTelemetry({ env: { LANGSMITH_API_KEY: "lsv2_pt_x" } });
    const invoke = { ...context, assistantId: undefined, trigger: "invoke" as const };

    expect(sink?.traceMetadata?.(invoke)).not.toHaveProperty("skein_assistant_id");
    expect(sink?.traceTags?.(invoke)).toEqual(["trigger:invoke"]);
  });

  it("tags a trace with its trigger and assistant", () => {
    const sink = createLangSmithTelemetry({ env: { LANGSMITH_API_KEY: "lsv2_pt_x" } });

    expect(sink?.traceTags?.(context)).toEqual(["trigger:wait", "assistant:assistant-1"]);
  });

  it("attaches no callback handlers, so the global tracer is never doubled", () => {
    // Attaching our own LangChainTracer alongside the global one would send every span twice.
    const sink = createLangSmithTelemetry({ env: { LANGSMITH_API_KEY: "lsv2_pt_x" } });

    expect(sink?.callbacks).toBeUndefined();
  });

  it("flushes without throwing", async () => {
    const sink = createLangSmithTelemetry({ env: { LANGSMITH_API_KEY: "lsv2_pt_x" } });

    await expect(sink?.flush?.()).resolves.toBeUndefined();
  });
});
