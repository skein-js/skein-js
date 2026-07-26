import { isTerminalRunStatus, type Run } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { collect, createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps } from "../deps.js";

import { RunControlRegistry } from "./cancellation.js";
import { executeRun } from "./run-engine.js";

// Seed an assistant + thread + pending run, then run the engine directly.
async function seed(
  deps = createFixtureDeps(),
  graphId = "echo",
  input: unknown = { value: "hi" },
) {
  const resolved = resolveDeps(deps);
  const assistant = await resolved.store.assistants.create({
    graph_id: graphId,
    assistant_id: graphId,
  });
  const thread = await resolved.store.threads.create();
  const run: Run = await resolved.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: assistant.assistant_id,
    status: "pending",
  });
  const kwargs = { input, stream_mode: "values" as const };
  return { deps: resolved, run, threadId: thread.thread_id, kwargs };
}

describe("executeRun", () => {
  it("runs an echo graph to success, publishes frames, and mirrors the thread", async () => {
    const { deps, run, threadId, kwargs } = await seed();
    const control = new RunControlRegistry().register(run.run_id);

    const framesPromise = collect(deps.bus.subscribe(run.run_id, 0));
    const outcome = await executeRun(deps, { run, kwargs, control });
    const frames = await framesPromise;

    expect(outcome.status).toBe("success");
    expect(outcome.values).toEqual({ value: "echo: hi" });
    expect((await deps.store.runs.get(run.run_id))?.status).toBe("success");

    const thread = await deps.store.threads.get(threadId);
    expect(thread?.status).toBe("idle");
    expect(thread?.values).toEqual({ value: "echo: hi" });

    expect(frames.some((f) => f.event === "values")).toBe(true);
  });

  it("finalizes an error run with an error frame and mirrors the thread to error", async () => {
    const { deps, run, kwargs } = await seed(createFixtureDeps(), "throwing");
    const control = new RunControlRegistry().register(run.run_id);

    const framesPromise = collect(deps.bus.subscribe(run.run_id, 0));
    const outcome = await executeRun(deps, { run, kwargs, control });
    const frames = await framesPromise;

    expect(outcome.status).toBe("error");
    expect((await deps.store.runs.get(run.run_id))?.status).toBe("error");
    expect((await deps.store.threads.get(run.thread_id))?.status).toBe("error");
    expect(frames.at(-1)?.event).toBe("error");
  });

  it("publishes the failure in LangGraph Platform's `{ error, message }` shape", async () => {
    const { deps, run, kwargs } = await seed(createFixtureDeps(), "throwing");
    const control = new RunControlRegistry().register(run.run_id);

    const framesPromise = collect(deps.bus.subscribe(run.run_id, 0));
    await executeRun(deps, { run, kwargs, control });
    const frames = await framesPromise;

    // `error` is the field the SDK's `ErrorStreamEvent` declares; `name` is the alias its
    // `StreamError` prefers. Both carry the constructor name, so every consumer agrees.
    expect(frames.at(-1)?.data).toEqual({ error: "Error", name: "Error", message: "boom" });
  });

  it("persists the failure on the run row, so a later GET can still explain it", async () => {
    const { deps, run, kwargs } = await seed(createFixtureDeps(), "throwing-with-cause");
    const control = new RunControlRegistry().register(run.run_id);

    const framesPromise = collect(deps.bus.subscribe(run.run_id, 0));
    const outcome = await executeRun(deps, { run, kwargs, control });
    const frames = await framesPromise;

    const expected = {
      error: "Error",
      name: "Error",
      message: "model call failed",
      cause: { error: "Error", name: "Error", message: "429 rate limit" },
    };
    // The frame, the run row, and the returned outcome are the same payload — they cannot disagree.
    expect(frames.at(-1)?.data).toEqual(expected);
    expect((await deps.store.runs.get(run.run_id))?.error).toEqual(expected);
    expect(outcome.error).toEqual(expected);
  });

  it("keeps stacks off the wire by default, and includes them under exposeErrorStacks", async () => {
    const hidden = await seed(createFixtureDeps(), "throwing");
    const hiddenFrames = collect(hidden.deps.bus.subscribe(hidden.run.run_id, 0));
    await executeRun(hidden.deps, {
      run: hidden.run,
      kwargs: hidden.kwargs,
      control: new RunControlRegistry().register(hidden.run.run_id),
    });
    expect((await hiddenFrames).at(-1)?.data).not.toHaveProperty("stack");
    expect((await hidden.deps.store.runs.get(hidden.run.run_id))?.error).not.toHaveProperty(
      "stack",
    );

    const shown = await seed(
      { ...createFixtureDeps(), exposeErrorStacks: true },
      "throwing-with-cause",
    );
    const shownFrames = collect(shown.deps.bus.subscribe(shown.run.run_id, 0));
    await executeRun(shown.deps, {
      run: shown.run,
      kwargs: shown.kwargs,
      control: new RunControlRegistry().register(shown.run.run_id),
    });
    const data = (await shownFrames).at(-1)?.data as { stack?: string; cause?: { stack?: string } };
    expect(data.stack).toContain("Error: model call failed");
    expect(data.cause?.stack).toBeDefined();
  });

  it("mirrors the failure onto the thread's SDK `error` field and clears it on recovery", async () => {
    const deps = createFixtureDeps();
    const failed = await seed(deps, "throwing");
    await executeRun(failed.deps, {
      run: failed.run,
      kwargs: failed.kwargs,
      control: new RunControlRegistry().register(failed.run.run_id),
    });

    const thread = await failed.deps.store.threads.get(failed.threadId);
    expect(thread?.error).toBe("boom");
    expect(thread?.metadata?.["error"]).toBe("boom");

    // A later healthy run on the same thread must not keep reporting the old failure.
    const echo = await failed.deps.store.assistants.create({ graph_id: "echo", assistant_id: "e" });
    const next = await failed.deps.store.runs.create({
      thread_id: failed.threadId,
      assistant_id: echo.assistant_id,
      status: "pending",
    });
    await executeRun(failed.deps, {
      run: next,
      kwargs: { input: { value: "hi" }, stream_mode: "values" as const },
      control: new RunControlRegistry().register(next.run_id),
    });

    const recovered = await failed.deps.store.threads.get(failed.threadId);
    expect(recovered?.status).toBe("idle");
    expect(recovered?.error).toBeUndefined();
    expect(recovered?.metadata?.["error"]).toBeUndefined();
  });

  it("interrupts, persisting the pending interrupt onto the thread", async () => {
    const { deps, run, threadId, kwargs } = await seed(createFixtureDeps(), "interrupting");
    const control = new RunControlRegistry().register(run.run_id);

    const outcome = await executeRun(deps, { run, kwargs, control });

    expect(outcome.status).toBe("interrupted");
    expect(isTerminalRunStatus(outcome.status)).toBe(true);
    const thread = await deps.store.threads.get(threadId);
    expect(thread?.status).toBe("interrupted");
    expect(Object.keys(thread?.interrupts ?? {})).not.toHaveLength(0);
    // Terminal so the thread is free for a resume run (guard uses hasActiveRun).
    expect(await deps.store.runs.hasActiveRun(threadId)).toBe(false);
  });

  it("always closes the bus, even on error (subscriber completes)", async () => {
    const { deps, run, kwargs } = await seed(createFixtureDeps(), "throwing");
    const control = new RunControlRegistry().register(run.run_id);
    const framesPromise = collect(deps.bus.subscribe(run.run_id, 0));
    await executeRun(deps, { run, kwargs, control });
    // If close() never ran, this await would hang; the test timeout would catch it.
    await expect(framesPromise).resolves.toBeInstanceOf(Array);
  });

  it("injects a BaseStore so a node can use getStore() for long-term memory", async () => {
    const { deps, run, kwargs } = await seed(createFixtureDeps(), "store", {
      value: "remember me",
    });
    const control = new RunControlRegistry().register(run.run_id);

    const outcome = await executeRun(deps, { run, kwargs, control });

    // The node read back what it wrote through the injected store.
    expect(outcome.status).toBe("success");
    expect(outcome.values).toEqual({ value: "stored: remember me" });
    // And the write is visible on the underlying SkeinStore — same store, two access paths.
    const item = await deps.store.store.get(["memories"], "note");
    expect(item?.value).toEqual({ text: "remember me" });
  });
});
