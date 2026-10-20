// The briefing assistant end to end, the way an application would use it: a `createDeepAgent` export
// served by skein from an unchanged `langgraph.json`, driven by the official SDK client. Offline — with
// no `DEEP_AGENT_MODEL`, both agents think with the scripted model.

import type { Client } from "@langchain/langgraph-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { briefingFileFor } from "./scripted-model.js";
import {
  ASSISTANT,
  replyOf,
  say,
  startHarness,
  type AssistantState,
  type Harness,
} from "./test-harness.js";

describe("the briefing assistant", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it("plans, researches with its subagent, and drafts a briefing into the conversation", async () => {
    const client = harness.clientFor("dana");
    const thread = await client.threads.create();

    const state = await say(client, thread.thread_id, "Brief me on heat pumps.");

    expect(replyOf(state)).toContain(
      `Your briefing on heat pumps is ready in ${briefingFileFor("heat pumps")}`,
    );
    // It planned the work…
    expect(state.todos?.map((todo) => todo.content)).toContain("Research heat pumps");
    // …delegated the research to its subagent…
    expect(
      state.messages?.some(
        (message) =>
          message.type === "tool" &&
          String(message.content).includes("Research notes on heat pumps"),
      ),
    ).toBe(true);
    // …and saved the draft as a file in this conversation's state.
    expect(Object.keys(state.files ?? {})).toContain(briefingFileFor("heat pumps"));

    // A different conversation has its own files.
    const other = await client.threads.create();
    const elsewhere = await say(client, other.thread_id, "Email the briefing to sam@example.test");
    expect(replyOf(elsewhere)).toContain("There's no briefing in this conversation yet");
  });

  it("writes every future briefing the way you asked, in any conversation", async () => {
    const erin = harness.clientFor("erin");
    await say(
      erin,
      (await erin.threads.create()).thread_id,
      "Remember that I prefer bullet points.",
    );

    const recalled = await say(
      erin,
      (await erin.threads.create()).thread_id,
      "What do you remember about me?",
    );
    expect(replyOf(recalled)).toContain("I prefer bullet points");

    const briefing = await say(
      erin,
      (await erin.threads.create()).thread_id,
      "Brief me on solar panels.",
    );
    const draft = JSON.stringify(briefing.files?.[briefingFileFor("solar panels")]);
    expect(draft).toContain("- Why it matters now");

    // Preferences are per person: someone else's briefing is still written as prose.
    const finn = harness.clientFor("finn");
    const theirs = await say(
      finn,
      (await finn.threads.create()).thread_id,
      "Brief me on solar panels.",
    );
    expect(JSON.stringify(theirs.files?.[briefingFileFor("solar panels")])).not.toContain(
      "- Why it matters now",
    );
  });

  it("streams the research subagent separately from the assistant when asked", async () => {
    const client = harness.clientFor("dana");
    const thread = await client.threads.create();
    const events: string[] = [];

    for await (const chunk of client.runs.stream(thread.thread_id, ASSISTANT, {
      input: { messages: [{ role: "user", content: "Brief me on battery storage." }] },
      streamMode: ["updates"],
      streamSubgraphs: true,
    })) {
      events.push(chunk.event);
    }

    // The assistant's own frames keep the bare mode; the researcher's carry the `task` tool call's
    // namespace — which is what lets a UI show "researching…" apart from the conversation.
    expect(events).toContain("updates");
    expect(events.some((event) => /^updates\|tools:[\w-]+$/.test(event))).toBe(true);
  });

  it("streams only the assistant when subagent streaming is not asked for", async () => {
    const client = harness.clientFor("dana");
    const thread = await client.threads.create();
    const events: string[] = [];

    for await (const chunk of client.runs.stream(thread.thread_id, ASSISTANT, {
      input: { messages: [{ role: "user", content: "Brief me on battery storage." }] },
      streamMode: ["updates"],
    })) {
      events.push(chunk.event);
    }

    expect(events.filter((event) => event.includes("|"))).toEqual([]);
  });

  describe("emailing a briefing waits for your sign-off", () => {
    /** A conversation with a drafted briefing and an email waiting for a decision. */
    async function draftAndAskToEmail(client: Client): Promise<string> {
      const thread = await client.threads.create();
      await say(client, thread.thread_id, "Brief me on wind power.");
      await say(client, thread.thread_id, "Email the briefing to sam@example.test");
      const pending = await client.threads.getState(thread.thread_id);
      expect(pending.next.length).toBeGreaterThan(0);
      return thread.thread_id;
    }

    async function decide(client: Client, threadId: string, decision: object): Promise<string> {
      const state = (await client.runs.wait(threadId, ASSISTANT, {
        command: { resume: { decisions: [decision] } },
      })) as AssistantState;
      return replyOf(state);
    }

    it("sends it once approved", async () => {
      const client = harness.clientFor("gus");
      const threadId = await draftAndAskToEmail(client);

      expect(await decide(client, threadId, { type: "approve" })).toBe(
        'Emailed "Briefing: wind power" to sam@example.test.',
      );
    });

    it("sends it with your edits", async () => {
      const client = harness.clientFor("gus");
      const threadId = await draftAndAskToEmail(client);
      const edited = {
        type: "edit",
        editedAction: {
          name: "send_briefing",
          args: { to: "team@example.test", subject: "Wind power — for Monday", body: "…" },
        },
      };

      expect(await decide(client, threadId, edited)).toBe(
        'Emailed "Wind power — for Monday" to team@example.test.',
      );
    });

    it("does not send it once rejected", async () => {
      const client = harness.clientFor("gus");
      const threadId = await draftAndAskToEmail(client);

      const reply = await decide(client, threadId, { type: "reject", message: "Not yet." });
      expect(reply).toContain("I didn't send the briefing");
    });
  });

  it("runs a deep dive in the background and reports on it when asked", async () => {
    const client = harness.clientFor("hana");
    const thread = await client.threads.create();

    const started = await say(client, thread.thread_id, "Start a deep dive on grid-scale storage.");
    expect(replyOf(started)).toContain("I've started a deep dive on grid-scale storage");
    const task = Object.values(started.asyncTasks ?? {})[0]!;

    // The deep dive is an ordinary background run on this server, in a thread the caller owns.
    await expect
      .poll(async () => (await client.runs.get(task.threadId, task.runId)).status, {
        timeout: 10_000,
      })
      .toBe("success");

    const status = replyOf(await say(client, thread.thread_id, "How is the deep dive going?"));
    expect(status).toContain("success");
    expect(status).toContain("Research notes on grid-scale storage");

    const followed = await say(
      client,
      thread.thread_id,
      "Tell the deep dive to focus on costs in Europe.",
    );
    const nextRunId = followed.asyncTasks![task.taskId]!.runId;
    await expect
      .poll(async () => (await client.runs.get(task.threadId, nextRunId)).status)
      .toBe("success");
    expect(
      replyOf((await client.threads.getState(task.threadId)).values as AssistantState),
    ).toContain("focus on costs in Europe");
  });
});
