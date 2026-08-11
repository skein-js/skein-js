// Run-completion webhooks: the engine POSTs the settled run to the run's `webhook` URL once it
// reaches a terminal status, via the injected `webhookDispatcher`. Best-effort — a delivery failure
// is logged, never fails the run.

import type { Run, RunKwargs } from "@skein-js/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import {
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  resolveDeps,
  type ProtocolDeps,
  type WebhookDispatcher,
} from "../deps.js";
import { createProtocolServiceFromContext } from "../service.js";

import { RunControlRegistry } from "./cancellation.js";
import { executeRun } from "./run-engine.js";

async function seed(overrides: Partial<ProtocolDeps>, graphId = "echo", kwargs: RunKwargs = {}) {
  const deps = resolveDeps(createFixtureDeps(overrides));
  const assistant = await deps.store.assistants.create({
    graph_id: graphId,
    assistant_id: graphId,
  });
  const thread = await deps.store.threads.create();
  const run: Run = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: assistant.assistant_id,
    status: "pending",
  });
  const control = new RunControlRegistry().register(run.run_id);
  return { deps, run, control, kwargs };
}

describe("run-completion webhooks", () => {
  it("POSTs the settled run to the webhook URL on success", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
    });

    await executeRun(deps, { run, kwargs, control });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [url, payload] = dispatch.mock.calls[0]!;
    expect(url).toBe("https://example.test/hook");
    expect(payload).toMatchObject({
      run_id: run.run_id,
      status: "success",
      values: { value: "echo: hi" },
    });
    const body = payload as Record<string, unknown>;
    expect(typeof body["run_started_at"]).toBe("string");
    expect(typeof body["run_ended_at"]).toBe("string");
    expect(typeof body["webhook_sent_at"]).toBe("string");
  });

  it("includes the error message when the run fails", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "throwing", {
      input: {},
      webhook: "https://example.test/hook",
    });

    await executeRun(deps, { run, kwargs, control });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ status: "error", error: "boom" });
  });

  it("does not fire when no webhook is set", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
    });

    await executeRun(deps, { run, kwargs, control });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("a delivery failure is swallowed — the run still settles", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockRejectedValue(new Error("network down"));
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
    });

    const outcome = await executeRun(deps, { run, kwargs, control });
    expect(outcome.status).toBe("success");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("the default dispatcher rejects non-http(s) schemes (SSRF hardening)", async () => {
    const dispatcher = resolveDeps(createFixtureDeps()).webhookDispatcher;
    await expect(dispatcher("file:///etc/passwd", {})).rejects.toThrow(/not allowed/);
    await expect(dispatcher("not-a-url", {})).rejects.toThrow(/valid absolute URL/);
  });
});

// The engine's `finally` runs inside the thread's execution lock. Awaiting the webhook there meant a
// target that takes 30s to answer made every other run on the thread wait 30s behind it — and held the
// finished run's whole final state alive meanwhile. `startRunExecution` awaits it after the lock.
describe("webhook delivery and the thread lock", () => {
  /** A dispatcher that never settles, plus a promise that resolves once it has been called. */
  function hangingDispatcher() {
    let called: () => void = () => {};
    const wasCalled = new Promise<void>((resolve) => {
      called = resolve;
    });
    const dispatch = vi.fn<WebhookDispatcher>(() => {
      called();
      return new Promise<void>(() => {});
    });
    return { dispatch, wasCalled };
  }

  it("lets a second run on the same thread proceed while a webhook hangs", async () => {
    const { dispatch, wasCalled } = hangingDispatcher();
    const deps = createFixtureDeps({ webhookDispatcher: dispatch });
    const ctx = createContext(deps);
    const service = createProtocolServiceFromContext(ctx);
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();

    // First run has a webhook that will hang. Not awaited — under the old behaviour it never settles.
    const first = service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "one" },
      webhook: "https://example.test/hook",
    });
    await wasCalled;

    // The lock must already be free: this resolves while the first run's delivery is still hanging.
    const second = await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "two" },
    });

    expect(second.result).toEqual({ value: "echo: two" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    void first;
  });

  // Deferring must not turn delivery into fire-and-forget: shutdown would then exit mid-POST.
  it("still awaits the delivery before the run settles", async () => {
    let release: () => void = () => {};
    const delivered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.fn<WebhookDispatcher>(() => delivered);
    const ctx = createContext(createFixtureDeps({ webhookDispatcher: dispatch }));
    const service = createProtocolServiceFromContext(ctx);
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();

    let settled = false;
    const run = service.runs
      .createWait({
        thread_id: thread.thread_id,
        assistant_id: "echo",
        input: { value: "hi" },
        webhook: "https://example.test/hook",
      })
      .then((value) => {
        settled = true;
        return value;
      });

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(settled).toBe(false);

    release();
    await run;
    expect(settled).toBe(true);
  });

  // The engine hands the delivery over from its own `finally`, which runs on the failure path too. A
  // store write there (the terminal status, the thread mirror) can itself reject — and a delivery
  // awaited on the success path would then be silently dropped, exactly when the receiver watching for
  // failures most needs it.
  it("still delivers when the run's own failure handling throws", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const deps = createFixtureDeps({ webhookDispatcher: dispatch });
    // Break the thread mirror, which the engine writes after a graph failure.
    const update = deps.store.threads.update.bind(deps.store.threads);
    deps.store.threads.update = async (threadId, patch) => {
      if (patch.status === "error") throw new Error("store unavailable");
      return update(threadId, patch);
    };
    const ctx = createContext(deps);
    const service = createProtocolServiceFromContext(ctx);
    await service.assistants.registerGraphAssistants();
    const thread = await service.threads.create();

    await expect(
      service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "throwing",
        input: {},
        webhook: "https://example.test/hook",
      }),
    ).rejects.toThrow();

    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

// The outbox: on a driver with a `deliveries` repo, the callback is recorded in the *same write* as
// the run's terminal status, and the POST above is merely the first attempt at a row that already
// exists. That is the whole difference between "we tried to tell you" and "we will tell you".
describe("the run-completion outbox", () => {
  it("records the delivery alongside the run's terminal status", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
    });

    await executeRun(deps, { run, kwargs, control });

    const [delivery] = await deps.store.deliveries!.listByRun(run.run_id);
    expect(delivery).toMatchObject({
      run_id: run.run_id,
      thread_id: run.thread_id,
      url: "https://example.test/hook",
      run_status: "success",
      // Delivered on the inline attempt, so the payload is already cleared.
      status: "delivered",
      payload: null,
    });
  });

  it("keeps a failed delivery for the worker instead of losing it", async () => {
    // Today this is where a notification disappears: the POST fails, the failure is logged, and
    // nothing remembers a callback was owed.
    const dispatch = vi.fn<WebhookDispatcher>().mockRejectedValue(new Error("receiver is down"));
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
    });

    const outcome = await executeRun(deps, { run, kwargs, control });

    expect(outcome.status).toBe("success");
    const [delivery] = await deps.store.deliveries!.listByRun(run.run_id);
    expect(delivery).toMatchObject({ status: "pending", last_error: "receiver is down" });
    // The payload survives, because a retry has to have something to send.
    expect(delivery?.payload).toMatchObject({ run_id: run.run_id });
  });

  // The race the whole `run_status` column exists for. A cancel lands while the graph is finishing;
  // it owns the run's status, so the callback has to report *its* verdict — a receiver that reads the
  // run back a millisecond later must not find it saying something else.
  it("stamps the delivery with the winner's status when a cancel beat the engine", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
    });
    // Stand in for `cancelRun`, which writes the terminal status with a bare `setStatus` and
    // deliberately races the engine: the moment the run goes `running`, the cancel lands on top.
    // Hooked on that write rather than left to timing, so the race is the same on every run of this
    // suite.
    const setStatus = deps.store.runs.setStatus.bind(deps.store.runs);
    vi.spyOn(deps.store.runs, "setStatus").mockImplementation(async (runId, status, error) => {
      const written = await setStatus(runId, status, error);
      if (status === "running") await setStatus(runId, "cancelled");
      return written;
    });

    await executeRun(deps, { run, kwargs, control });

    const [delivery] = await deps.store.deliveries!.listByRun(run.run_id);
    expect(delivery?.run_status).toBe("cancelled");
    expect((await deps.store.runs.get(run.run_id))?.status).toBe("cancelled");
    // And the body the receiver got agrees with the row, rather than with what the engine intended.
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ status: "cancelled" });
  });

  it("records nothing for a run that carries no webhook", async () => {
    const { deps, run, control, kwargs } = await seed({}, "echo", { input: { value: "hi" } });

    await executeRun(deps, { run, kwargs, control });

    expect(await deps.store.deliveries!.listByRun(run.run_id)).toEqual([]);
  });

  it("falls back to one best-effort POST on a store with no deliveries repo", async () => {
    // A third-party driver that has not adopted the outbox keeps working, with today's semantics.
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
    });
    const withoutOutbox = {
      ...deps,
      store: Object.assign(Object.create(Object.getPrototypeOf(deps.store) as object), deps.store, {
        deliveries: undefined,
        runs: { ...deps.store.runs, finalizeWithDelivery: undefined },
      }),
    } as typeof deps;

    const outcome = await executeRun(withoutOutbox, { run, kwargs, control });

    expect(outcome.status).toBe("success");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ status: "success", values: {} });
    expect(await deps.store.deliveries!.listByRun(run.run_id)).toEqual([]);
  });

  // Regression: `settleRun` can be reached twice — anything after the first one (the thread mirror's
  // write, most likely) can throw, and the catch settles the run again. The status write is
  // idempotent, but the delivery insert is deliberately unconditional, so the second pass recorded a
  // *second* callback with a different id: two notifications for one run, one announcing a success
  // that never happened, and `X-Skein-Delivery-Id` powerless against them because the ids differ.
  it("records exactly one delivery even when settling the run twice", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
    });
    // Blow up after the run has been finalized, exactly where the thread mirror writes.
    const update = deps.store.threads.update.bind(deps.store.threads);
    let mirrored = false;
    vi.spyOn(deps.store.threads, "update").mockImplementation(async (threadId, patch) => {
      if (!mirrored) {
        mirrored = true;
        throw new Error("thread mirror failed");
      }
      return update(threadId, patch);
    });

    await executeRun(deps, { run, kwargs, control });

    const deliveries = await deps.store.deliveries!.listByRun(run.run_id);
    expect(deliveries).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // Regression: building the payload serializes it, and that now happens *before* the run's status is
  // written. A final state carrying a BigInt threw from there, so a successful run was recorded as
  // `error` — the callback machinery deciding the run's outcome, which it must never do.
  it("does not fail a run whose final state cannot be serialized", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockResolvedValue(undefined);
    const { deps, run, control, kwargs } = await seed({ webhookDispatcher: dispatch }, "echo", {
      input: { value: "hi" },
      webhook: "https://example.test/hook",
    });
    // Thrown only for the delivery body, so the store's own serialization is unaffected — this
    // stands in for a final state carrying a BigInt or a cycle.
    const stringify = JSON.stringify.bind(JSON);
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...rest) => {
      if (value !== null && typeof value === "object" && "run_started_at" in value) {
        throw new TypeError("Do not know how to serialize a BigInt");
      }
      return stringify(value, ...(rest as []));
    });

    let outcome;
    try {
      outcome = await executeRun(deps, { run, kwargs, control });
    } finally {
      // Restored here rather than in an `afterEach`: a global stub on `JSON.stringify` that outlives
      // this case breaks every test after it, in ways that look nothing like this one.
      spy.mockRestore();
    }

    // The run is what it was. Losing the callback is the acceptable half of this trade.
    expect(outcome.status).toBe("success");
    expect((await deps.store.runs.get(run.run_id))?.status).toBe("success");
    expect(await deps.store.deliveries!.listByRun(run.run_id)).toEqual([]);
  });

  it("truncates an oversized payload inside the body, and says so on the row", async () => {
    const dispatch = vi.fn<WebhookDispatcher>().mockRejectedValue(new Error("down"));
    const { deps, run, control, kwargs } = await seed(
      { webhookDispatcher: dispatch, webhooks: { maxPayloadBytes: 200 } },
      "echo",
      { input: { value: "x".repeat(1_000) }, webhook: "https://example.test/hook" },
    );

    await executeRun(deps, { run, kwargs, control });

    const [delivery] = await deps.store.deliveries!.listByRun(run.run_id);
    expect(delivery?.payload_truncated).toBe(true);
    expect((delivery?.payload as { values: unknown }).values).toMatchObject({
      $skein_truncated: true,
    });
  });
});

// The default dispatcher's timeout. Untested, this is the fragile part of the change: the friendly
// message depends on undici surfacing `AbortSignal.timeout`'s reason as a `TimeoutError`, and if a
// future runtime wraps it differently the degradation is silent — a raw DOMException in a warn line.
describe("default webhook dispatcher timeout", () => {
  const realFetch = globalThis.fetch;
  const realEnv = process.env["SKEIN_WEBHOOK_TIMEOUT_MS"];

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEnv === undefined) delete process.env["SKEIN_WEBHOOK_TIMEOUT_MS"];
    else process.env["SKEIN_WEBHOOK_TIMEOUT_MS"] = realEnv;
  });

  /** Drive the *default* dispatcher (no injected one) and return what it threw, if anything. */
  async function deliverWith(fetchImpl: typeof globalThis.fetch): Promise<unknown> {
    globalThis.fetch = fetchImpl;
    const deps = resolveDeps(createFixtureDeps());
    return await deps.webhookDispatcher("https://example.test/hook", { ok: true }).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it("passes an abort signal to fetch, bounded by the configured timeout", async () => {
    process.env["SKEIN_WEBHOOK_TIMEOUT_MS"] = "1234";
    let seen: RequestInit | undefined;

    await deliverWith((async (_url: string, init: RequestInit) => {
      seen = init;
      return { ok: true, status: 200 };
    }) as unknown as typeof globalThis.fetch);

    expect(seen?.signal).toBeDefined();
    expect(seen?.signal?.aborted).toBe(false);
  });

  it("reports a timeout as a timeout, keeping the original as `cause`", async () => {
    process.env["SKEIN_WEBHOOK_TIMEOUT_MS"] = "1234";
    const aborted = new DOMException("The operation was aborted due to timeout", "TimeoutError");

    const error = await deliverWith((() => Promise.reject(aborted)) as typeof globalThis.fetch);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("timed out after 1234ms");
    expect((error as Error).cause).toBe(aborted);
  });

  it("lets a non-timeout failure through unchanged", async () => {
    const refused = new TypeError("fetch failed");

    const error = await deliverWith((() => Promise.reject(refused)) as typeof globalThis.fetch);

    expect(error).toBe(refused);
  });

  // A bad value falls back rather than throwing: this runs inside a best-effort delivery whose failure
  // is only logged, so throwing would replace a working default with silence.
  it("falls back to the default on a malformed timeout", async () => {
    process.env["SKEIN_WEBHOOK_TIMEOUT_MS"] = "soon";
    const aborted = new DOMException("aborted", "TimeoutError");

    const error = await deliverWith((() => Promise.reject(aborted)) as typeof globalThis.fetch);

    expect((error as Error).message).toContain(`timed out after ${DEFAULT_WEBHOOK_TIMEOUT_MS}ms`);
  });
});
