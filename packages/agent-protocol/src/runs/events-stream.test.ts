// True `events` stream mode: when `events` is requested the engine drives the graph via
// `graph.streamEvents` and demuxes — internal stream chunks become mode frames, every other event
// becomes an `events` frame carrying the raw LangChain StreamEvent.

import type { Run, RunKwargs, StreamMode } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { collect, createFixtureDeps } from "../__fixtures__/deps.js";
import { resolveDeps } from "../deps.js";

import { RunControlRegistry } from "./cancellation.js";
import { executeRun } from "./run-engine.js";

async function seed(stream_mode: StreamMode | StreamMode[]) {
  const deps = resolveDeps(createFixtureDeps());
  const assistant = await deps.store.assistants.create({ graph_id: "echo", assistant_id: "echo" });
  const thread = await deps.store.threads.create();
  const run: Run = await deps.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: assistant.assistant_id,
    status: "pending",
  });
  const control = new RunControlRegistry().register(run.run_id);
  const kwargs: RunKwargs = { input: { value: "hi" }, stream_mode };
  return { deps, run, control, kwargs };
}

describe("events stream mode", () => {
  it("emits `events` frames carrying raw StreamEvents when `events` is requested", async () => {
    const { deps, run, control, kwargs } = await seed(["events"]);
    const framesPromise = collect(deps.bus.subscribe(run.run_id, 0));
    const outcome = await executeRun(deps, { run, kwargs, control });
    const frames = await framesPromise;

    expect(outcome.status).toBe("success");
    const eventFrames = frames.filter((f) => f.event === "events");
    expect(eventFrames.length).toBeGreaterThan(0);
    // Each carries a LangChain StreamEvent with an `event` discriminator (e.g. on_chain_start).
    const kinds = eventFrames.map((f) => (f.data as { event?: string }).event);
    expect(kinds).toContain("on_chain_start");
    expect(kinds).toContain("on_chain_end");
    // With only `events` requested, no plain mode frames leak through.
    expect(frames.some((f) => f.event === "values")).toBe(false);
  });

  it("emits both `events` and the co-requested mode frames", async () => {
    const { deps, run, control, kwargs } = await seed(["events", "values"]);
    const framesPromise = collect(deps.bus.subscribe(run.run_id, 0));
    await executeRun(deps, { run, kwargs, control });
    const frames = await framesPromise;

    expect(frames.some((f) => f.event === "events")).toBe(true);
    expect(frames.some((f) => f.event === "values")).toBe(true);
  });
});
