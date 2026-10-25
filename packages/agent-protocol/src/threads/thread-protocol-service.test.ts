import type { AuthEngine, AuthFilters, Metadata, ThreadState } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createAuthScopedStore } from "../auth/auth-scoped-store.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

const ownerEngine = {
  matchesFilters: (metadata: Metadata | undefined, filters: AuthFilters) =>
    metadata?.["owner"] === filters["owner"],
  stampFromFilters: (metadata: Metadata | undefined, filters: AuthFilters) => ({
    ...metadata,
    ...filters,
  }),
} as unknown as AuthEngine;

it("filters run visibility for lifecycle and captured state during replay and live delivery", async () => {
  const deps = createFixtureDeps();
  const thread = await deps.store.threads.create({ metadata: { owner: "alice" } });
  const mine = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    metadata: { owner: "alice" },
  });
  const theirs = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    metadata: { owner: "bob" },
  });
  const publish = async (runId: string, value: string) => {
    await deps.threadBus!.publish(thread.thread_id, {
      kind: "state",
      operation: "updated",
      thread,
      runId,
      lifecycle: "start",
    });
    const state: ThreadState = {
      values: { value },
      next: [],
      checkpoint: {
        thread_id: thread.thread_id,
        checkpoint_ns: "",
        checkpoint_id: null,
        checkpoint_map: null,
      },
      metadata: {},
      created_at: null,
      parent_checkpoint: null,
      tasks: [],
    };
    await deps.threadBus!.publish(thread.thread_id, {
      kind: "state",
      operation: "updated",
      thread,
      runId,
      state,
    });
  };
  await publish(theirs.run_id, "hidden replay");
  await publish(mine.run_id, "visible replay");
  const service = createProtocolServiceFromContext(
    createContext({
      ...deps,
      store: createAuthScopedStore(deps.store, ownerEngine, { owner: "alice" }, "threads"),
    }),
  );
  const stopped = new AbortController();
  const iterator = (
    await service.threadStream.follow!(
      thread.thread_id,
      ["lifecycle", "state_update"],
      0,
      stopped.signal,
    )
  )[Symbol.asyncIterator]();
  try {
    await iterator.next();
    expect((await iterator.next()).value).toContain(mine.run_id);
    expect((await iterator.next()).value).toContain("visible replay");
    const reading = iterator.next();
    await publish(theirs.run_id, "hidden live");
    await publish(mine.run_id, "visible live");
    expect((await reading).value).toContain(mine.run_id);
    expect((await iterator.next()).value).toContain("visible live");
  } finally {
    stopped.abort();
    await iterator.return?.();
  }
});

it("filters namespaces and caller visibility during replay and live delivery", async () => {
  const deps = createFixtureDeps();
  const thread = await deps.store.threads.create({ metadata: { owner: "alice" } });
  const mine = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    metadata: { owner: "alice" },
  });
  const theirs = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    metadata: { owner: "bob" },
  });
  const publish = (runId: string, namespace: string[], value: string) =>
    deps.threadBus!.publish(thread.thread_id, {
      kind: "protocol",
      runId,
      event: {
        type: "event",
        method: "values",
        params: { namespace, timestamp: Date.now(), data: { value } },
      },
    });
  await publish(theirs.run_id, ["child:1"], "hidden replay");
  await publish(mine.run_id, ["other:1"], "wrong namespace");
  await publish(mine.run_id, ["child:1"], "visible replay");
  const service = createProtocolServiceFromContext(
    createContext({
      ...deps,
      store: createAuthScopedStore(deps.store, ownerEngine, { owner: "alice" }, "threads"),
    }),
  );
  const controller = new AbortController();
  const stream = await service.threadStream.subscribe!(
    thread.thread_id,
    { channels: ["values"], namespaces: [["child"]], depth: 0, since: 0 },
    controller.signal,
  );
  const iterator = stream[Symbol.asyncIterator]();
  try {
    expect((await iterator.next()).value).toContain(": subscribed");
    expect((await iterator.next()).value).toContain("visible replay");
    await publish(theirs.run_id, ["child:2"], "hidden live");
    await publish(mine.run_id, ["child:2", "nested:1"], "too deep");
    await publish(mine.run_id, ["child:2"], "visible live");
    expect((await iterator.next()).value).toContain("visible live");
  } finally {
    controller.abort();
    await iterator.return?.();
  }
});

it("replays retained publication order before a current state baseline for late selectors", async () => {
  const deps = createFixtureDeps();
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  const thread = await service.threads.create();
  const result = await service.runs.createWait({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    input: { value: "saved" },
  });
  for (const value of ["earlier", "later"])
    await deps.threadBus!.publish(thread.thread_id, {
      kind: "protocol",
      runId: result.runId,
      event: {
        type: "event",
        method: "values",
        params: { namespace: [], timestamp: 0, data: { value } },
      },
    });
  const stopped = new AbortController();
  const stream = await service.threadStream.subscribe!(
    thread.thread_id,
    { channels: ["values"] },
    stopped.signal,
  );
  const iterator = stream[Symbol.asyncIterator]();
  try {
    await iterator.next();
    const frames = [];
    for (let index = 0; index < 3; index++) frames.push(String((await iterator.next()).value));
    expect(frames[0]).toContain("earlier");
    expect(frames[1]).toContain("later");
    expect(frames[2]).toContain("echo: saved");
    const sequences = frames.map((frame) => Number(/^id: (\d+)/.exec(frame)![1]));
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  } finally {
    stopped.abort();
    await iterator.return?.();
  }
});

describe("thread command envelopes", () => {
  it("returns correlated protocol errors without creating runs", async () => {
    const deps = createFixtureDeps();
    const service = createProtocolServiceFromContext(createContext(deps));
    const thread = await service.threads.create();
    expect(
      await service.threadStream.protocolCommand!(thread.thread_id, {
        id: 7,
        method: "unknown",
        params: {},
      }),
    ).toMatchObject({ type: "error", id: 7, error: "unknown_command" });
    expect(
      await service.threadStream.protocolCommand!(thread.thread_id, {
        id: 8,
        method: "input.inject",
        params: {},
      }),
    ).toMatchObject({ type: "error", id: 8, error: "not_supported" });
    expect(await deps.store.runs.listByThread(thread.thread_id)).toEqual([]);
  });

  it("refuses to fork from an unknown checkpoint without copying the thread", async () => {
    const deps = createFixtureDeps();
    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
    });
    const threadsBefore = (await deps.store.threads.list()).length;

    expect(
      await service.threadStream.protocolCommand!(thread.thread_id, {
        id: 9,
        method: "state.fork",
        params: { checkpoint_id: "does-not-exist" },
      }),
    ).toMatchObject({ type: "error", id: 9, error: "no_such_checkpoint" });
    expect(await deps.store.threads.list()).toHaveLength(threadsBefore);
  });

  it("forks a stored checkpoint from a custom agent whose snapshot omits createdAt", async () => {
    const deps = createFixtureDeps();
    const load = deps.graphs.load;
    deps.graphs.load = async (id) => {
      const graph = await load(id);
      if (typeof graph === "function") throw new Error("Expected fixture agent.");
      const custom = Object.create(graph) as typeof graph;
      custom.getState = async function (config, options) {
        const { createdAt: _timestamp, ...snapshot } = await graph.getState.call(
          this,
          config,
          options,
        );
        return snapshot;
      };
      return custom;
    };
    const service = createProtocolServiceFromContext(createContext(deps));
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "saved" },
    });
    const checkpoint = (await deps.checkpointer.getTuple({
      configurable: { thread_id: thread.thread_id, checkpoint_ns: "" },
    }))!.checkpoint;
    expect(
      (await service.threads.getStateAt(thread.thread_id, checkpoint.id)).created_at,
    ).toBeNull();
    expect(
      await service.threadStream.protocolCommand!(thread.thread_id, {
        id: 10,
        method: "state.fork",
        params: { checkpoint_id: checkpoint.id, assistant_id: "echo", input: { value: "forked" } },
      }),
    ).toMatchObject({
      type: "success",
      id: 10,
      result: { thread_id: expect.any(String), run_id: expect.any(String) },
    });
  });
});

it("does not send a stale baseline if a thread incarnation changes during state capture", async () => {
  const deps = createFixtureDeps();
  const context = createContext(deps);
  const service = createProtocolServiceFromContext(context);
  await service.assistants.registerGraphAssistants();
  const thread = await service.threads.create();
  await service.runs.createWait({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    input: { value: "private" },
  });
  const original = deps.graphs.load;
  let captured!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.graphs.load = async (id) => {
    const graph = await original(id);
    if (typeof graph === "function") throw new Error("Expected fixture graph.");
    const wrapped = Object.create(graph) as typeof graph;
    wrapped.getState = async function (config, options) {
      const snapshot = await graph.getState!.call(this, config, options);
      captured();
      await held;
      return snapshot;
    };
    return wrapped;
  };
  const subscribed = service.threadStream.subscribe!(thread.thread_id, { channels: ["values"] });
  await entered;
  await deps.threadBus!.deleteThread(thread.thread_id);
  await deps.threadBus!.publish(thread.thread_id, { kind: "state", operation: "created", thread });
  release();
  const iterator = (await subscribed)[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(true);
  expect(context.threadStreams?.size).toBe(0);
});
