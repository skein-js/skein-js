// Two separate logging contracts live here. Per-run *activity* (start/finish, tool calls,
// interrupts) is opt-in behind `logRunActivity` — it is chatter, and production doesn't want it.
// A run *failure* is not chatter and is always logged, whatever that flag says: a graph that throws
// and prints nothing is the bug this reporting exists to prevent.

import type { Logger } from "@skein-js/agent-protocol";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

import { isRunFailureReport } from "./run-failure.js";

interface CapturedLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: unknown;
}

/** A logger that records every line, with its level and structured meta, for assertions. */
function capturingLogger(): Logger & { entries: CapturedLine[]; lines: string[] } {
  const entries: CapturedLine[] = [];
  const record =
    (level: CapturedLine["level"]) =>
    (message: string, meta?: unknown): void => {
      entries.push({ level, message, meta });
    };
  return {
    entries,
    get lines() {
      return entries.map((entry) => entry.message);
    },
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

async function runGraph(deps = createFixtureDeps(), assistantId = "echo") {
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  await service.runs.createWait({ assistant_id: assistantId, input: { value: "hi" } });
}

describe("run activity logging", () => {
  it("logs start and finish when logRunActivity is enabled", async () => {
    const logger = capturingLogger();
    await runGraph(createFixtureDeps({ logger, logRunActivity: true }));

    expect(logger.lines.some((line) => /^run .* started/.test(line))).toBe(true);
    expect(logger.lines.some((line) => /^run .* success in \d+ms \(\d+ frames\)$/.test(line))).toBe(
      true,
    );
  });

  it("stays silent about a successful run when logRunActivity is off", async () => {
    const logger = capturingLogger();
    await runGraph(createFixtureDeps({ logger }));
    expect(logger.lines.filter((line) => line.startsWith("run "))).toEqual([]);
  });
});

describe("run failure logging", () => {
  it("reports a failed run at error level even with logRunActivity off", async () => {
    const logger = capturingLogger();
    await runGraph(createFixtureDeps({ logger }), "throwing");

    const reported = logger.entries.filter((entry) => isRunFailureReport(entry.meta));
    expect(reported).toHaveLength(1);
    expect(reported[0]?.level).toBe("error");
    expect(reported[0]?.message).toBe("Graph run failed: boom");
  });

  it("carries the original Error, so a console logger can print its stack and cause", async () => {
    const logger = capturingLogger();
    await runGraph(createFixtureDeps({ logger }), "throwing-with-cause");

    const report = logger.entries.map((entry) => entry.meta).find(isRunFailureReport);
    expect(report?.error).toBeInstanceOf(Error);
    expect(report?.error.stack).toContain("model call failed");
    expect((report?.error.cause as Error | undefined)?.message).toBe("429 rate limit");
    expect(report?.wireError.cause?.message).toBe("429 rate limit");
  });

  it("names the run, the assistant, the thread, and the node that threw", async () => {
    const logger = capturingLogger();
    await runGraph(createFixtureDeps({ logger }), "throwing-with-cause");

    const report = logger.entries.map((entry) => entry.meta).find(isRunFailureReport);
    expect(report?.assistantId).toBe("throwing-with-cause");
    expect(report?.runId).toEqual(expect.any(String));
    expect(report?.threadId).toEqual(expect.any(String));
    // LangGraph never puts the node on the thrown error; this comes from the post-failure snapshot.
    expect(report?.failingNodes).toEqual(["call_model"]);
  });

  it("does not pay for the failing-node lookup when the logger discards everything", async () => {
    // Naming the node costs a `getState` — a checkpointer round trip in production. Assembling a
    // report for the default no-op logger would spend that on an object nobody reads.
    const countGetState = async (deps: ReturnType<typeof createFixtureDeps>) => {
      const graph = (await deps.graphs.load("throwing")) as unknown as { getState: () => unknown };
      const spy = vi.spyOn(graph, "getState");
      const service = createProtocolServiceFromContext(createContext(deps));
      await service.assistants.registerGraphAssistants();
      await service.runs.createWait({ assistant_id: "throwing", input: { value: "hi" } });
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    };

    // The graph throws before the success path's own `getState`, so this counts only the report's.
    expect(await countGetState(createFixtureDeps())).toBe(0);
    expect(await countGetState(createFixtureDeps({ logger: capturingLogger() }))).toBe(1);
  });

  it("keeps the stack out of the report's wire payload while logging it in full", async () => {
    const logger = capturingLogger();
    await runGraph(createFixtureDeps({ logger }), "throwing");

    const report = logger.entries.map((entry) => entry.meta).find(isRunFailureReport);
    // Server-side detail is always available...
    expect(report?.error.stack).toBeDefined();
    // ...but the payload headed for the client carries none by default.
    expect(report?.wireError).not.toHaveProperty("stack");
  });
});
