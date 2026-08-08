// The bring-your-own store seam, end to end: `ProtocolDeps.storeItems` must reach *both* access paths —
// the `/store/*` handlers and `getStore()` inside a graph run — because they are two readers of the same
// repo and an adapter that only reached one would be a silent half-substitution.
//
// It also pins the composition itself. The obvious spelling, `{ ...driver, store: mine }`, drops the
// driver's `maxPageSize` and `durable` because both are prototype getters, and both fields are optional
// on the interface so nothing type-checks the mistake. `withStoreItems` exists to make that unspellable.

import { InMemoryStore } from "@langchain/langgraph";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps } from "../deps.js";
import { createProtocolRuntime } from "../runtime.js";

import { fromBaseStore } from "./from-base-store.js";
import { withStoreItems } from "./with-store-items.js";

describe("withStoreItems", () => {
  it("replaces only the memory repo, leaving the other five on the driver", async () => {
    const driver = new MemorySkeinStore();
    const adapted = withStoreItems(driver, fromBaseStore(new InMemoryStore()));

    // A thread still lands on the driver…
    const thread = await adapted.threads.create({});
    expect(await driver.threads.get(thread.thread_id)).not.toBeNull();

    // …while a store item goes to the adapter, and the driver never sees it.
    await adapted.store.put(["ns"], "k", { v: 1 });
    expect(await driver.store.get(["ns"], "k")).toBeNull();
    expect((await adapted.store.get(["ns"], "k"))?.value).toEqual({ v: 1 });
  });

  it("keeps the page bound and durability flag, which are prototype getters", () => {
    const adapted = withStoreItems(
      new MemorySkeinStore({ maxPageSize: 5 }),
      fromBaseStore(new InMemoryStore()),
    );

    expect(adapted.maxPageSize).toBe(5);
    expect(adapted.durable).toBe(false);
  });

  it("keeps driver methods beyond the interface, like the `restore()` bulk loader", () => {
    // An object spread would drop this: `restore()` lives on the prototype and is not on `SkeinStore`, so
    // nothing type-checks its loss — and `skein import-langgraph` duck-types for it, failing with
    // "target store does not support bulk import" on a store that supports it perfectly well.
    const driver = new MemorySkeinStore();
    const adapted = withStoreItems(driver, fromBaseStore(new InMemoryStore()));

    expect(typeof (adapted as unknown as { restore?: unknown }).restore).toBe("function");
  });

  it("does not mutate the store it composes from", async () => {
    const driver = new MemorySkeinStore();
    const adapted = withStoreItems(driver, fromBaseStore(new InMemoryStore()));

    await adapted.store.put(["ns"], "k", { v: 1 });

    // The original still reads its own (empty) repo, so a caller holding it is unaffected.
    expect(await driver.store.get(["ns"], "k")).toBeNull();
  });
});

describe("ProtocolDeps.storeItems", () => {
  it("is folded into deps.store by resolveDeps, so no reader needs to know", async () => {
    const source = new InMemoryStore();
    const resolved = resolveDeps({
      ...createFixtureDeps(),
      storeItems: fromBaseStore(source),
    });

    await resolved.store.store.put(["ns"], "k", { v: 1 });

    // Written through to the adapted store, not the driver's own repo.
    expect((await source.get(["ns"], "k"))?.value).toEqual({ v: 1 });
  });

  it("leaves deps.store alone when no adapter is configured", () => {
    const deps = createFixtureDeps();

    expect(resolveDeps(deps).store).toBe(deps.store);
  });

  it("serves the /store handlers and a graph's getStore() from the same adapter", async () => {
    // The point of the whole seam. `storeGraph` writes `["memories"]/"note"` through `getStore()`; the
    // HTTP handler then reads it back. Both must be looking at the source store, or one path is
    // substituted and the other silently is not.
    const source = new InMemoryStore();
    const runtime = createProtocolRuntime({
      ...createFixtureDeps(),
      storeItems: fromBaseStore(source),
    });
    await runtime.service.assistants.registerGraphAssistants();

    const thread = await runtime.service.threads.create({});
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "store",
      input: { value: "remember me" },
    });

    // Written by the graph, into the adapted store.
    expect((await source.get(["memories"], "note"))?.value).toEqual({ text: "remember me" });

    // And readable back over HTTP, through the same adapter.
    const response = await runtime.handlers.getStoreItem({
      method: "GET",
      url: "http://localhost:2024/store/items",
      params: {},
      query: { namespace: "memories", key: "note" },
      body: undefined,
      headers: {},
    });
    expect((response as { body: { value: unknown } }).body.value).toEqual({ text: "remember me" });
  });
});
