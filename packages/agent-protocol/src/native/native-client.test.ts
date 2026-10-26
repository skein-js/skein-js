import { SkeinHttpError, type AuthContext, type AuthEngine } from "@skein-js/core";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolRuntime, type ProtocolRuntime } from "../runtime.js";

const runtimes: ProtocolRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.worker.stop()));
});
async function fixture() {
  const deps = createFixtureDeps();
  const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
  runtimes.push(runtime);
  await runtime.service.assistants.registerGraphAssistants();
  return {
    deps,
    runtime,
    client: runtime.createNativeClient({
      sourceId: "fixture",
      allowedAssistants: ["echo", "interrupting", "slow"],
    }),
  };
}

describe("native admission", () => {
  it("does not invoke a graph when cancellation wins the pending-to-running transition", async () => {
    const stream = vi.fn(async function* () {
      yield ["values", {}];
    });
    const deps = createFixtureDeps();
    deps.graphs = {
      ids: ["race"],
      schemas: async () => ({}),
      load: async () => ({ stream, getState: async () => ({ values: {}, next: [], tasks: [] }) }),
    };
    const setStatus = deps.store.runs.setStatus.bind(deps.store.runs);
    let raced = false;
    deps.store.runs.setStatus = async (id, status, error) => {
      if (status === "running") {
        raced = true;
        await deps.store.runs.settle!(id, { status: "cancelled" });
      }
      return setStatus(id, status, error);
    };
    const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
    runtimes.push(runtime);
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({ sourceId: "race", allowedAssistants: ["race"] });
    const receipt = await client.start({ assistant_id: "race", input: {} });
    runtime.worker.start();
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe("cancelled");
    expect(raced).toBe(true);
    expect(stream).not.toHaveBeenCalled();
  });
  it("stops admission when the held lease is lost during intervening authorization", async () => {
    const lost = new AbortController();
    const auth: AuthEngine = {
      enabled: false,
      studioAuthDisabled: false,
      authenticate: async () => undefined,
      matchesFilters: () => true,
      authorize: async ({ value }) => {
        if ((value as { command?: unknown })?.command)
          lost.abort(new Error("lost during authorization"));
        return { value };
      },
    };
    const deps = createFixtureDeps({
      auth,
      threadExecutionGate: {
        acquire: async () => ({ signal: lost.signal, release: async () => undefined }),
      },
    });
    const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
    runtimes.push(runtime);
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "lease-loss",
      allowedAssistants: ["interrupting"],
    });
    runtime.worker.start();
    const receipt = await client.start({ assistant_id: "interrupting", input: {} });
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe("interrupted");
    const checkpoint = (await client.getResult(receipt.runId)).checkpoint!;
    await expect(
      client.resume(
        {
          assistant_id: "interrupting",
          thread_id: receipt.threadId,
          expected: { runId: receipt.runId, checkpoint },
          resume: "answer",
        },
        { idempotencyKey: "answer" },
      ),
    ).rejects.toMatchObject({ code: "execution_lease_lost" });
    expect(await deps.store.runs.listByThread(receipt.threadId)).toHaveLength(1);
    await expect(client.getReceipt("answer")).rejects.toMatchObject({
      code: "receipt_unavailable",
    });
  });
  it("honors an inherited execution duration while retaining the admitted native outcome", async () => {
    const deps = createFixtureDeps();
    const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
    runtimes.push(runtime);
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "duration",
      allowedAssistants: ["slow"],
    });
    const receipt = await client.start(
      { assistant_id: "slow", input: {}, timeout_ms: 20 },
      { idempotencyKey: "duration" },
    );
    runtime.worker.start();
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe("timeout");
    expect(await client.getReceipt("duration")).toMatchObject({ runId: receipt.runId });
    expect(await deps.store.runs.getKwargs(receipt.runId)).toMatchObject({ timeout_ms: 20 });
  });

  it.each(["throwing", "slow"])("records complete native %s outcomes", async (assistantId) => {
    const deps = createFixtureDeps({ runTimeoutMs: 25 });
    const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
    runtimes.push(runtime);
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: assistantId,
      allowedAssistants: [assistantId],
      outcomeTarget: "https://receiver.example/outcome",
    });
    const receipt = await client.start({ assistant_id: assistantId, input: {} });
    runtime.worker.start();
    const status = assistantId === "slow" ? "timeout" : "error";
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe(status);
    expect((await deps.store.deliveries!.listByRun(receipt.runId))[0]).toMatchObject({
      run_status: status,
      status: "pending",
      attempt: 0,
    });
    expect(await client.getResult(receipt.runId)).toMatchObject({ values: {} });
  });

  it("preserves a successful status when output cannot be serialized", async () => {
    const deps = createFixtureDeps();
    deps.graphs = {
      ids: ["opaque"],
      schemas: async () => ({}),
      load: async () => ({
        async *stream() {
          yield ["values", {}];
        },
        async getState() {
          return { values: { opaque: BigInt(1) }, next: [], tasks: [] };
        },
      }),
    };
    const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
    runtimes.push(runtime);
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "opaque",
      allowedAssistants: ["opaque"],
      outcomeTarget: "https://receiver.example/outcome",
    });
    const receipt = await client.start({ assistant_id: "opaque", input: {} });
    runtime.worker.start();
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe("success");
    await expect(client.getResult(receipt.runId)).rejects.toMatchObject({
      code: "run_result_unavailable",
    });
    expect((await deps.store.deliveries!.listByRun(receipt.runId))[0]).toMatchObject({
      run_status: "success",
      payload: { result_unavailable: true },
    });
  });

  it("retains results while excluding live native obligations from snapshots and copies", async () => {
    const { runtime, deps } = await fixture();
    const client = runtime.createNativeClient({
      sourceId: "snapshot",
      allowedAssistants: ["echo"],
      outcomeTarget: "https://receiver.example/outcome",
    });
    const receipt = await client.start({ assistant_id: "echo", input: { value: "retained" } });
    runtime.worker.start();
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe("success");
    const store = deps.store as MemorySkeinStore;
    const snapshot = store.snapshot();
    const kwargs = snapshot.runKwargs.find(([id]) => id === receipt.runId)![1];
    expect(kwargs).not.toHaveProperty("native_origin");
    expect(kwargs).not.toHaveProperty("terminal_delivery");
    expect(kwargs).not.toHaveProperty("webhook");
    const target = new MemorySkeinStore();
    target.hydrate(snapshot);
    expect(
      await target.admission.claimDispatches({
        now: new Date().toISOString(),
        leaseUntil: new Date(Date.now() + 1000).toISOString(),
      }),
    ).toHaveLength(0);
    expect(await target.runs.getResult!(receipt.runId)).toEqual(
      await client.getResult(receipt.runId),
    );
    const copy = await runtime.service.threads.copy(receipt.threadId);
    const copied = (await store.runs.listByThread(copy.thread_id))[0]!;
    expect(await store.runs.getKwargs(copied.run_id)).not.toHaveProperty("native_origin");
    expect(await store.runs.getKwargs(copied.run_id)).not.toHaveProperty("webhook");
    expect(await store.runs.getResult!(copied.run_id)).toMatchObject({
      values: { value: "echo: retained" },
    });
  });

  it("enforces an admitted deadline before dispatch without extending the receipt", async () => {
    let now = new Date("2026-10-25T00:00:00.000Z");
    const deps = createFixtureDeps({ clock: () => now });
    const runtime = createProtocolRuntime(deps, { scheduler: { enabled: false } });
    runtimes.push(runtime);
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({
      sourceId: "deadline",
      allowedAssistants: ["echo"],
      outcomeTarget: "https://receiver.example/outcome",
    });
    const receipt = await client.start(
      { assistant_id: "echo", input: { value: "expired" }, after_seconds: 60 },
      { idempotencyKey: "expires", deadlineAt: "2026-10-25T00:00:01.000Z" },
    );
    now = new Date("2026-10-25T00:00:02.000Z");
    runtime.worker.start();
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe("timeout");
    expect(await client.getReceipt("expires")).toEqual(receipt);
    expect((await deps.store.deliveries!.listByRun(receipt.runId))[0]!.run_status).toBe("timeout");
  });

  it("can wait again after an earlier cancellation acknowledgement", async () => {
    const { runtime, client } = await fixture();
    runtime.worker.start();
    const receipt = await client.start({ assistant_id: "slow", input: {} });
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe("running");
    await client.cancel(receipt.runId, { idempotencyKey: "cancel" });
    expect(
      await client.cancel(receipt.runId, { idempotencyKey: "cancel", wait: true }),
    ).toMatchObject({ status: "cancelled", stopped: true });
  });
  it("resumes exactly one expected interrupt, replays admission and rejects stale answers", async () => {
    const { client, runtime, deps } = await fixture();
    runtime.worker.start();
    const first = await client.start({ assistant_id: "interrupting", input: {} });
    await expect.poll(async () => (await client.getRun(first.runId)).status).toBe("interrupted");
    const state = await client.getState(first.threadId);
    expect(state.checkpoint?.checkpoint_id).toBeTruthy();
    const input = {
      assistant_id: "interrupting",
      thread_id: first.threadId,
      expected: { runId: first.runId, checkpoint: state.checkpoint! },
      resume: "approved",
      timeout_ms: 1000,
    };
    const [a, b] = await Promise.allSettled([
      client.resume(input, { idempotencyKey: "answer-a" }),
      client.resume(input, { idempotencyKey: "answer-b" }),
    ]);
    const accepted = [a, b].find((answer) => answer.status === "fulfilled");
    expect([a, b].filter((answer) => answer.status === "fulfilled")).toHaveLength(1);
    if (accepted?.status !== "fulfilled") throw new Error("Missing admitted resume");
    await expect
      .poll(async () => (await client.getRun(accepted.value.runId)).status)
      .toBe("success");
    expect(await deps.store.runs.getKwargs(accepted.value.runId)).toMatchObject({
      timeout_ms: 1000,
    });
    expect((await client.getResult(accepted.value.runId)).values).toMatchObject({
      value: "resumed: approved",
    });
    expect(await client.resume(input, { idempotencyKey: accepted.value.idempotencyKey })).toEqual(
      accepted.value,
    );
    await expect(client.resume(input, { idempotencyKey: "stale" })).rejects.toMatchObject({
      code: "stale_resume",
    });
  });

  it("keeps concurrent principals and sources isolated and reauthorizes receipt reads", async () => {
    const authContext = (identity: string): AuthContext => ({
      user: { identity, display_name: identity, is_authenticated: true, permissions: [] },
      scopes: [],
    });
    let revoked = false;
    const auth: AuthEngine = {
      enabled: true,
      studioAuthDisabled: false,
      authenticate: async () => undefined,
      authorize: async ({ context, value }) => {
        if (revoked) throw SkeinHttpError.forbidden("revoked");
        return { value, filters: { owner: context!.user.identity } };
      },
      matchesFilters: (metadata, filters) => metadata?.["owner"] === filters?.["owner"],
    };
    const runtime = createProtocolRuntime(createFixtureDeps({ auth }), {
      scheduler: { enabled: false },
    });
    runtimes.push(runtime);
    await runtime.service.assistants.registerGraphAssistants();
    const client = runtime.createNativeClient({ sourceId: "shared", allowedAssistants: ["echo"] });
    const [a, b] = await Promise.all(
      ["alice", "bob"].map((identity) =>
        client.start(
          { assistant_id: "echo", metadata: { owner: "forged" } },
          { authContext: authContext(identity), idempotencyKey: "same" },
        ),
      ),
    );
    expect(a!.runId).not.toBe(b!.runId);
    expect(
      (await client.getRun(a!.runId, { authContext: authContext("alice") })).metadata,
    ).toMatchObject({ owner: "alice" });
    await expect(
      client.getRun(a!.runId, { authContext: authContext("bob") }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.getResult(a!.runId, { authContext: authContext("bob") }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(client.getReceipt("same")).rejects.toMatchObject({ status: 401 });
    const otherSource = runtime.createNativeClient({
      sourceId: "other",
      allowedAssistants: ["echo"],
    });
    await expect(
      otherSource.getReceipt("same", { authContext: authContext("alice") }),
    ).rejects.toMatchObject({ code: "receipt_unavailable" });
    await runtime.service.threads.patch(a!.threadId, { metadata: { owner: "transferred" } });
    await expect(
      client.getReceipt("same", { authContext: authContext("alice") }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      client.getResult(a!.runId, { authContext: authContext("alice") }),
    ).rejects.toMatchObject({ status: 404 });
    revoked = true;
    await expect(
      client.getReceipt("same", { authContext: authContext("alice") }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("recovers the original route and absolute budget using the adapter's original command", async () => {
    const { client, deps } = await fixture();
    const options = {
      idempotencyKey: "routed",
      idempotencyInput: { intent: "approve" },
      deadlineAt: "2030-01-01T00:00:00.000Z",
    };
    const first = await client.start({ assistant_id: "echo" }, options);
    expect(
      await client.start(
        { assistant_id: "slow" },
        { ...options, deadlineAt: "2040-01-01T00:00:00.000Z" },
      ),
    ).toEqual(first);
    expect((await deps.store.runs.get(first.runId))?.assistant_id).toBe("echo");
    expect(await deps.store.runs.getKwargs(first.runId)).toMatchObject({
      native_origin: { deadlineAt: options.deadlineAt },
    });
    await expect(
      client.start(
        { assistant_id: "echo" },
        { ...options, idempotencyInput: { intent: "changed" } },
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });

  it("closes the HTTP background receipt-recording gap using the same atomic admission", async () => {
    const { deps, runtime } = await fixture();
    const thread = await runtime.service.threads.create();
    const record = deps.store.idempotency.record;
    deps.store.idempotency.record = async () => {
      throw new Error("lost response recording");
    };
    const request = {
      method: "POST",
      url: `http://localhost/threads/${thread.thread_id}/runs`,
      params: { thread_id: thread.thread_id },
      query: {},
      headers: { "idempotency-key": "http-lost" },
      body: { assistant_id: "echo" },
    };
    const first = await runtime.handlers.createBackgroundRun(request);
    deps.store.idempotency.record = record;
    const next = await runtime.handlers.createBackgroundRun({ ...request });
    expect(next).toMatchObject({
      body: { run_id: (first as { body: { run_id: string } }).body.run_id },
    });
    expect(await deps.store.runs.listByThread(thread.thread_id)).toHaveLength(1);
  });
  it("replays one accepted run before and after execution, including concurrent calls", async () => {
    const { deps, runtime, client } = await fixture();
    const receipts = await Promise.all(
      Array.from({ length: 6 }, () =>
        client.start(
          { assistant_id: "echo", input: { value: "original" } },
          { idempotencyKey: "one" },
        ),
      ),
    );
    expect(new Set(receipts.map((receipt) => receipt.runId)).size).toBe(1);
    expect(await deps.store.runs.listByThread(receipts[0]!.threadId)).toHaveLength(1);
    runtime.worker.start();
    await expect.poll(async () => (await client.getRun(receipts[0]!.runId)).status).toBe("success");
    expect((await client.getResult(receipts[0]!.runId)).values).toMatchObject({
      value: "echo: original",
    });
    expect(await client.getReceipt("one")).toEqual(receipts[0]);
    await expect(
      client.start(
        { assistant_id: "echo", input: { value: "different" } },
        { idempotencyKey: "one" },
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });
  });

  it("retains acceptance when enqueue fails and recovers owned dispatch", async () => {
    const { deps, runtime, client } = await fixture();
    const enqueue = deps.queue.enqueue.bind(deps.queue);
    deps.queue.enqueue = async () => {
      throw new Error("queue unavailable");
    };
    const receipt = await client.start(
      { assistant_id: "echo", input: { value: "recovered" } },
      { idempotencyKey: "lost-ack" },
    );
    expect(await client.getReceipt("lost-ack")).toEqual(receipt);
    deps.queue.enqueue = enqueue;
    runtime.worker.start();
    await expect.poll(async () => (await client.getRun(receipt.runId)).status).toBe("success");
  });

  it("records a pending cancellation outcome without executing the graph", async () => {
    const { deps, runtime } = await fixture();
    const client = runtime.createNativeClient({
      sourceId: "cancel",
      allowedAssistants: ["echo"],
      outcomeTarget: "https://receiver.example/outcomes",
    });
    const receipt = await client.start({ assistant_id: "echo", input: { value: "never" } });
    const cancelled = await client.cancel(receipt.runId, { idempotencyKey: "cancel" });
    expect(cancelled).toMatchObject({ status: "cancelled", stopped: true });
    const deliveries = await deps.store.deliveries!.listByRun(receipt.runId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.run_status).toBe("cancelled");
    await expect(client.getResult(receipt.runId)).rejects.toMatchObject({
      code: "run_result_unavailable",
    });
  });

  it("bounds graphs and preserves trusted absolute deadlines", async () => {
    const { runtime, client } = await fixture();
    await expect(client.start({ assistant_id: "throwing" })).rejects.toMatchObject({ status: 403 });
    await expect(
      client.start({ assistant_id: "echo" }, { deadlineAt: "2000-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "deadline_expired" });
    const empty = runtime.createNativeClient({ sourceId: "empty", allowedAssistants: [] });
    await expect(empty.start({ assistant_id: "echo" })).rejects.toMatchObject({ status: 403 });
    const seeded = await runtime.service.threads.create({
      metadata: { graph_id: "throwing", assistant_id: "echo" },
    });
    await expect(client.getState(seeded.thread_id)).rejects.toMatchObject({
      code: "assistant_not_allowed",
    });
    const pending = await client.start({ assistant_id: "echo", input: {} });
    await expect(
      client.cancel(pending.runId, { deadlineAt: "2000-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "deadline_expired" });
    expect((await client.getRun(pending.runId)).status).toBe("pending");
  });
});
