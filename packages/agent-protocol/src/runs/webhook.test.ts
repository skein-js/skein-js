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

    expect(second).toEqual({ value: "echo: two" });
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
