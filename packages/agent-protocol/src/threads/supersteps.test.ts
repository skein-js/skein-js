// `supersteps` on `POST /threads` — seeding a thread's checkpoint history at creation, which is how
// you *import* an existing conversation rather than replaying it through the graph.
//
// The hard part is not the body shape: it is that a brand-new thread has no run to infer a graph from,
// so `loadThreadGraph` cannot help and the graph has to come from `metadata.graph_id`.

import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

async function harness() {
  const deps = createFixtureDeps();
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return { deps, service };
}

const seed = [{ updates: [{ values: { value: "imported" }, as_node: "echo" }] }];

describe("supersteps on thread create", () => {
  it("seeds the thread's state, readable straight back", async () => {
    const { service } = await harness();

    const thread = await service.threads.create({
      metadata: { graph_id: "echo" },
      supersteps: seed,
    });

    const state = await service.threads.getState(thread.thread_id);
    expect(state.values).toMatchObject({ value: "imported" });
  });

  it("mirrors the seeded values onto the thread row", async () => {
    // Without the mirror a plain `GET /threads/{id}` — and `useStream`'s hydration — would show an
    // empty thread until its first run.
    const { deps, service } = await harness();

    const thread = await service.threads.create({
      metadata: { graph_id: "echo" },
      supersteps: seed,
    });

    expect(thread.values).toMatchObject({ value: "imported" });
    expect((await deps.store.threads.get(thread.thread_id))?.values).toMatchObject({
      value: "imported",
    });
  });

  it("applies several supersteps in order", async () => {
    const { service } = await harness();

    const thread = await service.threads.create({
      metadata: { graph_id: "echo" },
      supersteps: [
        { updates: [{ values: { value: "first" }, as_node: "echo" }] },
        { updates: [{ values: { value: "second" }, as_node: "echo" }] },
      ],
    });

    const state = await service.threads.getState(thread.thread_id);
    expect(state.values).toMatchObject({ value: "second" });

    // Each superstep is its own checkpoint, which is the point of seeding history rather than state.
    const history = await service.threads.history(thread.thread_id);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it("400s when no graph_id is available to write against", async () => {
    // A brand-new thread has no run, so there is nothing else to infer the graph from. Same failure
    // `@langchain/langgraph-api` gives.
    const { service } = await harness();

    await expect(service.threads.create({ supersteps: seed })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("creates the thread normally when no supersteps are given", async () => {
    const { service } = await harness();
    const thread = await service.threads.create({ metadata: { graph_id: "echo" } });
    expect(thread.thread_id).toBeTruthy();
  });

  it("applies supersteps to a thread if_exists: do_nothing merely found", async () => {
    // Matches `@langchain/langgraph-api`, which runs its bulk write on whatever `put` returned. Worth
    // pinning because it is the surprising reading: a get-or-create carrying supersteps *appends*.
    const { service } = await harness();
    await service.threads.create({ thread_id: "known", metadata: { graph_id: "echo" } });

    const again = await service.threads.create({
      thread_id: "known",
      metadata: { graph_id: "echo" },
      ifExists: "do_nothing",
      supersteps: seed,
    });

    expect(again.thread_id).toBe("known");
    const state = await service.threads.getState("known");
    expect(state.values).toMatchObject({ value: "imported" });
  });
});
