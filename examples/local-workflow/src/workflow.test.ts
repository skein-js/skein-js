import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedSqliteGraphs } from "@skein-js/local";
import { afterEach, expect, it } from "vitest";

import { sampleMeeting, type MeetingRecap } from "./meeting-notes.js";
import { buildWorkflow } from "./workflow.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function openMeetingRuntime(directory?: string) {
  const location = directory ?? (await mkdtemp(join(tmpdir(), "skein-meeting-test-")));
  if (!directory) directories.push(location);
  const embedded = await embedSqliteGraphs(
    { workflow: buildWorkflow(location, { fixture: true }) },
    { sqlitePath: join(location, "state.sqlite") },
  );
  const runtime = createProtocolRuntime(embedded.deps, { scheduler: { enabled: false } });
  await runtime.service.assistants.registerGraphAssistants();
  return {
    location,
    service: runtime.service,
    async dispose() {
      await runtime.worker.stop();
      await embedded.dispose();
    },
  };
}

it("keeps review pending across reopening, then saves the user's corrected follow-ups", async () => {
  const first = await openMeetingRuntime();
  let threadId: string;
  try {
    const thread = await first.service.threads.create();
    threadId = thread.thread_id;
    await first.service.runs.createWait({
      thread_id: threadId,
      assistant_id: "workflow",
      input: sampleMeeting,
    });
    const paused = await first.service.threads.getState(threadId);
    expect(paused.next).toEqual(["approve"]);
    expect(await readdir(first.location)).not.toContain("meeting-recaps");
  } finally {
    await first.dispose();
  }
  const reopened = await openMeetingRuntime(first.location);
  try {
    const paused = await reopened.service.threads.getState(threadId!);
    const recap = paused.values as unknown as MeetingRecap;
    expect(recap.actions).toHaveLength(3);
    expect(recap.decisions).toHaveLength(2);
    await reopened.service.runs.createWait({
      thread_id: threadId!,
      assistant_id: "workflow",
      command: {
        resume: {
          approved: true,
          actions: recap.actions.map((action) => ({
            ...action,
            owner: "Jordan",
            due: "Next Tuesday",
          })),
        },
      },
    });
    const completed = (await reopened.service.threads.getState(threadId!))
      .values as unknown as MeetingRecap;
    expect(completed.outcome).toBe("saved");
    const markdown = await readFile(completed.savedPath, "utf8");
    expect(markdown).toContain("Jordan · Next Tuesday");
    expect(markdown).toContain(sampleMeeting.notes);
    expect(markdown).toContain("- [ ] Share the final homepage copy");
  } finally {
    await reopened.dispose();
  }
});

it("finishes a skipped review without writing a recap file", async () => {
  const runtime = await openMeetingRuntime();
  try {
    const thread = await runtime.service.threads.create();
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "workflow",
      input: sampleMeeting,
    });
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "workflow",
      command: { resume: { approved: false } },
    });
    const completed = await runtime.service.threads.getState(thread.thread_id);
    expect(completed.next).toEqual([]);
    expect((completed.values as unknown as MeetingRecap).outcome).toBe("dismissed");
    expect(await readdir(runtime.location)).not.toContain("meeting-recaps");
  } finally {
    await runtime.dispose();
  }
});

it("preserves unstructured notes without inventing decisions or assignments", async () => {
  const runtime = await openMeetingRuntime();
  try {
    const thread = await runtime.service.threads.create();
    const notes = "We talked about the community garden. Nothing has been assigned yet.";
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "workflow",
      input: { title: "Community garden", notes },
    });
    const paused = (await runtime.service.threads.getState(thread.thread_id))
      .values as unknown as MeetingRecap;
    expect(paused.actions).toEqual([]);
    expect(paused.decisions).toEqual([]);
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "workflow",
      command: { resume: true },
    });
    const completed = (await runtime.service.threads.getState(thread.thread_id))
      .values as unknown as MeetingRecap;
    expect(await readFile(completed.savedPath, "utf8")).toContain(notes);
  } finally {
    await runtime.dispose();
  }
});

it("saves fresh approvals as immutable revisions and keeps identical content idempotent", async () => {
  const runtime = await openMeetingRuntime();
  try {
    const threadId = (await runtime.service.threads.create()).thread_id;
    const approveRecap = async (summary: string) => {
      await runtime.service.runs.createWait({
        thread_id: threadId,
        assistant_id: "workflow",
        input: sampleMeeting,
      });
      await runtime.service.runs.createWait({
        thread_id: threadId,
        assistant_id: "workflow",
        command: { resume: { approved: true, summary } },
      });
      return (await runtime.service.threads.getState(threadId)).values as unknown as MeetingRecap;
    };

    const original = await approveRecap("The first approved recap.");
    const revised = await approveRecap("The updated approved recap.");
    expect(revised.savedPath).not.toBe(original.savedPath);
    expect(await readFile(original.savedPath, "utf8")).toContain("The first approved recap.");
    expect(await readFile(revised.savedPath, "utf8")).toContain("The updated approved recap.");
    const archived = await runtime.service.store.get(["meeting-recaps"], threadId);
    expect(archived?.value["savedPath"]).toBe(revised.savedPath);
    expect(archived?.value["summary"]).toBe("The updated approved recap.");

    const repeated = await approveRecap("The updated approved recap.");
    expect(repeated.savedPath).toBe(revised.savedPath);
    expect(await readdir(join(runtime.location, "meeting-recaps"))).toHaveLength(2);
  } finally {
    await runtime.dispose();
  }
});
