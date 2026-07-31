// The run endpoints added to complete the SDK surface: `POST /runs` (stateless background),
// `POST /runs/batch`, `POST /runs/cancel` (cancelMany), plus the two things every run-create response
// gained — a `Content-Location` header and honoured `on_completion`.
//
// Asserted through the *handler table* rather than the service where the wire shape is the point (a
// header, a status code, a body key), because that is the layer the SDK actually talks to.

import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import {
  createProtocolHandlers,
  type ProtocolRequest,
  type ProtocolResponse,
} from "../create-handlers.js";
import { createProtocolServiceFromContext } from "../service.js";

async function harness(deps = createFixtureDeps()) {
  const ctx = createContext(deps);
  const service = createProtocolServiceFromContext(ctx);
  await service.assistants.registerGraphAssistants();
  return { ctx, deps, service, handlers: createProtocolHandlers(service) };
}

function request(overrides: Partial<ProtocolRequest> = {}): ProtocolRequest {
  return {
    method: "post",
    url: "http://localhost/",
    params: {},
    query: {},
    body: {},
    headers: {},
    ...overrides,
  };
}

/** The JSON body of a handler response, narrowed so assertions read as the value rather than a cast. */
const bodyOf = <T>(response: ProtocolResponse): T => {
  if (response.kind !== "json") throw new Error(`expected a json response, got "${response.kind}"`);
  return response.body as T;
};

/** Poll until `predicate` holds — the background worker settles a run asynchronously. */
async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("POST /runs (stateless background run)", () => {
  it("creates its own thread, leaves the run pending, and queues it", async () => {
    const { deps, handlers } = await harness();
    const threadsBefore = (await deps.store.threads.list()).length;

    const response = await handlers.createStatelessRun(
      request({ body: { assistant_id: "echo", input: { value: "hi" } } }),
    );

    expect(response.status).toBe(200);
    const run = (response as { body: { run_id: string; thread_id: string; status: string } }).body;
    expect(run.status).toBe("pending");
    // The server made the thread — the caller named none.
    expect((await deps.store.threads.list()).length).toBe(threadsBefore + 1);
    expect(await deps.store.threads.get(run.thread_id)).not.toBeNull();
  });

  it("ignores a body thread_id rather than becoming the thread-scoped endpoint", async () => {
    // `POST /threads/{id}/runs` 404s an unknown thread; honouring a body id here would give callers a
    // second door onto that resource with none of the same contract.
    const { deps, handlers } = await harness();

    const response = await handlers.createStatelessRun(
      request({ body: { assistant_id: "echo", thread_id: "not-a-real-thread", input: {} } }),
    );

    const run = (response as { body: { thread_id: string } }).body;
    expect(run.thread_id).not.toBe("not-a-real-thread");
    expect(await deps.store.threads.get("not-a-real-thread")).toBeNull();
  });

  it("404s an unknown assistant without leaving an orphaned thread behind", async () => {
    const { deps, handlers } = await harness();
    const before = (await deps.store.threads.list()).length;

    await expect(
      handlers.createStatelessRun(request({ body: { assistant_id: "ghost", input: {} } })),
    ).rejects.toMatchObject({ status: 404 });
    expect((await deps.store.threads.list()).length).toBe(before);
  });
});

describe("POST /runs/batch", () => {
  it("creates one run per payload, each on its own thread", async () => {
    const { deps, handlers } = await harness();

    const response = await handlers.createRunBatch(
      request({
        body: [
          { assistant_id: "echo", input: { value: "one" } },
          { assistant_id: "echo", input: { value: "two" } },
        ],
      }),
    );

    const runs = (response as { body: { run_id: string; thread_id: string }[] }).body;
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.thread_id)).size).toBe(2);
    // Both are queued for the worker, not executed inline.
    const statuses = await Promise.all(
      runs.map(async (run) => (await deps.store.runs.get(run.run_id))?.status),
    );
    expect(statuses).toEqual(["pending", "pending"]);
  });

  it("rejects an empty batch and one past the cap", async () => {
    // Bounded deliberately: every element is a thread + a run row + a queue job, so an unbounded array
    // is an N-fold write amplifier on one request.
    const { handlers } = await harness();

    await expect(handlers.createRunBatch(request({ body: [] }))).rejects.toMatchObject({
      status: 400,
    });
    const tooMany = Array.from({ length: 101 }, () => ({ assistant_id: "echo", input: {} }));
    await expect(handlers.createRunBatch(request({ body: tooMany }))).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("Content-Location on run creation", () => {
  // The SDK parses this header (`getRunMetadataFromResponse`) to fire `onRunCreated`, which is what
  // `useStream` stores to rejoin a stream after a remount. Without it that callback never fires.
  it("names the created run on the stateless, wait, and thread-scoped responses", async () => {
    const { service, handlers } = await harness();
    const thread = await service.threads.create();

    const stateless = await handlers.createStatelessRun(
      request({ body: { assistant_id: "echo", input: {} } }),
    );
    const statelessRun = (stateless as { body: { run_id: string; thread_id: string } }).body;
    expect(stateless.headers?.["content-location"]).toBe(
      `/threads/${statelessRun.thread_id}/runs/${statelessRun.run_id}`,
    );

    const waited = await handlers.createWaitRun(
      request({ body: { assistant_id: "echo", input: { value: "hi" } } }),
    );
    // A wait run's body is the graph's state, so the ids are only reachable through the header.
    expect(waited.headers?.["content-location"]).toMatch(/^\/threads\/.+\/runs\/.+$/);

    const background = await handlers.createBackgroundRun(
      request({
        params: { thread_id: thread.thread_id },
        body: { assistant_id: "echo", input: {} },
      }),
    );
    const backgroundRun = (background as { body: { run_id: string } }).body;
    expect(background.headers?.["content-location"]).toBe(
      `/threads/${thread.thread_id}/runs/${backgroundRun.run_id}`,
    );
  });

  it("names the run on a streaming response too", async () => {
    const { handlers } = await harness();
    const response = await handlers.createStreamRun(
      request({ body: { assistant_id: "echo", input: { value: "hi" }, stream_mode: "values" } }),
    );

    expect(response.kind).toBe("sse");
    expect(response.headers?.["content-location"]).toMatch(/^\/threads\/.+\/runs\/.+$/);
    // Drain so the run settles rather than leaking into the next test.
    if (response.kind === "sse") for await (const _frame of response.events) void _frame;
  });
});

describe("on_completion", () => {
  it("deletes a stateless run's thread when asked to", async () => {
    const { deps, service } = await harness();

    const { threadId } = await service.runs.createWait({
      assistant_id: "echo",
      input: { value: "hi" },
      on_completion: "delete",
    });

    expect(await deps.store.threads.get(threadId)).toBeNull();
  });

  it("keeps the thread by default", async () => {
    // skein's default differs from LangGraph's `delete` on purpose: a stateless run stays inspectable,
    // and adding the field must not change what /runs/wait already did.
    const { deps, service } = await harness();

    const { threadId } = await service.runs.createWait({
      assistant_id: "echo",
      input: { value: "hi" },
    });

    expect(await deps.store.threads.get(threadId)).not.toBeNull();
  });

  it("never touches a thread the caller named", async () => {
    const { deps, service } = await harness();
    const thread = await service.threads.create();

    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "hi" },
      on_completion: "delete",
    });

    expect(await deps.store.threads.get(thread.thread_id)).not.toBeNull();
  });

  it("keeps the thread of an interrupted run, whose state is the point of the turn", async () => {
    const { deps, service } = await harness();

    const { threadId, runId } = await service.runs.createWait({
      assistant_id: "interrupting",
      input: { value: "hi" },
      on_completion: "delete",
    });

    expect((await deps.store.runs.get(runId))?.status).toBe("interrupted");
    expect(await deps.store.threads.get(threadId)).not.toBeNull();
  });
});

describe("POST /runs/cancel (cancelMany)", () => {
  it("cancels the named runs and skips ids that do not exist", async () => {
    const { deps, service, handlers } = await harness();
    const first = await service.threads.create();
    const second = await service.threads.create();
    const runA = await service.runs.createBackground(first.thread_id, { assistant_id: "echo" });
    const runB = await service.runs.createBackground(second.thread_id, { assistant_id: "echo" });

    const response = await handlers.cancelManyRuns(
      request({ body: { run_ids: [runA.run_id, runB.run_id, "ghost"] } }),
    );

    const body = (response as { body: { cancelled_count: number; cancelled_run_ids: string[] } })
      .body;
    expect(body.cancelled_count).toBe(2);
    expect(body.cancelled_run_ids.sort()).toEqual([runA.run_id, runB.run_id].sort());
    expect((await deps.store.runs.get(runA.run_id))?.status).toBe("cancelled");
    expect((await deps.store.runs.get(runB.run_id))?.status).toBe("cancelled");
  });

  it("cancels only the named thread's inflight runs", async () => {
    const { deps, service, handlers } = await harness();
    const target = await service.threads.create();
    const other = await service.threads.create();
    const doomed = await service.runs.createBackground(target.thread_id, { assistant_id: "echo" });
    const spared = await service.runs.createBackground(other.thread_id, { assistant_id: "echo" });

    await handlers.cancelManyRuns(request({ body: { thread_id: target.thread_id } }));

    expect((await deps.store.runs.get(doomed.run_id))?.status).toBe("cancelled");
    expect((await deps.store.runs.get(spared.run_id))?.status).toBe("pending");
  });

  it("sweeps every inflight run when the body names no target", async () => {
    const { deps, service, handlers } = await harness();
    const first = await service.threads.create();
    const second = await service.threads.create();
    const runA = await service.runs.createBackground(first.thread_id, { assistant_id: "echo" });
    const runB = await service.runs.createBackground(second.thread_id, { assistant_id: "echo" });

    const response = await handlers.cancelManyRuns(request({ body: {} }));

    const body = (response as { body: { cancelled_count: number; truncated: boolean } }).body;
    expect(body.cancelled_count).toBe(2);
    // The page bound was nowhere near hit, so the caller is not told to sweep again.
    expect(body.truncated).toBe(false);
    expect((await deps.store.runs.get(runA.run_id))?.status).toBe("cancelled");
    expect((await deps.store.runs.get(runB.run_id))?.status).toBe("cancelled");
  });

  it("reports truncation when the sweep fills the store's page bound", async () => {
    // "I cancelled everything I saw" is not "everything is cancelled". Derived from the sweep's own
    // read, so the answer says nothing about runs belonging to anyone else — a *count* of every
    // inflight run on the server cannot be ownership-scoped (the concurrency guard it comes from must
    // see other principals' runs by design), so it must never reach a client.
    const deps = createFixtureDeps({ store: new MemorySkeinStore({ maxPageSize: 2 }) });
    const { service, handlers } = await harness(deps);
    for (let index = 0; index < 3; index += 1) {
      const thread = await service.threads.create();
      await service.runs.createBackground(thread.thread_id, { assistant_id: "echo" });
    }

    const response = await handlers.cancelManyRuns(request({ body: {} }));

    const body = (response as { body: { cancelled_count: number; truncated: boolean } }).body;
    expect(body.cancelled_count).toBe(2);
    expect(body.truncated).toBe(true);
    // The third run is untouched and the caller is told to come back for it, without being told how
    // many runs — or whose — are left.
    expect(Object.keys(body)).toEqual(["cancelled_count", "cancelled_run_ids", "truncated"]);
    expect((await deps.store.runs.listActiveRuns()).length).toBe(1);
  });

  it("narrows the sweep to a single status", async () => {
    const { deps, service, handlers } = await harness();
    const thread = await service.threads.create();
    const pending = await service.runs.createBackground(thread.thread_id, { assistant_id: "echo" });
    const running = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      status: "running",
    });

    await handlers.cancelManyRuns(request({ body: { status: "running" } }));

    expect((await deps.store.runs.get(running.run_id))?.status).toBe("cancelled");
    expect((await deps.store.runs.get(pending.run_id))?.status).toBe("pending");
  });

  it("cancels nothing for an explicitly empty run_ids, rather than sweeping the server", async () => {
    // The most destructive possible reading of `run_ids: []` — the natural encoding for a client looping
    // over a filtered array — would be "cancel everything running". It means the set it names: none.
    const { deps, service, handlers } = await harness();
    const thread = await service.threads.create();
    const spared = await service.runs.createBackground(thread.thread_id, { assistant_id: "echo" });

    const response = await handlers.cancelManyRuns(request({ body: { run_ids: [] } }));

    expect(bodyOf<{ cancelled_count: number }>(response).cancelled_count).toBe(0);
    expect((await deps.store.runs.get(spared.run_id))?.status).toBe("pending");
  });

  it("404s a thread that does not exist rather than silently sweeping nothing", async () => {
    const { handlers } = await harness();
    await expect(
      handlers.cancelManyRuns(request({ body: { thread_id: "ghost" } })),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("cancel ?action / ?wait", () => {
  it("discards the run's writes on action=rollback", async () => {
    const { ctx, deps, service, handlers } = await harness();
    const thread = await service.threads.create();
    // A completed run establishes checkpoint history the rollback must trim back to.
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "one" },
    });
    const baseline = (await service.threads.history(thread.thread_id)).length;

    // A run mid-flight, with a recorded base checkpoint — the state a rollback needs.
    const running = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      status: "running",
    });
    const base =
      (await service.threads.history(thread.thread_id))[0]?.checkpoint.checkpoint_id ?? undefined;
    ctx.runBaseCheckpoints.set(running.run_id, base);

    await handlers.cancelRun(
      request({ params: { run_id: running.run_id }, query: { action: "rollback" } }),
    );

    // The history is intact up to the base, and the rolled-back run's row is gone.
    expect((await service.threads.history(thread.thread_id)).length).toBe(baseline);
    expect(await deps.store.runs.get(running.run_id)).toBeNull();
  });

  it("keeps the run's writes on the default action=interrupt", async () => {
    const { deps, service, handlers } = await harness();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "one" },
    });
    const baseline = (await service.threads.history(thread.thread_id)).length;
    const running = await deps.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      status: "running",
    });

    await handlers.cancelRun(request({ params: { run_id: running.run_id } }));

    expect((await service.threads.history(thread.thread_id)).length).toBe(baseline);
    // The row survives, marked cancelled — the difference from rollback.
    expect((await deps.store.runs.get(running.run_id))?.status).toBe("cancelled");
  });

  it("returns only once an executing run's engine has unwound when wait=1", async () => {
    const { ctx, deps, service, handlers } = await harness();
    const thread = await service.threads.create();
    // `slow` blocks until aborted, so the run is genuinely mid-execution when the cancel lands.
    const { runId, frames } = await service.runs.createStream({
      thread_id: thread.thread_id,
      assistant_id: "slow",
      input: {},
    });
    await waitFor(async () => (await deps.store.runs.get(runId))?.status === "running");

    await handlers.cancelRun(request({ params: { run_id: runId }, query: { wait: "1" } }));

    // Both of these are the *engine's* doing, in the `finally` that runs as it unwinds — deliberately
    // not the terminal run row or the idle thread, which `cancel` writes itself before it waits and
    // which would therefore hold whether the wait worked or not.
    expect(ctx.control.isTracking(runId)).toBe(false);
    // The bus is closed, so the stream has already ended: draining it completes rather than
    // live-tailing until the graph's own 10s timer.
    await expect(
      Promise.race([
        (async () => {
          for await (const _frame of frames) void _frame;
          return "ended";
        })(),
        new Promise((resolve) => setTimeout(() => resolve("still open"), 500)),
      ]),
    ).resolves.toBe("ended");
  });
});
