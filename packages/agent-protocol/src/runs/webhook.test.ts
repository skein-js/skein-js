// Run-completion webhooks: the engine POSTs the settled run to the run's `webhook` URL once it
// reaches a terminal status, via the injected `webhookDispatcher`. Best-effort — a delivery failure
// is logged, never fails the run.

import type { Run, RunKwargs } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps, type ProtocolDeps, type WebhookDispatcher } from "../deps.js";

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
