import { createSpecStreamCompiler, type Spec } from "@json-render/core";
import { describe, expect, it } from "vitest";

import { committedUiSchema, validateUiSpec, type CommittedUi } from "./catalog.js";
import { demoSpecStream } from "./generation.js";
import { generateImmediateText, startHarness } from "./test-harness.js";
import { createUiStream } from "./ui-events.js";

describe("json-render through Skein HTTP", () => {
  it("streams a validated UI, checkpoints it, and resumes without generating again", async () => {
    let generations = 0;
    const previousPlans: (CommittedUi | null | undefined)[] = [];
    const harness = await startHarness(async function* (request, signal, previousUi) {
      generations++;
      previousPlans.push(previousUi);
      yield* generateImmediateText(request, signal);
    });
    try {
      const client = harness.clientFor();
      const thread = await client.threads.create();
      const run = await client.runs.create(thread.thread_id, "plan-builder", {
        input: { request: { prompt: "Launch a tiny café ☕" } },
        streamMode: ["custom", "values"],
        streamSubgraphs: true,
      });
      const stream = createUiStream(null);
      for await (const frame of client.runs.joinStream(thread.thread_id, run.run_id))
        stream.push(frame);
      const snapshot = await client.threads.getState(thread.thread_id);
      const ui = committedUiSchema.parse(snapshot.values["ui"]);
      expect(stream.snapshot()).toMatchObject({
        complete: true,
        gap: false,
        spec: ui.spec,
        chunkCount: ui.chunkCount,
      });
      expect(ui.spec.elements["summary"]?.props["text"]).toBe("Launch a tiny café ☕");
      expect(snapshot.tasks.flatMap((task) => task.interrupts)).toHaveLength(1);
      const decision = { generationId: ui.generationId, approved: true };
      await client.runs.wait(thread.thread_id, "plan-builder", {
        input: null,
        command: { resume: decision },
      });
      const restored = await harness.clientFor().threads.getState(thread.thread_id);
      expect(restored.values["ui"]).toEqual(ui);
      expect(restored.values["approved"]).toBe(true);
      expect(generations).toBe(1);
      await client.runs.wait(thread.thread_id, "plan-builder", {
        input: { request: { prompt: "Make a smaller launch" } },
      });
      const revised = await client.threads.getState(thread.thread_id);
      expect(committedUiSchema.parse(revised.values["ui"]).generationId).not.toBe(ui.generationId);
      expect(generations).toBe(2);
      expect(previousPlans[0]).toBeNull();
      expect(previousPlans[1]).toEqual(ui);
    } finally {
      await harness.close();
    }
  });

  it("uses the upstream compiler and catalog for the offline generator", () => {
    const compiler = createSpecStreamCompiler<Spec>();
    compiler.push(demoSpecStream({ prompt: "A weekend project" }));
    const spec = validateUiSpec(compiler.getResult());
    expect(spec.elements["tasks"]?.props["tasks"]).toHaveLength(3);
    expect(spec.elements["revise"]?.on).toBeDefined();
  });
});
