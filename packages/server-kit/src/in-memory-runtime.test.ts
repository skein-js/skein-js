// The dep surface `skein dev` actually runs on.
//
// `loadReloadableInMemoryRuntime` used to hand-assemble its `ProtocolDeps`, and drifted from
// `embedInMemoryGraphs` without anything noticing: it never set `storeBridge`, `cloneCheckpoint` or
// `ephemeralCheckpointer`. The engine reaches all three optionally, so nothing threw — long-term
// memory writes from a node simply vanished, a thread copy aliased the source thread's checkpoint,
// and `POST /invoke/:graph_id` had no saver. These tests pin the surface and, more importantly, prove
// a node can actually reach the store, which is the part a shape assertion alone would have missed.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { afterAll, describe, expect, it } from "vitest";

import { loadReloadableInMemoryRuntime } from "./in-memory-runtime.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

// The documented accessor, from docs/state-and-context.md: a node reaches long-term memory through
// `config.store`. It *throws* on a missing store rather than skipping, because a silent skip is
// exactly how this bug stayed invisible — `examples/triage-agent` guarded with `if (store)` and its
// sweeps reported success against an empty store.
const rememberGraph = `
import { Annotation, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";

const State = Annotation.Root({
  value: Annotation({ reducer: (_prev, next) => next, default: () => "" }),
});

export const graph = new StateGraph(State)
  .addNode("remember", async (state, config) => {
    const store = (config as LangGraphRunnableConfig).store;
    if (!store) throw new Error("no store on the node's config");
    await store.put(["memories"], "note", { text: state.value });
    const item = await store.get(["memories"], "note");
    return { value: "stored: " + (item?.value?.text ?? "?") };
  })
  .addEdge("__start__", "remember")
  .addEdge("remember", "__end__")
  .compile();
`;

/** A throwaway project holding one graph, loaded the way `skein dev` loads it. */
async function project(graphSource: string): Promise<string> {
  // Inside the workspace, not `os.tmpdir()`: the graph imports `@langchain/langgraph`, and node
  // resolution only finds it by walking up to the repo's `node_modules`.
  const dir = await mkdtemp(path.join(process.cwd(), ".tmp-dev-runtime-"));
  created.push(dir);
  await writeFile(path.join(dir, "graph.ts"), graphSource);
  const configPath = path.join(dir, "langgraph.json");
  await writeFile(
    configPath,
    JSON.stringify({ graphs: { remember: "./graph.ts:graph" } }, null, 2),
  );
  return configPath;
}

describe("loadReloadableInMemoryRuntime", () => {
  it("carries the deps that bind the engine to LangGraph", async () => {
    const runtime = await loadReloadableInMemoryRuntime(await project(rememberGraph));

    // Each of these was absent, and each failure it caused was silent. Asserted by name rather than
    // through behaviour so the next omission fails here, on the cheap test, as well as end to end.
    expect(runtime.deps.storeBridge).toBeTypeOf("function");
    expect(runtime.deps.cloneCheckpoint).toBeTypeOf("function");
    expect(runtime.deps.ephemeralCheckpointer).toBeTypeOf("function");
    // The drivers the path has always had, so a refactor can't quietly drop them either.
    expect(runtime.deps.store).toBeDefined();
    expect(runtime.deps.queue).toBeDefined();
    expect(runtime.deps.bus).toBeDefined();
    expect(runtime.deps.checkpointer).toBeDefined();
  });

  it("lets a graph node write to the long-term store through `config.store`", async () => {
    const runtime = await loadReloadableInMemoryRuntime(await project(rememberGraph));
    const protocol = createProtocolRuntime(runtime.deps);
    await protocol.service.assistants.registerGraphAssistants();

    const thread = await protocol.service.threads.create();
    const { result } = await protocol.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "remember",
      input: { value: "hello" },
    });

    // The round trip proves the bridge is attached: the node read back what it had just written.
    expect(result).toMatchObject({ value: "stored: hello" });
    // And the item is really in the protocol store — the symptom in the original report was
    // `POST /store/namespaces` answering `{"namespaces":[]}` after a run that reported success.
    expect(await runtime.deps.store.store.listNamespaces()).toEqual([["memories"]]);
  });

  it("still snapshots, hydrates and reloads around the overridden drivers", async () => {
    const configPath = await project(rememberGraph);
    const runtime = await loadReloadableInMemoryRuntime(configPath);
    await runtime.deps.store.store.put(["memories"], "note", { text: "before" });

    const snapshot = runtime.snapshotState();
    expect(snapshot.store.items?.length ?? 0).toBeGreaterThan(0);

    // A fresh runtime starts empty, then takes the snapshot on — the cross-restart path `skein dev`
    // uses. Both only work because the store and checkpointer are the instances held on this path.
    const restored = await loadReloadableInMemoryRuntime(configPath);
    expect(await restored.deps.store.store.get(["memories"], "note")).toBeNull();
    restored.hydrateState(snapshot);
    expect(await restored.deps.store.store.get(["memories"], "note")).toMatchObject({
      value: { text: "before" },
    });

    // Reload reroutes graph loads without touching the drivers, so the hydrated item survives it.
    await restored.reloadGraphs();
    expect(await restored.deps.store.store.get(["memories"], "note")).not.toBeNull();
    expect(restored.deps.graphs.ids).toEqual(["remember"]);
  });
});
