// `if_thread_status` on run create — the precondition that stops a start from trampling a thread
// with a human-in-the-loop pause on it.
//
// The behaviour under test is not obvious from the run vocabulary, which is exactly why it is pinned
// here: `interrupted` is a *terminal* run status, so a thread waiting on an answer holds no inflight
// run, `hasActiveRun` is false, and every `multitask_strategy` — including the default `reject` —
// lets a fresh start through. Without this field there is no way to express "only if nobody is
// waiting", and the interrupt is discarded with no error, no warning and no log line.
//
// Every case runs against all three thread-scoped create routes, because they have drifted before
// (see `if-not-exists.test.ts`) and a precondition that holds on two of three is not a precondition.

import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

async function harness(deps = createFixtureDeps()) {
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return { deps, service };
}

const run = { assistant_id: "echo", input: { value: "hi" } } as const;

/** A thread parked on an interrupt, as the run engine would leave it. */
async function interruptedThread(deps: ReturnType<typeof createFixtureDeps>): Promise<string> {
  const { thread_id } = await deps.store.threads.create();
  await deps.store.threads.update(thread_id, { status: "interrupted" });
  return thread_id;
}

describe("if_thread_status on run create", () => {
  describe("refuses a start on an interrupted thread with 409 thread_status_mismatch", () => {
    it("on POST /threads/{id}/runs/wait", async () => {
      const { deps, service } = await harness();
      const thread_id = await interruptedThread(deps);

      await expect(
        service.runs.createWait({ ...run, thread_id, if_thread_status: ["idle", "error"] }),
      ).rejects.toMatchObject({ status: 409, code: "thread_status_mismatch" });
      expect(await deps.store.runs.listByThread(thread_id)).toHaveLength(0);
    });

    it("on POST /threads/{id}/runs/stream", async () => {
      const { deps, service } = await harness();
      const thread_id = await interruptedThread(deps);

      await expect(
        service.runs.createStream({ ...run, thread_id, if_thread_status: ["idle", "error"] }),
      ).rejects.toMatchObject({ status: 409, code: "thread_status_mismatch" });
      expect(await deps.store.runs.listByThread(thread_id)).toHaveLength(0);
    });

    it("on POST /threads/{id}/runs", async () => {
      const { deps, service } = await harness();
      const thread_id = await interruptedThread(deps);

      await expect(
        service.runs.createBackground(thread_id, { ...run, if_thread_status: ["idle", "error"] }),
      ).rejects.toMatchObject({ status: 409, code: "thread_status_mismatch" });
      expect(await deps.store.runs.listByThread(thread_id)).toHaveLength(0);
    });
  });

  it("carries the observed status, so the caller can re-decide without a second read", async () => {
    // The point of the payload: a caller that re-reads instead may see a third value, because the
    // thread is live. What it is told here is what the create actually raced against.
    const { deps, service } = await harness();
    const thread_id = await interruptedThread(deps);

    await expect(
      service.runs.createBackground(thread_id, { ...run, if_thread_status: ["idle"] }),
    ).rejects.toMatchObject({ details: { status: "interrupted" } });
  });

  it("admits the create when the status is allowed", async () => {
    const { deps, service } = await harness();
    const thread_id = await interruptedThread(deps);

    // Same thread, same request — the only difference is that the caller opted into `interrupted`,
    // which is how a channel says "this message is the answer to the pending question".
    const created = await service.runs.createBackground(thread_id, {
      ...run,
      if_thread_status: ["idle", "interrupted"],
    });

    expect(created.run_id).toBeTruthy();
    expect(await deps.store.runs.listByThread(thread_id)).toHaveLength(1);
  });

  it("leaves an unguarded create alone", async () => {
    // The regression that matters most: omitting the field must behave exactly as it did before this
    // existed, including on an interrupted thread. This is today's (lossy) behaviour, pinned so the
    // precondition cannot quietly become mandatory.
    const { deps, service } = await harness();
    const thread_id = await interruptedThread(deps);

    const created = await service.runs.createBackground(thread_id, run);

    expect(created.run_id).toBeTruthy();
  });

  it("still displaces the running run under multitask_strategy: interrupt", async () => {
    // The regression this caught: a first implementation short-circuited the whole create when a
    // precondition was present, so `interrupt` and `rollback` silently stopped displacing anything —
    // the second run was inserted and the first kept going, two runs interleaving writes on one
    // thread. The precondition has to ride along with the strategy, not replace it.
    const { deps, service } = await harness();
    const { thread_id } = await deps.store.threads.create();
    const first = await deps.store.runs.create({ thread_id, assistant_id: "echo" });

    await service.runs.createBackground(thread_id, {
      ...run,
      multitask_strategy: "interrupt",
      if_thread_status: ["idle"],
    });

    expect((await deps.store.runs.get(first.run_id))?.status).toBe("interrupted");
    expect(await deps.store.runs.listActiveRuns(thread_id)).toHaveLength(1);
  });

  it("applies the precondition on the enqueue path too", async () => {
    // Not just `reject`: every strategy reaches an insert, and every insert honours the guard.
    const { deps, service } = await harness();
    const thread_id = await interruptedThread(deps);

    await expect(
      service.runs.createBackground(thread_id, {
        ...run,
        multitask_strategy: "enqueue",
        if_thread_status: ["idle"],
      }),
    ).rejects.toMatchObject({ status: 409, code: "thread_status_mismatch" });
  });

  it("still refuses a busy thread as 422 thread_busy, not 409", async () => {
    // The two guards travel on one driver call, and they must not blur: `thread_busy` means retry
    // later, `thread_status_mismatch` means your assumption about the thread was wrong.
    const { deps, service } = await harness();
    const { thread_id } = await deps.store.threads.create();
    await deps.store.runs.create({ thread_id, assistant_id: "echo" });

    await expect(
      service.runs.createBackground(thread_id, { ...run, if_thread_status: ["idle"] }),
    ).rejects.toMatchObject({ status: 422, code: "thread_busy" });
  });
});
