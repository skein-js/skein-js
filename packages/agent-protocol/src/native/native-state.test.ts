import type { RunRepo } from "@skein-js/core";
import { expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolRuntime } from "../runtime.js";

it("preserves prototype repository methods and private-field receivers in a frozen state read", async () => {
  const deps = createFixtureDeps();
  const original = deps.store.runs;
  class FactoryRuns {
    readonly #inner = original;
    getKwargs(runId: string) {
      return this.#inner.getKwargs(runId);
    }
  }
  for (const [name, method] of Object.entries(original)) {
    if (name !== "getKwargs" && typeof method === "function")
      Object.defineProperty(FactoryRuns.prototype, name, { value: method.bind(original) });
  }
  deps.store = Object.freeze({
    ...deps.store,
    runs: Object.freeze(new FactoryRuns()) as unknown as RunRepo,
  });
  deps.graphs = {
    ids: ["factory"],
    schemas: async () => ({}),
    load:
      async () =>
      async ({ configurable }) => ({
        async *stream() {
          yield ["values", {}];
        },
        getState: async () => ({
          values: { variant: configurable?.["variant"] },
          next: [],
          tasks: [],
        }),
      }),
  };
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const thread = await deps.store.threads.create();
    await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "factory",
      status: "success",
      kwargs: { config: { configurable: { variant: "saved" } } },
    });
    const client = runtime.createNativeClient({
      sourceId: "third-party",
      allowedAssistants: ["factory"],
    });
    expect((await client.getState(thread.thread_id)).values).toEqual({ variant: "saved" });
  } finally {
    await runtime.worker.stop();
  }
});

it("freezes the authorized assistant and preserves factory config and the requesting principal", async () => {
  const deps = createFixtureDeps();
  let moveThread: (() => Promise<void>) | undefined;
  let factoryConfig: Record<string, unknown> | undefined;
  deps.graphs = {
    ids: ["allowed", "blocked"],
    schemas: async () => ({}),
    load: async (id) => {
      if (moveThread) {
        const move = moveThread;
        moveThread = undefined;
        await move();
      }
      expect(id).toBe("allowed");
      return async ({ configurable }) => {
        factoryConfig = configurable;
        return {
          async *stream() {
            yield ["values", {}];
          },
          getState: async () => ({ values: { graph: id }, next: [], tasks: [] }),
        };
      };
    },
  };
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const thread = await deps.store.threads.create();
    await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "allowed",
      status: "success",
      kwargs: {
        config: { configurable: { variant: "saved", thread_id: "forged", __secret: "forged" } },
        auth_user: {
          identity: "last-writer",
          display_name: "Writer",
          is_authenticated: true,
          permissions: [],
        },
        auth_scopes: ["last-writer-scope"],
      },
    });
    moveThread = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await deps.store.runs.create({
        thread_id: thread.thread_id,
        assistant_id: "blocked",
        status: "pending",
      });
    };
    const client = runtime.createNativeClient({
      sourceId: "fixed",
      allowedAssistants: ["allowed"],
    });
    const user = {
      identity: "reader",
      display_name: "Reader",
      is_authenticated: true,
      permissions: [],
    };
    expect(
      (await client.getState(thread.thread_id, { authContext: { user, scopes: ["read"] } })).values,
    ).toEqual({ graph: "allowed" });
    expect(factoryConfig).toMatchObject({
      variant: "saved",
      langgraph_auth_user: user,
      langgraph_auth_permissions: ["read"],
    });
    expect(factoryConfig).not.toHaveProperty("thread_id");
    expect(factoryConfig).not.toHaveProperty("__secret");
    await expect(
      client.getState(thread.thread_id, { authContext: { user, scopes: ["read"] } }),
    ).rejects.toMatchObject({ code: "assistant_not_allowed" });
  } finally {
    await runtime.worker.stop();
  }
});

it("checks the real metadata fallback when the latest assistant is missing", async () => {
  const deps = createFixtureDeps();
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const thread = await deps.store.threads.create({ metadata: { graph_id: "slow" } });
    await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "deleted-assistant",
      status: "success",
    });
    const client = runtime.createNativeClient({
      sourceId: "fallback",
      allowedAssistants: ["deleted-assistant"],
    });
    await expect(client.getState(thread.thread_id)).rejects.toMatchObject({
      code: "assistant_not_allowed",
    });
  } finally {
    await runtime.worker.stop();
  }
});

it("rejects a state target changed while acquiring the execution lease", async () => {
  const deps = createFixtureDeps();
  const thread = await deps.store.threads.create();
  await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "echo",
    status: "success",
  });
  deps.threadExecutionGate = {
    acquire: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await deps.store.runs.create({
        thread_id: thread.thread_id,
        assistant_id: "slow",
        status: "pending",
      });
      return { release: async () => undefined };
    },
  };
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "lease-race",
      allowedAssistants: ["echo"],
    });
    await expect(client.getState(thread.thread_id)).rejects.toMatchObject({
      code: "native_state_changed",
    });
  } finally {
    await runtime.worker.stop();
  }
});
