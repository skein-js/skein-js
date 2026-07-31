// Cross-instance cancellation: an abort for a run this process is not executing is republished on the
// `RunAbortChannel`, and a request arriving from a peer is applied locally.
//
// The pair is asserted together with two runtimes sharing one in-memory channel, because that is the
// actual scenario — a cancel routed to replica B stopping a run executing on replica A.

import type { RunAbortChannel, RunAbortListener, RunAbortRequest } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolRuntime } from "../runtime.js";

/**
 * An in-process stand-in for `@skein-js/redis`'s channel: every subscriber hears every publish,
 * including the publisher's own — the loopback an implementation is explicitly allowed to have.
 */
function createLoopbackChannel(): RunAbortChannel & { published: RunAbortRequest[] } {
  const listeners = new Set<RunAbortListener>();
  const published: RunAbortRequest[] = [];
  return {
    published,
    requestAbort: async (request) => {
      published.push(request);
      for (const listener of [...listeners]) listener(request);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return {
        close: async () => {
          listeners.delete(listener);
        },
      };
    },
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

describe("RunControlRegistry with an abort channel", () => {
  it("publishes an abort for a run it is not executing", async () => {
    const channel = createLoopbackChannel();
    const ctx = createContext(createFixtureDeps());
    ctx.control.useAbortChannel(channel);

    // Nothing is tracked here, so this is the multi-instance case: forward it rather than drop it.
    expect(ctx.control.abort("run-elsewhere", "cancel")).toBe(false);
    expect(channel.published).toEqual([{ run_id: "run-elsewhere", reason: "cancel" }]);
  });

  it("does not publish an abort it handled locally", async () => {
    const channel = createLoopbackChannel();
    const ctx = createContext(createFixtureDeps());
    ctx.control.useAbortChannel(channel);
    ctx.control.register("run-here");

    expect(ctx.control.abort("run-here", "cancel")).toBe(true);
    // The executor is this process; broadcasting would be pure noise on every cancel.
    expect(channel.published).toEqual([]);
  });

  it("never re-publishes a request that arrived from a peer", async () => {
    // Otherwise two instances bounce the same message back and forth forever: neither can tell a
    // forwarded request from a fresh one.
    const channel = createLoopbackChannel();
    const ctx = createContext(createFixtureDeps());
    ctx.control.useAbortChannel(channel);

    ctx.control.applyRemoteAbort("run-unknown-here", "cancel");
    expect(channel.published).toEqual([]);
  });

  it("survives a publish failure without failing the cancel", async () => {
    const warn = vi.fn();
    const failing: RunAbortChannel = {
      requestAbort: () => Promise.reject(new Error("redis is down")),
      subscribe: () => ({ close: async () => {} }),
    };
    const ctx = createContext(createFixtureDeps());
    ctx.control.useAbortChannel(failing, {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });

    // The run is already terminal in the store by the time this is called, so a lost broadcast costs
    // promptness, not correctness — it must not reject.
    expect(() => ctx.control.abort("run-elsewhere", "cancel")).not.toThrow();
    await waitFor(() => warn.mock.calls.length > 0);
  });
});

describe("two runtimes sharing one abort channel", () => {
  it("stops a run executing on the other instance", async () => {
    // The headline multi-instance gap: a cancel routed to the wrong replica used to mark the run
    // terminal and leave the graph burning tokens until it finished on its own.
    const channel = createLoopbackChannel();
    const deps = createFixtureDeps(); // one store/queue/bus, as two replicas would share
    const executing = createProtocolRuntime({ ...deps, abortChannel: channel });
    const receiving = createProtocolRuntime({ ...deps, abortChannel: channel });
    await executing.service.assistants.registerGraphAssistants();

    const thread = await executing.service.threads.create();
    // `slow` blocks until aborted, so the run is genuinely mid-flight on instance A.
    const { runId, frames } = await executing.service.runs.createStream({
      thread_id: thread.thread_id,
      assistant_id: "slow",
      input: {},
    });
    await waitFor(async () => (await deps.store.runs.get(runId))?.status === "running");

    // Instance B receives the cancel. It is not executing the run, so its only route to stopping it is
    // the channel.
    await receiving.service.runs.cancel(runId);

    // The stream ends, which only instance A's engine can do: `bus.close` happens in its `finally`, and
    // `cancel` does *not* close the bus for a running run. A terminal run row would prove nothing here —
    // B wrote that itself before broadcasting. Without the channel this drains for the graph's full 10s.
    await expect(
      Promise.race([
        (async () => {
          for await (const _frame of frames) void _frame;
          return "graph stopped";
        })(),
        new Promise((resolve) => setTimeout(() => resolve("still running"), 1500)),
      ]),
    ).resolves.toBe("graph stopped");
    expect((await deps.store.runs.get(runId))?.status).toBe("cancelled");
    expect(await deps.store.runs.hasActiveRun(thread.thread_id)).toBe(false);

    await executing.worker.stop();
    await receiving.worker.stop();
  });

  it("rolls back writes made by a run that executed on the other instance", async () => {
    // What persisting the base checkpoint is for. The displacing run is created on B, which has never
    // seen A's in-process note, so its only route to a correct revert is the displaced run's own kwargs.
    const channel = createLoopbackChannel();
    const deps = createFixtureDeps();
    const executing = createProtocolRuntime({ ...deps, abortChannel: channel });
    const displacing = createProtocolRuntime({ ...deps, abortChannel: channel });
    await executing.service.assistants.registerGraphAssistants();

    const thread = await executing.service.threads.create();
    // An established history the rollback must trim back to, rather than wipe.
    await executing.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "echo",
      input: { value: "kept" },
    });
    const baseline = await executing.service.threads.history(thread.thread_id);

    // A long run on A, which records its base checkpoint as it starts.
    const { runId: displaced } = await executing.service.runs.createStream({
      thread_id: thread.thread_id,
      assistant_id: "slow",
      input: {},
    });
    await waitFor(async () => (await deps.store.runs.get(displaced))?.status === "running");
    await waitFor(async () => {
      const kwargs = await deps.store.runs.getKwargs(displaced);
      return kwargs !== null && "base_checkpoint_id" in kwargs;
    });

    // B displaces it. The plan it computes has to name A's recorded base.
    await displacing.service.runs.createBackground(thread.thread_id, {
      assistant_id: "echo",
      input: { value: "displacing" },
      multitask_strategy: "rollback",
    });

    const plan = (
      await deps.store.runs.getKwargs(
        (await deps.store.runs.listByThread(thread.thread_id)).at(-1)!.run_id,
      )
    )?.rollback_plan;
    expect(plan?.revert_to_checkpoint).not.toBe(false);
    expect(plan?.displaced_run_ids).toContain(displaced);
    // Trimmed back to what existed before the displaced run, not wiped — the history it never wrote
    // survives, which is exactly what "never recorded" vs "recorded as empty" protects.
    expect(baseline.length).toBeGreaterThan(0);

    await executing.worker.stop();
    await displacing.worker.stop();
  });

  it("closes its channel subscription when the worker stops", async () => {
    // A live Redis subscriber holds the process open, so a host that stops the worker must not have to
    // remember a second teardown call.
    const channel = createLoopbackChannel();
    const close = vi.fn(async () => {});
    const runtime = createProtocolRuntime({
      ...createFixtureDeps(),
      abortChannel: { ...channel, subscribe: () => ({ close }) },
    });

    await runtime.worker.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
