// Time travel over the real Postgres drivers: a graph run, an update-state-at-checkpoint fork, a
// read at a prior checkpoint, and a run forked from a chosen checkpoint — all against the
// `PostgresSaver` checkpointer and the Postgres `SkeinStore` (so the fork target survives a fresh
// `getKwargs` load, the crash-recovery path). Proves the feature is not MemorySaver-specific.

import { Annotation, type CompiledGraph, StateGraph } from "@langchain/langgraph";
import {
  createContext,
  createProtocolServiceFromContext,
  type GraphResolver,
  type GraphSchemas,
  type ProtocolDeps,
} from "@skein-js/agent-protocol";
import { MemoryRunEventBus, MemoryRunQueue } from "@skein-js/storage-memory";
import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectPostgresStore, postgresConnectionOptions, type Disposer } from "./drivers.js";

const ValueState = Annotation.Root({
  value: Annotation<string>({ reducer: (_prev, next) => next, default: () => "" }),
});

/** A real compiled echo graph (`{ value }` state) so runs actually write checkpoints to Postgres. */
const echoGraph = new StateGraph(ValueState)
  .addNode("echo", (state) => ({ value: `echo: ${state.value}` }))
  .addEdge("__start__", "echo")
  .addEdge("echo", "__end__")
  .compile() as unknown as CompiledGraph<string>;

const echoResolver: GraphResolver = {
  ids: ["echo"],
  load: async () => echoGraph,
  schemas: async (graphId): Promise<GraphSchemas> =>
    ({ [graphId]: { graph_id: graphId } }) as unknown as GraphSchemas,
};

let pg: StartedResource;
const disposers: Disposer[] = [];

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);

afterAll(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  await pg?.stop();
});

async function serviceOnPostgres() {
  const { store, checkpointer } = await connectPostgresStore({
    url: pg.url,
    connectionOptions: postgresConnectionOptions(),
    disposers,
  });
  const deps: ProtocolDeps = {
    store,
    checkpointer,
    graphs: echoResolver,
    queue: new MemoryRunQueue(),
    bus: new MemoryRunEventBus(),
  };
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return { service, store };
}

describe("time travel — postgres store + PostgresSaver checkpointer", () => {
  it("forks state at a checkpoint, reads the past, and forks a run from it", async () => {
    const { service, store } = await serviceOnPostgres();
    const thread = await service.threads.create();

    // A run establishes a checkpoint in Postgres.
    const first = await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });
    expect(first).toEqual({ value: "echo: hi" });
    const tip =
      (await service.threads.history(thread.thread_id))[0]?.checkpoint.checkpoint_id ?? undefined;
    expect(typeof tip).toBe("string");

    // Update (fork) state — a brand-new checkpoint id off the tip, persisted via PostgresSaver.
    const { checkpoint } = await service.threads.updateState(thread.thread_id, {
      values: { value: "forked" },
    });
    expect(typeof checkpoint.checkpoint_id).toBe("string");
    expect(checkpoint.checkpoint_id).not.toBe(tip);
    expect((await service.threads.getState(thread.thread_id)).values).toEqual({ value: "forked" });

    // Read state at the pre-fork checkpoint — still the original run's values.
    const past = await service.threads.getStateAt(thread.thread_id, tip!);
    expect(past.values).toEqual({ value: "echo: hi" });

    // A run forks from a chosen checkpoint; its stored kwargs carry the fork target (crash recovery).
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "again" },
      checkpoint_id: tip,
    });
    const runs = await service.runs.listByThread(thread.thread_id);
    const forked = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    const kwargs = await store.runs.getKwargs(forked!.run_id);
    expect(kwargs?.checkpoint_id).toBe(tip);
  });
});
