import { expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolRuntime } from "../runtime.js";

const authBase = {
  enabled: false,
  studioAuthDisabled: false,
  authenticate: async () => undefined,
  matchesFilters: () => true,
};

it("rejects a state target that changes during authorization", async () => {
  const deps = createFixtureDeps();
  deps.graphs = {
    ids: ["allowed", "blocked"],
    schemas: async () => ({}),
    load: async (id) => ({
      async *stream() {
        yield ["values", {}];
      },
      getState: async () => ({ values: { graph: id }, next: [], tasks: [] }),
    }),
  };
  let moveThread: (() => Promise<void>) | undefined;
  deps.auth = {
    ...authBase,
    enabled: true,
    authorize: async ({ value }) => {
      if (moveThread) {
        const move = moveThread;
        moveThread = undefined;
        await move();
      }
      return { value };
    },
  };
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const thread = await runtime.service.threads.create();
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "allowed",
      input: {},
    });
    moveThread = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "blocked",
        input: {},
      });
    };
    const client = runtime.createNativeClient({
      sourceId: "limited",
      allowedAssistants: ["allowed"],
    });
    const options = {
      authContext: {
        user: {
          identity: "reader",
          display_name: "reader",
          is_authenticated: true,
          permissions: [],
        },
        scopes: [],
      },
    };
    await expect(client.getState(thread.thread_id, options)).rejects.toMatchObject({
      code: "native_state_changed",
    });
    await expect(client.getState(thread.thread_id, options)).rejects.toMatchObject({
      code: "assistant_not_allowed",
    });
  } finally {
    await runtime.worker.stop();
  }
});

it("rejects commands that expire during authorization without creating a thread or receipt", async () => {
  let now = new Date("2026-10-25T00:00:00Z");
  const deps = createFixtureDeps({
    clock: () => now,
    auth: {
      ...authBase,
      authorize: async ({ value }) => {
        now = new Date("2026-10-25T00:00:02Z");
        return { value };
      },
    },
  });
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "deadline",
      allowedAssistants: ["echo"],
    });
    await expect(
      client.start(
        { assistant_id: "echo", input: {} },
        {
          idempotencyKey: "late",
          deadlineAt: "2026-10-25T00:00:01Z",
        },
      ),
    ).rejects.toMatchObject({ code: "deadline_expired" });
    expect(await deps.store.threads.search({})).toHaveLength(0);
    await expect(client.getReceipt("late")).rejects.toMatchObject({ code: "receipt_unavailable" });
  } finally {
    await runtime.worker.stop();
  }
});

it("does not confirm execution stop after a swallowed rollback lease failure", async () => {
  const deps = createFixtureDeps({
    threadExecutionGate: {
      acquire: async () => {
        throw new Error("gate unavailable");
      },
    },
  });
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const thread = await deps.store.threads.create();
    const run = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      status: "running",
      kwargs: { base_checkpoint_id: "base" },
    });
    const client = runtime.createNativeClient({
      sourceId: "stop-proof",
      allowedAssistants: ["echo"],
    });
    await expect(
      client.cancel(run.run_id, { action: "rollback", wait: true, idempotencyKey: "cancel" }),
    ).rejects.toMatchObject({ status: 503, code: "execution_stop_unconfirmed" });
    expect(await client.getReceipt("cancel")).toMatchObject({ runId: run.run_id });
    expect((await client.getRun(run.run_id)).status).toBe("cancelled");
  } finally {
    await runtime.worker.stop();
  }
});

it("refuses remote stop confirmation without a cross-instance execution gate", async () => {
  const deps = createFixtureDeps({
    abortChannel: {
      requestAbort: async () => undefined,
      subscribe: () => ({ close: async () => undefined }),
    },
  });
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({ sourceId: "no-gate", allowedAssistants: ["echo"] });
    const receipt = await client.start({ assistant_id: "echo", input: {} });
    await expect(client.cancel(receipt.runId, { wait: true })).rejects.toMatchObject({
      status: 501,
      code: "execution_stop_unsupported",
    });
    expect((await client.getRun(receipt.runId)).status).toBe("pending");
  } finally {
    await runtime.worker.stop();
  }
});

it("rechecks deadlines after displacement preparation without cancelling the predecessor", async () => {
  let now = new Date("2026-10-25T00:00:00Z");
  const deps = createFixtureDeps({ clock: () => now });
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "deadline-lock",
      allowedAssistants: ["echo"],
    });
    const first = await client.start({ assistant_id: "echo", input: {} });
    const listActiveRuns = deps.store.runs.listActiveRuns.bind(deps.store.runs);
    deps.store.runs.listActiveRuns = async (threadId) => {
      now = new Date("2026-10-25T00:00:02Z");
      return listActiveRuns(threadId);
    };
    await expect(
      client.start(
        {
          assistant_id: "echo",
          thread_id: first.threadId,
          input: {},
          multitask_strategy: "interrupt",
        },
        {
          idempotencyKey: "late",
          deadlineAt: "2026-10-25T00:00:01Z",
        },
      ),
    ).rejects.toMatchObject({ code: "deadline_expired" });
    expect((await client.getRun(first.runId)).status).toBe("pending");
    expect(await deps.store.runs.listByThread(first.threadId)).toHaveLength(1);
    await expect(client.getReceipt("late")).rejects.toMatchObject({ code: "receipt_unavailable" });
  } finally {
    await runtime.worker.stop();
  }
});

it("carries deadline expiry through a driver admission wait without committing a receipt", async () => {
  const deps = createFixtureDeps();
  const admitRun = deps.store.admission!.admitRun.bind(deps.store.admission);
  let entered = false;
  deps.store.admission!.admitRun = async (input) => {
    entered = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return admitRun(input);
  };
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "deadline-driver",
      allowedAssistants: ["echo"],
    });
    await expect(
      client.start(
        { assistant_id: "echo", input: {} },
        {
          idempotencyKey: "late",
          deadlineAt: new Date(Date.now() + 300).toISOString(),
        },
      ),
    ).rejects.toMatchObject({ code: "deadline_expired" });
    expect(entered).toBe(true);
    await expect(client.getReceipt("late")).rejects.toMatchObject({ code: "receipt_unavailable" });
    expect(await deps.store.runs.listActiveRuns()).toEqual([]);
  } finally {
    await runtime.worker.stop();
  }
});

it.each(["checkpoint_id", "checkpoint", "if_thread_status", "multitask_strategy", "if_not_exists"])(
  "rejects runtime strict-resume override %s before admission",
  async (field) => {
    const runtime = createProtocolRuntime(createFixtureDeps(), { scheduler: { enabled: false } });
    try {
      await runtime.service.assistants.registerGraphAssistants();
      const client = runtime.createNativeClient({
        sourceId: "strict",
        allowedAssistants: ["interrupting"],
      });
      runtime.worker.start();
      const first = await client.start({ assistant_id: "interrupting", input: {} });
      await expect.poll(async () => (await client.getRun(first.runId)).status).toBe("interrupted");
      const state = await client.getState(first.threadId);
      await expect(
        client.resume(
          {
            assistant_id: "interrupting",
            thread_id: first.threadId,
            expected: { runId: first.runId, checkpoint: state.checkpoint },
            resume: "yes",
            [field]: "untrusted",
          },
          { idempotencyKey: "override" },
        ),
      ).rejects.toMatchObject({ code: "invalid_native_input" });
      await expect(client.getReceipt("override")).rejects.toMatchObject({
        code: "receipt_unavailable",
      });
      const accepted = await client.resume({
        assistant_id: "interrupting",
        thread_id: first.threadId,
        expected: { runId: first.runId, checkpoint: state.checkpoint },
        resume: "yes",
      });
      expect(accepted.runId).not.toBe(first.runId);
    } finally {
      await runtime.worker.stop();
    }
  },
);
