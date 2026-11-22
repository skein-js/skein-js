import { createSpecStreamCompiler, type Spec } from "@json-render/core";
import { describe, expect, it } from "vitest";

import {
  committedUiSchema,
  validateGeneratedUi,
  validateUiSpec,
  type CommittedUi,
} from "./catalog.js";
import { fixtureSpecStream } from "./generation-fixture.js";
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

      const run = await client.runs.create(thread.thread_id, "ui-playground", {
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
      await client.runs.wait(thread.thread_id, "ui-playground", {
        input: null,
        command: { resume: decision },
      });
      const restored = await harness.clientFor().threads.getState(thread.thread_id);
      expect(restored.values["ui"]).toEqual(ui);
      expect(restored.values["approved"]).toBe(true);
      expect(generations).toBe(1);
      await client.runs.wait(thread.thread_id, "ui-playground", {
        input: {
          request: {
            action: "reviseUi",
            generationId: ui.generationId,
            prompt: "Make a smaller launch",
          },
        },
      });
      const revised = await client.threads.getState(thread.thread_id);
      expect(revised.values["conversation"]).toEqual([
        { generationId: ui.generationId, prompt: "Launch a tiny café ☕", ui },
        {
          generationId: committedUiSchema.parse(revised.values["ui"]).generationId,
          prompt: "Make a smaller launch",
          ui: committedUiSchema.parse(revised.values["ui"]),
        },
      ]);
      expect(committedUiSchema.parse(revised.values["ui"]).generationId).not.toBe(ui.generationId);
      expect(generations).toBe(2);
      expect(previousPlans[0]).toBeNull();
      expect(previousPlans[1]).toEqual(ui);
    } finally {
      await harness.close();
    }
  });

  it.each([
    "Build a dashboard for skein-js/skein-js",
    "Show the GitHub profile for @octocat",
    "List recently pushed repositories for @torvalds",
  ])("compiles the %s fixture through the upstream catalog", (prompt) => {
    const compiler = createSpecStreamCompiler<Spec>();
    compiler.push(fixtureSpecStream({ prompt }));
    const spec = validateGeneratedUi(compiler.getResult());
    expect(spec.elements["tasks"]?.props["tasks"]).toHaveLength(3);
    expect(spec.elements["revise"]?.on).toBeDefined();
  });

  it("retries a truncated spec in the same run and replaces its preview", async () => {
    let attempts = 0;

    const harness = await startHarness(async function* (request, signal) {
      if (++attempts === 1) {
        yield '{"op":"add","path":"/root","value":"incomplete"}\n';
        yield '{"op":"add","path":"/elements/incomplete","value":{"type":"Card","props":{"title":"Incomplete"},"children":[]}}\n';
        yield '{"op":"add","path":"/elements/';
        return;
      }

      yield* generateImmediateText(request, signal);
    });

    try {
      const client = harness.clientFor();
      const thread = await client.threads.create();

      const run = await client.runs.create(thread.thread_id, "ui-playground", {
        input: { request: { prompt: "Build a dashboard for skein-js/skein-js" } },
        streamMode: ["custom"],
      });

      const stream = createUiStream(null);
      for await (const frame of client.runs.joinStream(thread.thread_id, run.run_id))
        stream.push(frame);
      const state = await client.threads.getState(thread.thread_id);
      const ui = committedUiSchema.parse(state.values["ui"]);
      expect(attempts).toBe(2);
      expect(state.tasks.flatMap((task) => task.interrupts)).toHaveLength(1);
      expect(stream.snapshot()).toMatchObject({ complete: true, spec: ui.spec });
      expect(ui.spec.elements["incomplete"]).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("requires bound revision controls on new output while allowing old specs to reopen", () => {
    const oldSpec = {
      root: "dashboard",
      elements: { dashboard: { type: "Card", props: { title: "Dashboard" }, children: [] } },
    };
    expect(validateUiSpec(oldSpec)).toEqual(oldSpec);
    expect(() => validateGeneratedUi(oldSpec)).toThrow("missing a working revision button");
  });

  it.each(["plan", "revise", "feedback"])("rejects new specs with a hidden %s element", (key) => {
    const compiler = createSpecStreamCompiler<Spec>();
    compiler.push(fixtureSpecStream({ prompt: "A repository dashboard" }));
    const spec = compiler.getResult();
    spec.elements[key]!.visible = false;
    expect(() => validateGeneratedUi(spec)).toThrow();
  });
});
