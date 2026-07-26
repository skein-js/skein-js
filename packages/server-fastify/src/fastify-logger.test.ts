// Pino is object-first: `log.error({ err }, msg)`. Getting the argument order backwards still
// "works" — pino prints something — but the record loses its structure, `err` never reaches the error
// serializer, and the fields you'd filter on become part of a message string. These pin the shape.

import { RUN_FAILURE_REPORT_KIND, type RunFailureReport } from "@skein-js/agent-protocol";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";

import { createFastifyLogger } from "./fastify-logger.js";

/** A pino-shaped logger recording the exact arguments each level received. */
function capturingPino(): FastifyBaseLogger & { calls: { level: string; args: unknown[] }[] } {
  const calls: { level: string; args: unknown[] }[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      calls.push({ level, args });
    };
  return {
    calls,
    level: "info",
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    trace: record("trace"),
    silent: record("silent"),
    child() {
      return this;
    },
  } as unknown as FastifyBaseLogger & { calls: { level: string; args: unknown[] }[] };
}

function failureReport(): RunFailureReport {
  return {
    kind: RUN_FAILURE_REPORT_KIND,
    runId: "run-1",
    threadId: "thread-1",
    assistantId: "assistant-1",
    failingNodes: ["research"],
    error: new Error("graph exploded"),
    wireError: { error: "Error", message: "graph exploded", name: "Error" },
  };
}

describe("createFastifyLogger", () => {
  it("passes a bare message through with no bindings object", () => {
    const log = capturingPino();
    createFastifyLogger(log).info("started");
    expect(log.calls).toEqual([{ level: "info", args: ["started"] }]);
  });

  it("maps skein levels straight onto pino's", () => {
    const log = capturingPino();
    const logger = createFastifyLogger(log);
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(log.calls.map((call) => call.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  it("puts a failed run's fields in the bindings, message second", () => {
    const log = capturingPino();
    createFastifyLogger(log).error("Graph run failed", failureReport());

    const [bindings, message] = log.calls[0]?.args as [Record<string, unknown>, string];
    expect(message).toBe("Graph run failed");
    expect(bindings.run_id).toBe("run-1");
    expect(bindings.thread_id).toBe("thread-1");
    expect(bindings.assistant_id).toBe("assistant-1");
    expect(bindings.failing_nodes).toEqual(["research"]);
    // `err`, not `error` — that exact key is what pino's error serializer expands.
    expect(bindings.err).toBeInstanceOf(Error);
  });

  it("omits failing_nodes when LangGraph named no node", () => {
    const log = capturingPino();
    const report: RunFailureReport = { ...failureReport(), failingNodes: [] };
    createFastifyLogger(log).error("Graph run failed", report);
    const [bindings] = log.calls[0]?.args as [Record<string, unknown>];
    expect(bindings).not.toHaveProperty("failing_nodes");
  });

  it("hands a bare Error to pino as err", () => {
    const log = capturingPino();
    const thrown = new Error("connection refused");
    createFastifyLogger(log).warn("webhook failed", thrown);
    expect(log.calls[0]?.args).toEqual([{ err: thrown }, "webhook failed"]);
  });

  it("passes a plain record straight through as bindings", () => {
    const log = capturingPino();
    createFastifyLogger(log).info("Background run succeeded", { run_id: "r1", run_exec_ms: 42 });
    expect(log.calls[0]?.args).toEqual([
      { run_id: "r1", run_exec_ms: 42 },
      "Background run succeeded",
    ]);
  });

  it("gives a primitive a field rather than dropping it", () => {
    const log = capturingPino();
    createFastifyLogger(log).info("note", "extra detail");
    expect(log.calls[0]?.args).toEqual([{ detail: "extra detail" }, "note"]);
  });
});
