// `checkpointer.ttl` → the drivers' config, and — the part that actually bit — the reloadable
// in-memory runtime reading it at all.
//
// `skein dev` (memory store + memory queue) returns early from `buildRuntime` into
// `loadReloadableInMemoryRuntime`, which builds its own deps. So resolving the block in
// `buildRuntime` alone left thread TTL working under `skein start` and silently doing nothing under
// `skein dev` — a whole-feature gap that only an end-to-end run against a real server surfaced.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadReloadableInMemoryRuntime } from "./in-memory-runtime.js";
import { resolveStoreTtl, resolveThreadTtl } from "./ttl-config.js";

describe("resolveStoreTtl", () => {
  it("maps the store block, including refresh_on_read", () => {
    expect(resolveStoreTtl({ default_ttl: 30, refresh_on_read: false })).toEqual({
      defaultTtl: 30,
      refreshOnRead: false,
    });
  });

  it("is undefined when unset", () => {
    expect(resolveStoreTtl(undefined)).toBeUndefined();
    expect(resolveStoreTtl({})).toBeUndefined();
  });
});

describe("resolveThreadTtl", () => {
  it("maps snake_case minutes onto the driver config", () => {
    expect(resolveThreadTtl({ default_ttl: 30, sweep_interval_minutes: 5 })).toEqual({
      defaultTtl: 30,
      sweepIntervalMinutes: 5,
    });
  });

  it("is undefined when unset, so nothing expires and no sweeper starts", () => {
    expect(resolveThreadTtl(undefined)).toBeUndefined();
    expect(resolveThreadTtl({})).toBeUndefined();
    expect(resolveThreadTtl({ strategy: "delete" })).toBeUndefined();
  });

  it("keeps a partial block partial", () => {
    expect(resolveThreadTtl({ default_ttl: 30 })).toEqual({ defaultTtl: 30 });
  });
});

/** A throwaway project directory with one graph and the given `langgraph.json` extras. */
async function project(extra: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skein-ttl-"));
  await writeFile(
    path.join(dir, "graph.ts"),
    `import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
     export const graph = new StateGraph(MessagesAnnotation)
       .addNode("noop", () => ({ messages: [] }))
       .addEdge("__start__", "noop")
       .addEdge("noop", "__end__")
       .compile();`,
  );
  const configPath = path.join(dir, "langgraph.json");
  await writeFile(
    configPath,
    JSON.stringify({ graphs: { echo: "./graph.ts:graph" }, ...extra }, null, 2),
  );
  return configPath;
}

describe("the reloadable in-memory runtime (the `skein dev` path)", () => {
  it("carries the thread TTL on its deps, so the sweeper starts", async () => {
    const configPath = await project({
      checkpointer: { ttl: { default_ttl: 30, sweep_interval_minutes: 5 } },
    });

    const runtime = await loadReloadableInMemoryRuntime(configPath);

    expect(runtime.deps.threadTtl).toEqual({ defaultTtl: 30, sweepIntervalMinutes: 5 });
  });

  it("gives its store the TTL, so a thread created with none still expires", async () => {
    // Both halves are needed and they are separate: deps start the sweeper, the store is what stamps
    // a new thread's expiry. Wiring only the first gives a sweeper that finds nothing, forever.
    const configPath = await project({
      checkpointer: { ttl: { default_ttl: 40 / 60_000 } },
    });

    const runtime = await loadReloadableInMemoryRuntime(configPath);
    const thread = await runtime.deps.store.threads.create();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(
      await runtime.deps.store.threads.listExpired({
        now: new Date().toISOString(),
        limit: 10,
      }),
    ).toEqual([thread.thread_id]);
  });

  it("reads store.ttl as well as checkpointer.ttl", async () => {
    // The dev path used to read neither, then only the thread one. Honouring a config block on
    // `skein start` and dropping it on `skein dev` is the failure mode this module exists to prevent,
    // so both are pinned together.
    const configPath = await project({
      store: { ttl: { default_ttl: 40 / 60_000 } },
      checkpointer: { ttl: { default_ttl: 40 / 60_000 } },
    });

    const runtime = await loadReloadableInMemoryRuntime(configPath);
    await runtime.deps.store.store.put(["ns"], "k", { v: 1 });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(await runtime.deps.store.store.get(["ns"], "k")).toBeNull();
  });

  it("re-stamps restored threads so a dev restart does not make them immortal", async () => {
    // `hydrate` replaces the thread map wholesale. Leaving the expiry map untouched left every
    // restored thread un-expirable for the life of the process, silently.
    const configPath = await project({ checkpointer: { ttl: { default_ttl: 40 / 60_000 } } });
    const first = await loadReloadableInMemoryRuntime(configPath);
    const thread = await first.deps.store.threads.create();
    const snapshot = first.snapshotState();

    const restored = await loadReloadableInMemoryRuntime(configPath);
    restored.hydrateState(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(
      await restored.deps.store.threads.listExpired({ now: new Date().toISOString(), limit: 10 }),
    ).toEqual([thread.thread_id]);
  });

  it("leaves both alone when no ttl is configured", async () => {
    const configPath = await project({});

    const runtime = await loadReloadableInMemoryRuntime(configPath);
    await runtime.deps.store.threads.create();

    expect(runtime.deps.threadTtl).toBeUndefined();
    expect(
      await runtime.deps.store.threads.listExpired({ now: new Date().toISOString(), limit: 10 }),
    ).toEqual([]);
  });
});
