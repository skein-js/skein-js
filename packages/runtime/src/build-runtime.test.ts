// `buildRuntime`'s all-memory path — the one `skein dev` takes, and the one that returns early before
// most of the durable assembly runs. Config keys have to be threaded onto it deliberately, so anything
// read only in the durable branch below silently does nothing exactly where a user first tries it.
// `store.adapter` was one of those.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { describe, expect, it } from "vitest";

import { buildRuntime } from "./build-runtime.js";

const fixture = (name: string): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", name);

describe("buildRuntime — all-memory (skein dev)", () => {
  it("honours store.adapter, so a bring-your-own store works under `skein dev`", async () => {
    const runtime = await buildRuntime({
      configPath: fixture("langgraph.adapter.json"),
      store: "memory",
      queue: "memory",
    });
    try {
      expect(runtime.deps.storeItems).toBeDefined();

      // And it is the store every reader ends up on: the protocol service resolves the deps, which
      // folds `storeItems` into `store`, so a write through the normal surface lands in the user's store.
      const protocol = createProtocolRuntime(runtime.deps);
      await protocol.service.store.put(["ns"], "k", { v: 1 });

      const { store } = await import("./__fixtures__/store-adapter.js");
      expect((await store.get(["ns"], "k"))?.value).toEqual({ v: 1 });
    } finally {
      await runtime.dispose();
    }
  });

  it("replays hydrated store items through the adapter, where the server will read them", async () => {
    // The driver's `restore()` takes the whole snapshot, but under an adapter its items are unreachable —
    // so a restored `.skein/dev-state.json`, or the one-time `langgraph dev` import, would report success
    // and surface nothing.
    const runtime = await buildRuntime({
      configPath: fixture("langgraph.adapter.json"),
      store: "memory",
      queue: "memory",
    });
    try {
      // Taken from the runtime itself rather than hand-built, so the test cannot drift from the
      // snapshot's real shape — only the one item under test is injected.
      const snapshot = runtime.snapshotState?.();
      if (!snapshot) throw new Error("expected an all-memory runtime to snapshot");
      const at = new Date().toISOString();
      snapshot.store.items = [
        [
          JSON.stringify([["memories"], "note"]),
          {
            namespace: ["memories"],
            key: "note",
            value: { text: "carried over" },
            createdAt: at,
            updatedAt: at,
          },
        ],
      ];

      await runtime.hydrateState?.(snapshot);

      const { store } = await import("./__fixtures__/store-adapter.js");
      expect((await store.get(["memories"], "note"))?.value).toEqual({ text: "carried over" });
    } finally {
      await runtime.dispose();
    }
  });

  it("leaves storeItems unset when no adapter is configured", async () => {
    const runtime = await buildRuntime({
      configPath: fixture("langgraph.json"),
      store: "memory",
      queue: "memory",
    });
    try {
      expect(runtime.deps.storeItems).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });
});
