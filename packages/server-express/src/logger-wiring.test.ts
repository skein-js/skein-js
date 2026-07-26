// Express owns no logger of its own, so skein deliberately defaults to silence here — unlike the
// NestJS and Fastify adapters, which borrow the host framework's. That silence is a *decision*, not
// an oversight, so it is worth a test: the failure mode this guards against is someone "fixing" it
// later and having a library start writing into an application's stdout uninvited.
//
// The other half is that an opt-in logger must actually reach the run engine. It did not before this
// wiring existed — the option only ever fed request lines and adapter faults.

import { type CompiledGraph, MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import type { GraphResolver, GraphSchemas } from "@skein-js/agent-protocol";
import type { Logger } from "@skein-js/server-kit";
import { describe, expect, it } from "vitest";

import { createEchoDeps } from "./__fixtures__/echo-server.js";
import { skeinRouter } from "./skein-router.js";

/** A `Logger` recording what it was told. */
function capturingLogger(): Logger & { entries: { level: string; message: string }[] } {
  const entries: { level: string; message: string }[] = [];
  const record =
    (level: string) =>
    (message: string): void => {
      entries.push({ level, message });
    };
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
}

/** Swap in a graph that always throws, so the engine has something to report. */
function withExplodingGraph(deps: ReturnType<typeof createEchoDeps>): typeof deps {
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("boom", () => {
      throw new Error("graph exploded");
    })
    .addEdge("__start__", "boom")
    .compile() as unknown as CompiledGraph<string>;
  const graphs: GraphResolver = {
    ids: ["boom"],
    load: async () => graph,
    schemas: async (graphId) => ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
  };
  return { ...deps, graphs };
}

describe("Express adapter — logger wiring", () => {
  it("installs no logger of its own", async () => {
    const { runtime, logger } = await skeinRouter({ deps: createEchoDeps() });
    try {
      expect(logger).toBeUndefined();
    } finally {
      await runtime.worker.stop();
    }
  });

  it("carries an explicit logger through to the engine", async () => {
    const logger = capturingLogger();
    const { runtime, logger: resolved } = await skeinRouter({
      deps: withExplodingGraph(createEchoDeps()),
      logger,
    });
    try {
      expect(resolved).toBe(logger);

      // Prove it is live, not merely stored: run the throwing graph and expect the report.
      await runtime.service.runs.createWait({
        assistant_id: "boom",
        input: { messages: [] },
      });
      expect(logger.entries).toContainEqual(
        expect.objectContaining({ level: "error", message: expect.stringContaining("failed") }),
      );
    } finally {
      await runtime.worker.stop();
    }
  });

  it("prefers an injected deps.logger over nothing", async () => {
    const logger = capturingLogger();
    const { runtime, logger: resolved } = await skeinRouter({
      deps: { ...createEchoDeps(), logger },
    });
    try {
      expect(resolved).toBe(logger);
    } finally {
      await runtime.worker.stop();
    }
  });
});
