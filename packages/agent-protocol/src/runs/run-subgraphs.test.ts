// `stream_subgraphs`: a run that asks for it streams the frames its subgraphs emit — named
// `mode|<namespace>`, the way LangGraph Platform names them and `@langchain/langgraph-sdk` routes them —
// and a run that does not ask streams exactly what it did before. Driven through the service with a
// real parent graph that runs a compiled child graph as a node, which is how LangGraph nests subgraphs
// (Deep Agents' subagents arrive the same way, from inside a tool).

import { Annotation, type CompiledGraph, interrupt, StateGraph } from "@langchain/langgraph";
import type { Run, RunFrame, RunKwargs } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { collect, createFixtureDeps, createFixtureResolver } from "../__fixtures__/deps.js";
import { fixtureLangGraphAgent } from "../__fixtures__/lang-graph-binding.js";
import { createContext } from "../context.js";
import { resolveDeps, type GraphSchemas, type ResolvedGraph } from "../deps.js";
import { createProtocolServiceFromContext } from "../service.js";

import { RunControlRegistry } from "./cancellation.js";
import { replyWith } from "./declared-reply.js";
import { executeRun } from "./run-engine.js";

const ValueState = Annotation.Root({
  value: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
});

type Writer = (chunk: unknown) => void;
const writerOf = (config: unknown): Writer | undefined => (config as { writer?: Writer }).writer;

/** A child graph that writes progress — and a declared reply — on the custom stream. */
const childGraph = new StateGraph(ValueState)
  .addNode("work", (state, config) => {
    writerOf(config)?.({ progress: "child working" });
    writerOf(config)?.(replyWith("the child's answer"));
    return { value: `child: ${state.value}` };
  })
  .addEdge("__start__", "work")
  .addEdge("work", "__end__")
  .compile();

/** Runs {@link childGraph} as a node, then declares its own reply at the root. */
function buildParentGraph(rootDeclares: boolean, pauses = false): CompiledGraph<string> {
  const delegated = pauses
    ? new StateGraph(ValueState)
        .addNode("work", (state, config) => {
          writerOf(config)?.({ progress: "awaiting approval" });
          interrupt("approve?");
          return { value: `child: ${state.value}` };
        })
        .addEdge("__start__", "work")
        .addEdge("work", "__end__")
        .compile()
    : childGraph;
  return new StateGraph(ValueState)
    .addNode("delegate", delegated)
    .addNode("finish", (state, config) => {
      if (rootDeclares) writerOf(config)?.(replyWith("the run's answer"));
      return { value: `done: ${state.value}` };
    })
    .addEdge("__start__", "delegate")
    .addEdge("delegate", "finish")
    .addEdge("finish", "__end__")
    .compile() as unknown as CompiledGraph<string>;
}

async function harness() {
  // Local rather than in the shared fixture map: two tests assert that map's exact list of graphs.
  const graphs: Record<string, ResolvedGraph> = {
    parent: fixtureLangGraphAgent(buildParentGraph(true)),
    "parent-silent": fixtureLangGraphAgent(buildParentGraph(false)),
    "parent-pausing": fixtureLangGraphAgent(buildParentGraph(true, true)),
  };
  const resolver = {
    ...createFixtureResolver(),
    ids: Object.keys(graphs),
    load: async (graphId: string): Promise<ResolvedGraph> => graphs[graphId]!,
    schemas: async (graphId: string): Promise<GraphSchemas> =>
      ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
  };
  const deps = createFixtureDeps({ graphs: resolver });
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return { deps, service };
}

const eventNames = (frames: RunFrame[]): string[] =>
  frames.map((frame) =>
    frame.namespace?.length ? `${frame.event}|${frame.namespace.join("|")}` : frame.event,
  );
const namespaced = (frames: RunFrame[]): RunFrame[] =>
  frames.filter((frame) => (frame.namespace?.length ?? 0) > 0);

describe("stream_subgraphs", () => {
  it("keeps subgraph streaming through thread streams and interrupted commands", async () => {
    const { service } = await harness();
    const thread = await service.threads.create();
    const paused = await service.threadStream.stream(thread.thread_id, {
      assistant_id: "parent-pausing",
      input: { value: "hi" },
      stream_mode: ["updates", "custom"],
      stream_subgraphs: true,
    });
    expect(namespaced(await collect(paused.frames)).length).toBeGreaterThan(0);
    expect((await service.threads.get(thread.thread_id)).status).toBe("interrupted");
    const resumed = await service.threadStream.command(thread.thread_id, {
      command: { resume: "yes" },
      stream_mode: ["updates", "custom"],
      stream_subgraphs: true,
    });
    const frames = await collect(resumed.frames);
    expect(frames.some((frame) => frame.namespace?.[0]?.startsWith("delegate:"))).toBe(true);
    expect((await service.threads.get(thread.thread_id)).status).toBe("idle");
  });

  it("streams the subgraph's frames under `mode|<namespace>` names, beside the root's", async () => {
    const { service } = await harness();
    const thread = await service.threads.create();

    const started = await service.runs.createStream({
      thread_id: thread.thread_id,
      assistant_id: "parent",
      input: { value: "hi" },
      stream_mode: ["updates", "custom"],
      stream_subgraphs: true,
    });
    const frames = await collect(started.frames);

    // The child's own node update and custom write, named after the parent node it ran in.
    expect(eventNames(frames)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^updates\|delegate:[\w-]+$/),
        expect.stringMatching(/^custom\|delegate:[\w-]+$/),
      ]),
    );
    // And the root's frames keep their bare names.
    expect(eventNames(frames)).toContain("updates");
    const childCustom = frames.find((frame) => frame.event === "custom" && frame.namespace?.length);
    expect(childCustom?.data).toEqual({ progress: "child working" });
  });

  it("streams no subgraph frames when the run does not ask", async () => {
    const { service } = await harness();
    const thread = await service.threads.create();

    const started = await service.runs.createStream({
      thread_id: thread.thread_id,
      assistant_id: "parent",
      input: { value: "hi" },
      stream_mode: ["updates", "custom"],
    });

    expect(namespaced(await collect(started.frames))).toEqual([]);
  });

  it("replays namespaced frames unchanged to a client that joins the run", async () => {
    const { service } = await harness();
    const thread = await service.threads.create();
    const started = await service.runs.createStream({
      thread_id: thread.thread_id,
      assistant_id: "parent",
      input: { value: "hi" },
      stream_mode: ["updates", "custom"],
      stream_subgraphs: true,
    });
    const live = await collect(started.frames);

    const replayed = await collect(await service.runs.join(started.runId, 0));
    expect(replayed).toEqual(live);
    // And from a `Last-Event-ID` in the middle, the namespaced frames after it are still there.
    const firstNamespaced = namespaced(live)[0]!;
    const resumed = await collect(await service.runs.join(started.runId, firstNamespaced.seq - 1));
    expect(resumed[0]).toEqual(firstNamespaced);
  });

  it("streams subgraph frames in `events` mode too", async () => {
    const { service } = await harness();
    const thread = await service.threads.create();

    const started = await service.runs.createStream({
      thread_id: thread.thread_id,
      assistant_id: "parent",
      input: { value: "hi" },
      stream_mode: ["events", "custom"],
      stream_subgraphs: true,
    });
    const frames = await collect(started.frames);

    expect(eventNames(frames)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^custom\|delegate:[\w-]+$/), "events"]),
    );
  });

  it.each([
    ["stream", ["custom"]],
    ["events", ["events", "custom"]],
  ] as const)(
    "keeps last-write-wins replies independent of subgraph streaming (%s path)",
    async (_path, streamMode) => {
      const { deps } = await harness();
      const resolved = resolveDeps(deps);

      async function replyOf(assistantId: string, subgraphs?: boolean) {
        const thread = await resolved.store.threads.create();
        const run: Run = await resolved.store.runs.create({
          thread_id: thread.thread_id,
          assistant_id: assistantId,
          status: "pending",
        });
        const kwargs: RunKwargs = {
          input: { value: "hi" },
          stream_mode: [...streamMode],
          ...(subgraphs !== undefined ? { stream_subgraphs: subgraphs } : {}),
        };
        const control = new RunControlRegistry().register(run.run_id);
        return (await executeRun(resolved, { run, kwargs, control })).reply;
      }

      for (const subgraphs of [undefined, false, true]) {
        expect(await replyOf("parent", subgraphs)).toBe("the run's answer");
        expect(await replyOf("parent-silent", subgraphs)).toBe("the child's answer");
      }
    },
  );

  it("keeps the flag on a background run's stored kwargs, so the worker honours it", async () => {
    const { deps, service } = await harness();
    const thread = await service.threads.create();

    const run = await service.runs.createBackground(thread.thread_id, {
      assistant_id: "parent",
      input: { value: "hi" },
      stream_subgraphs: true,
    });

    expect((await deps.store.runs.getKwargs(run.run_id))?.stream_subgraphs).toBe(true);
  });
});
