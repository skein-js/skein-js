// The thread TTL sweeper. What matters here is not that it deletes — it is *how*: through the thread
// service, so an expiring thread's in-flight run is aborted and its runs/checkpoints go with it. A
// driver-level DELETE would leave a run writing into a thread that no longer exists.

import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolHandlers, type ProtocolRequest } from "../create-handlers.js";
import { createProtocolServiceFromContext } from "../service.js";

import { createThreadTtlSweeper } from "./thread-ttl-sweeper.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** A store whose threads expire almost immediately, so a sweep has something to collect. */
async function harness() {
  const store = new MemorySkeinStore({ threadTtl: { defaultTtl: 40 / 60_000 } });
  const deps = { ...createFixtureDeps(), store };
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  const sweeper = createThreadTtlSweeper({ store, threads: service.threads, logger: silentLogger });
  return { store, service, sweeper };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("thread TTL sweeper", () => {
  it("collects an expired thread", async () => {
    const { store, service, sweeper } = await harness();
    const thread = await service.threads.create();

    await wait(120);
    expect(await sweeper.sweepOnce()).toBe(1);
    expect(await store.threads.get(thread.thread_id)).toBeNull();
  });

  it("leaves a thread pinned with ttl: null alone", async () => {
    const { store, sweeper } = await harness();
    const pinned = await store.threads.create({ thread_id: "pinned", ttl: null });

    await wait(120);
    expect(await sweeper.sweepOnce()).toBe(0);
    expect(await store.threads.get(pinned.thread_id)).not.toBeNull();
  });

  it("deletes through the service, so an in-flight run is aborted and its rows go too", async () => {
    // The whole reason this sweeper is not `startStoreTtlSweeper` with a different table.
    const { store, service, sweeper } = await harness();
    const thread = await service.threads.create();
    const run = await store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      status: "running",
      kwargs: {},
    });

    await wait(120);
    expect(await sweeper.sweepOnce()).toBe(1);
    expect(await store.threads.get(thread.thread_id)).toBeNull();
    expect(await store.runs.get(run.run_id)).toBeNull();
  });

  it("keeps going when one thread fails to delete", async () => {
    // A failure at the head of the batch must not block every thread behind it: the sweep reads
    // oldest-expiry-first, so a thread that always throws would starve the rest forever.
    const { store, service, sweeper } = await harness();
    await service.threads.create({ thread_id: "bad" });
    await service.threads.create({ thread_id: "good" });
    const realDelete = service.threads.delete.bind(service.threads);
    vi.spyOn(service.threads, "delete").mockImplementation(async (id: string) => {
      if (id === "bad") throw new Error("nope");
      return realDelete(id);
    });

    await wait(120);
    expect(await sweeper.sweepOnce()).toBe(1);
    expect(await store.threads.get("good")).toBeNull();
    expect(await store.threads.get("bad")).not.toBeNull();
  });

  it("collects nothing when no thread has expired", async () => {
    const { sweeper } = await harness();
    expect(await sweeper.sweepOnce()).toBe(0);
  });

  it("stop() is safe before start(), and start() is idempotent", async () => {
    const { sweeper } = await harness();
    await sweeper.stop();
    sweeper.start();
    sweeper.start();
    await sweeper.stop();
  });
});

describe("thread ttl from the wire", () => {
  /** A store with no configured default, so only an explicit per-thread `ttl` can expire anything. */
  async function noDefaultHarness() {
    const store = new MemorySkeinStore();
    const deps = { ...createFixtureDeps(), store };
    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    return {
      store,
      service,
      handlers: createProtocolHandlers(service),
      sweeper: createThreadTtlSweeper({ store, threads: service.threads, logger: silentLogger }),
    };
  }

  const request = (body: unknown, params: Record<string, string> = {}): ProtocolRequest => ({
    method: "post",
    url: "http://localhost/",
    params,
    query: {},
    body,
    headers: {},
  });

  it("accepts the object ttl the SDK actually sends", async () => {
    // `threads.create({ ttl: 5 })` is normalized by the SDK into `{ ttl: 5, strategy: "delete" }`, so
    // the object form is the one that arrives in practice — the bare number is only in its types.
    const { handlers, sweeper } = await noDefaultHarness();

    await handlers.createThread(
      request({ thread_id: "obj", ttl: { ttl: 40 / 60_000, strategy: "delete" } }),
    );

    await wait(120);
    expect(await sweeper.sweepOnce()).toBe(1);
  });

  it("accepts a bare-number ttl too", async () => {
    const { handlers, sweeper } = await noDefaultHarness();

    await handlers.createThread(request({ thread_id: "num", ttl: 40 / 60_000 }));

    await wait(120);
    expect(await sweeper.sweepOnce()).toBe(1);
  });

  it("leaves a thread alone when the body names no ttl", async () => {
    const { handlers, sweeper } = await noDefaultHarness();

    await handlers.createThread(request({ thread_id: "plain" }));

    await wait(120);
    expect(await sweeper.sweepOnce()).toBe(0);
  });

  it("PATCH can pin a thread with ttl: null", async () => {
    const { handlers, sweeper } = await noDefaultHarness();
    await handlers.createThread(request({ thread_id: "pin", ttl: 40 / 60_000 }));

    await handlers.patchThread(request({ ttl: null }, { thread_id: "pin" }));

    await wait(120);
    expect(await sweeper.sweepOnce()).toBe(0);
  });
});
