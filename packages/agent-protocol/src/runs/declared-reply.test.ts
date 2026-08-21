// A graph declaring its own answer, and that answer surviving into the callback.

import type { Run, RunKwargs } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps, createFixtureResolver } from "../__fixtures__/deps.js";
import { declaringGraph, echoGraph } from "../__fixtures__/graphs.js";
import { fixtureLangGraphAgent } from "../__fixtures__/lang-graph-binding.js";
import type { GraphSchemas, ResolvedGraph } from "../deps.js";
import { resolveDeps, type WebhookDispatcher } from "../deps.js";

import { RunControlRegistry } from "./cancellation.js";
import { DECLARED_REPLY_KEY, readDeclaredReply, replyWith } from "./declared-reply.js";
import { executeRun } from "./run-engine.js";

describe("replyWith / readDeclaredReply", () => {
  it("round-trips a reply through the reserved key", () => {
    expect(readDeclaredReply(replyWith("ships Tuesday"))).toEqual({ reply: "ships Tuesday" });
  });

  it("ignores ordinary custom-stream payloads", () => {
    // The narrowness that matters: a graph streaming progress data must never be mistaken for one
    // declaring an answer, or every custom writer becomes an accidental outbound message.
    expect(readDeclaredReply({ progress: 0.5 })).toBeUndefined();
    expect(readDeclaredReply("ships Tuesday")).toBeUndefined();
    expect(readDeclaredReply(null)).toBeUndefined();
  });

  it("reads a reply of any shape, including null and false", () => {
    // `hasOwnProperty` rather than a truthiness check — a graph resuming an interrupt may legitimately
    // want to send `false`, and dropping it would silently answer nothing.
    expect(readDeclaredReply({ [DECLARED_REPLY_KEY]: false })).toEqual({ reply: false });
    expect(readDeclaredReply({ [DECLARED_REPLY_KEY]: null })).toEqual({ reply: null });
  });
});

describe("a declared reply in the callback", () => {
  // A resolver local to this file rather than another entry in the shared fixture map: two tests
  // assert the exact list of fixture graphs, so adding one there is a change to their subject.
  const graphs = { declaring: declaringGraph, echo: echoGraph };
  const resolver = {
    ...createFixtureResolver(),
    ids: Object.keys(graphs),
    load: async (graphId: string): Promise<ResolvedGraph> =>
      fixtureLangGraphAgent(graphs[graphId as keyof typeof graphs]),
    schemas: async (graphId: string): Promise<GraphSchemas> =>
      ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
  };

  async function runGraph(graphId: string) {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const deps = resolveDeps(createFixtureDeps({ webhookDispatcher: dispatch, graphs: resolver }));
    await deps.store.assistants.create({ graph_id: graphId, assistant_id: graphId });
    const thread = await deps.store.threads.create();
    const run: Run = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: graphId,
      status: "pending",
    });
    const kwargs: RunKwargs = {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
      stream_mode: ["values", "custom"],
    };
    const control = new RunControlRegistry().register(run.run_id);
    const outcome = await executeRun(deps, { run, kwargs, control });
    return { dispatch, outcome };
  }

  it("carries what the graph declared, not what state happens to hold", async () => {
    // The coupling this exists to break: the deliverer never has to know whether the answer lives at
    // `state.answer`, `state.messages.at(-1)` or somewhere else. The graph says so.
    const { dispatch, outcome } = await runGraph("declaring");

    expect(outcome.status).toBe("success");
    const body = dispatch.mock.calls[0]![1] as Record<string, unknown>;
    expect(body["reply"]).toBe("declared: hi");
    // And the state is still delivered — declaring a reply adds to the callback, it does not replace it.
    expect(body["values"]).toMatchObject({ value: "state value nobody should send" });
  });

  it("survives the crash window, because it is stored rather than streamed", async () => {
    // The reason this is captured into the payload instead of read off the event bus: bus frames live
    // in memory and are never persisted. The stored delivery is what a retry replays.
    const { outcome } = await runGraph("declaring");

    expect(outcome.reply).toBe("declared: hi");
  });

  it("adds nothing for a graph that declares no reply", async () => {
    const { dispatch } = await runGraph("echo");

    expect(dispatch.mock.calls[0]![1]).not.toHaveProperty("reply");
  });
});
