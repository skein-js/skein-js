import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedSqliteGraphs } from "@skein-js/local";
import { afterEach, expect, it } from "vitest";

import { buildDailyPlanner, sampleTasks, type DailyPlan } from "./daily-planner.js";
import type { MeetingRecap } from "./meeting-notes.js";
import { modelErrorMessage } from "./model-session.js";
import { sampleReading } from "./reading-sample.js";
import { buildWorkflow } from "./workflow.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function createDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "skein-local-app-test-"));
  directories.push(directory);
  return directory;
}
async function openRuntime(directory: string, application: "reading" | "planner") {
  const graph =
    application === "reading"
      ? buildWorkflow(directory, { fixture: true, application: "reading" })
      : buildDailyPlanner(directory, join(directory, "tasks.md"), { fixture: true });
  const embedded = await embedSqliteGraphs(
    { workflow: graph },
    { sqlitePath: join(directory, "state.sqlite") },
  );
  const runtime = createProtocolRuntime(embedded.deps, { scheduler: { enabled: false } });
  await runtime.service.assistants.registerGraphAssistants();
  return {
    service: runtime.service,
    async dispose() {
      await runtime.worker.stop();
      await embedded.dispose();
    },
  };
}

it("reopens a reading review, preserves exact source excerpts, and saves the reviewed brief", async () => {
  const directory = await createDirectory();
  const first = await openRuntime(directory, "reading");
  let threadId: string;
  try {
    threadId = (await first.service.threads.create()).thread_id;
    await first.service.runs.createWait({
      thread_id: threadId,
      assistant_id: "workflow",
      input: { ...sampleReading, documentId: threadId },
    });
    const state = await first.service.threads.getState(threadId);
    expect(state.next).toEqual(["approve"]);
    expect(
      (state.values as unknown as MeetingRecap).quotes?.every((quote) =>
        sampleReading.notes.includes(quote),
      ),
    ).toBe(true);
    expect(await readdir(directory)).not.toContain("reading-briefs");
  } finally {
    await first.dispose();
  }
  const reopened = await openRuntime(directory, "reading");
  try {
    await reopened.service.runs.createWait({
      thread_id: threadId!,
      assistant_id: "workflow",
      command: { resume: { approved: true, summary: "My own reading takeaway." } },
    });
    const brief = (await reopened.service.threads.getState(threadId!))
      .values as unknown as MeetingRecap;
    const markdown = await readFile(brief.savedPath, "utf8");
    expect(markdown).toContain("My own reading takeaway.");
    expect(markdown).toContain("## Source excerpts");
    expect(markdown).toContain(sampleReading.notes);
    const archived = await reopened.service.store.get(["reading-briefs"], threadId!);
    expect(archived?.value["quotes"]).toEqual(brief.quotes);
  } finally {
    await reopened.dispose();
  }
});

it.each([true, false])(
  "keeps a daily plan pending across restart and applies save=%s without changing the inbox",
  async (approved) => {
    const directory = await createDirectory();
    await writeFile(join(directory, "tasks.md"), sampleTasks);
    const first = await openRuntime(directory, "planner");
    let threadId: string;
    try {
      threadId = (await first.service.threads.create()).thread_id;
      await first.service.runs.createWait({
        thread_id: threadId,
        assistant_id: "workflow",
        input: { request: "Plan my morning." },
      });
      expect((await first.service.threads.getState(threadId)).next).toEqual(["approve"]);
      expect(await readdir(directory)).not.toContain("daily-plans");
    } finally {
      await first.dispose();
    }
    const reopened = await openRuntime(directory, "planner");
    try {
      await reopened.service.runs.createWait({
        thread_id: threadId!,
        assistant_id: "workflow",
        command: { resume: { approved } },
      });
      const plan = (await reopened.service.threads.getState(threadId!))
        .values as unknown as DailyPlan;
      expect(plan.outcome).toBe(approved ? "saved" : "dismissed");
      expect(await readFile(join(directory, "tasks.md"), "utf8")).toBe(sampleTasks);
      if (approved) {
        expect(await readFile(plan.savedPath, "utf8")).toContain(plan.blocks[0]!.task);
        expect(
          (await reopened.service.store.get(["daily-plans"], threadId!))?.value["summary"],
        ).toBe(plan.summary);
      } else expect(await readdir(directory)).not.toContain("daily-plans");
    } finally {
      await reopened.dispose();
    }
  },
);

it("turns provider details into actionable errors without persisting raw credentials", () => {
  expect(modelErrorMessage(new Error("403 PERMISSION_DENIED private-token"), "vertex")).toContain(
    "application-default login",
  );
  expect(
    modelErrorMessage(new Error("403 PERMISSION_DENIED private-token"), "vertex"),
  ).not.toContain("private-token");
  expect(modelErrorMessage(new Error("429 RESOURCE_EXHAUSTED"))).toContain("quota");
});
