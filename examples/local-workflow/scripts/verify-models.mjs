import { log } from "node:console";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@langchain/langgraph-sdk";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedSqliteGraphs } from "@skein-js/local";

import {
  buildDailyPlanner,
  sampleMeeting,
  sampleTasks,
  startWorkflowServer,
} from "../dist/index.js";

async function verifyDesktop(application) {
  const directory = await mkdtemp(join(tmpdir(), "skein-model-proof-"));
  const token = randomBytes(32).toString("hex");
  const server = await startWorkflowServer(directory, token, { application });
  const client = new Client({
    apiUrl: server.url,
    defaultHeaders: { authorization: `Bearer ${token}` },
  });
  try {
    const thread = await client.threads.create();
    const input =
      application === "meetings"
        ? sampleMeeting
        : {
            title: "An experiment in focus",
            notes:
              "A team grouped non-urgent requests into two daily check-ins and kept a separate channel for urgent support. They did not work longer hours. After a month they finished more planned work, but the experiment had no comparison group.",
            documentId: thread.thread_id,
          };
    if (application === "reading")
      await client.store.putItem(["reading-library"], thread.thread_id, {
        title: input.title,
        content: input.notes,
      });
    const tools = new Set();
    for await (const frame of client.runs.stream(thread.thread_id, "workflow", {
      input,
      streamMode: ["custom", "values"],
    })) {
      if (frame.event === "error") throw new Error(JSON.stringify(frame.data));
      if (frame.event === "custom" && frame.data.type === "tool" && frame.data.phase === "end")
        tools.add(frame.data.name);
    }
    const state = await client.threads.getState(thread.thread_id);
    if (!state.next.includes("approve") || !state.values.summary || !tools.size)
      throw new Error(`${application}: expected real tools and a generated review`);
    await client.runs.wait(thread.thread_id, "workflow", {
      command: { resume: { approved: true } },
    });
    const saved = await client.threads.getState(thread.thread_id);
    if (!(await readFile(saved.values.savedPath, "utf8")).includes(input.notes))
      throw new Error("Saved output lost its original source");
    const chat = await client.threads.create();
    let chunks = 0;
    for await (const frame of client.runs.stream(chat.thread_id, "assistant", {
      input: {
        messages: [
          {
            role: "user",
            content: "In two sentences, explain one open question about this document.",
          },
        ],
        meetingContext: JSON.stringify(input),
      },
      streamMode: ["messages", "values", "custom"],
    })) {
      if (frame.event === "error") throw new Error(JSON.stringify(frame.data));
      if (frame.event.startsWith("messages")) chunks++;
    }
    const conversation = await client.threads.getState(chat.thread_id);
    if (!chunks || conversation.values.messages.length < 2)
      throw new Error("Assistant conversation did not stream and persist");
    log(
      `${application}: real tools [${[...tools].join(", ")}], generated review, approved file, ${chunks} chat frames`,
    );
  } finally {
    await server.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
async function verifyPlanner() {
  const directory = await mkdtemp(join(tmpdir(), "skein-planner-model-proof-"));
  const tasks = join(directory, "tasks.md");
  await writeFile(tasks, sampleTasks);
  const embedded = await embedSqliteGraphs(
    { planner: buildDailyPlanner(directory, tasks) },
    { sqlitePath: join(directory, "state.sqlite") },
  );
  const runtime = createProtocolRuntime(embedded.deps, { scheduler: { enabled: false } });
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const thread = await runtime.service.threads.create();
    const tools = new Set();
    const stream = await runtime.service.runs.createStream({
      thread_id: thread.thread_id,
      assistant_id: "planner",
      input: {
        request:
          "Read my task inbox and recent plans. Plan a practical day within my available time.",
      },
      stream_mode: ["custom", "values"],
    });
    for await (const frame of stream.frames) {
      if (frame.event === "error") throw new Error(JSON.stringify(frame.data));
      if (frame.event === "custom" && frame.data.type === "tool" && frame.data.phase === "end")
        tools.add(frame.data.name);
    }
    const state = await runtime.service.threads.getState(thread.thread_id);
    if (
      !state.next.includes("approve") ||
      !state.values.blocks?.length ||
      !tools.has("read_task_inbox")
    )
      throw new Error("Planner did not read the selected file and generate a review");
    await runtime.service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "planner",
      command: { resume: { approved: true } },
    });
    const completed = await runtime.service.threads.getState(thread.thread_id);
    if (!(await readFile(completed.values.savedPath, "utf8")).includes(state.values.blocks[0].task))
      throw new Error("Approved plan was not saved");
    if ((await readFile(tasks, "utf8")) !== sampleTasks)
      throw new Error("Planner changed the task inbox");
    log(
      `planner: real tools [${[...tools].join(", ")}], generated review, approved plan, unchanged task inbox`,
    );
  } finally {
    await runtime.worker.stop();
    await embedded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
await verifyDesktop("meetings");
await verifyDesktop("reading");
await verifyPlanner();
log("LIVE_MODELS_OK");
