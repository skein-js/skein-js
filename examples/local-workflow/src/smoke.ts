import { readFile } from "node:fs/promises";

import { Client } from "@langchain/langgraph-sdk";

import { sampleMeeting, type MeetingRecap } from "./meeting-notes.js";

async function verifyModelSettingsAuth(url: string, token: string): Promise<void> {
  for (const method of ["GET", "POST", "DELETE"]) {
    for (const headers of [{}, { "x-auth-scheme": "langsmith" }] as Record<string, string>[]) {
      const response = await fetch(`${url}/app/model`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      if (response.status !== 401)
        throw new Error(`Model settings accepted an unauthenticated ${method} caller`);
    }
  }
  const response = await fetch(`${url}/app/model`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const settings = (await response.json()) as Record<string, unknown>;
  if (
    !response.ok ||
    !["vertex", "gemini", "openai", "anthropic", "ollama"].includes(String(settings["provider"])) ||
    ["apiKey", "credentials", "access_token", "refresh_token"].some((field) => field in settings)
  )
    throw new Error("Model status must expose only non-secret connection preferences");
}

/** The same proof runs against packaged desktop backends and the ordinary server adapter. */
export async function smokeWorkflow(url: string, token: string): Promise<void> {
  await verifyModelSettingsAuth(url, token);
  for (const headers of [{}, { "x-auth-scheme": "langsmith" }] as Record<string, string>[]) {
    const response = await fetch(`${url}/threads/search`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });
    if (response.status !== 401)
      throw new Error(`Unauthenticated request returned ${response.status}`);
  }
  const client = new Client<MeetingRecap, Partial<MeetingRecap>>({
    apiUrl: url,
    defaultHeaders: { authorization: `Bearer ${token}` },
  });
  const thread = await client.threads.create({
    metadata: { demo: "meeting-follow-up", title: sampleMeeting.title },
  });
  let progress = false;
  const background = await client.runs.create(thread.thread_id, "workflow", {
    input: sampleMeeting,
    streamMode: ["values", "custom"],
    metadata: { demo_action: "Prepare recap in background" },
  });
  for await (const frame of client.runs.joinStream(thread.thread_id, background.run_id))
    if (frame.event === "custom") progress = true;
  const paused = await client.threads.getState(thread.thread_id);
  if (!paused.next.includes("approve") || !progress || paused.values.actions.length !== 3)
    throw new Error("Meeting recap did not stream progress and pause for review");
  const edited = paused.values.actions.map((action, index) =>
    index === 0 ? { ...action, due: "Thursday" } : action,
  );
  await client.runs.wait(thread.thread_id, "workflow", {
    command: { resume: { approved: true, actions: edited } },
  });
  const completed = await client.threads.getState(thread.thread_id);
  if (completed.values.outcome !== "saved" || !completed.values.savedPath.endsWith(".md"))
    throw new Error("Approved meeting recap was not saved");
  const markdown = await readFile(completed.values.savedPath, "utf8");
  if (
    !markdown.includes("Maya · Thursday") ||
    !markdown.includes(sampleMeeting.title) ||
    !markdown.includes("## Original notes")
  )
    throw new Error("Saved recap did not include the reviewed actions and original notes");
  const archived = await client.store.searchItems(["meeting-recaps"], { query: "Thursday" });
  if (!archived.items.some((item) => item.key === thread.thread_id))
    throw new Error("Reviewed recap was not searchable in the shared store");
  const history = await client.threads.getHistory(thread.thread_id);
  const draft = history.find(
    (checkpoint) => checkpoint.next.includes("approve") && checkpoint.values.outcome === "review",
  );
  if (!draft?.checkpoint.checkpoint_id) throw new Error("The earlier review checkpoint is missing");
  const branch = await client.threads.copy(thread.thread_id);
  await client.threads.update(branch.thread_id, {
    metadata: {
      demo: "meeting-follow-up",
      title: "Alternative launch plan",
      branched_from: thread.thread_id,
    },
  });
  await client.threads.updateState(branch.thread_id, {
    checkpointId: draft.checkpoint.checkpoint_id,
    asNode: "draft",
    values: { title: "Alternative launch plan", outcome: "review", savedPath: "" },
  });
  const forked = await client.runs.create(branch.thread_id, "workflow", {
    input: null,
    streamMode: ["values", "custom"],
  });
  for await (const _frame of client.runs.joinStream(branch.thread_id, forked.run_id)) {
    /* Wait for the real background attempt. */
  }
  const branchState = await client.threads.getState(branch.thread_id);
  if (!branchState.next.includes("approve") || branchState.values.actions[0]?.due !== "Friday")
    throw new Error("Branch did not restore the original review independently of the saved result");
  await client.runs.wait(branch.thread_id, "workflow", { command: { resume: { approved: true } } });
  const branchResult = await client.threads.getState(branch.thread_id);
  if (
    branchResult.values.savedPath === completed.values.savedPath ||
    (await readFile(completed.values.savedPath, "utf8")) !== markdown
  )
    throw new Error("Saving the alternative changed the original recap");
  const declined = await client.threads.create();
  await client.runs.wait(declined.thread_id, "workflow", { input: sampleMeeting });
  await client.runs.wait(declined.thread_id, "workflow", {
    command: { resume: { approved: false } },
  });
  const skipped = await client.threads.getState(declined.thread_id);
  if (skipped.values.outcome !== "dismissed" || skipped.values.savedPath)
    throw new Error("Skipping a recap should not save a file");
  const savedRecaps = await client.store.searchItems(["meeting-recaps"], { limit: 100 });
  if (savedRecaps.items.some((item) => item.key === declined.thread_id))
    throw new Error("A skipped review was added to the saved recap archive");
  console.log(
    "AGENT_PROTOCOL_OK background run, SSE, checkpoint branch, review resume, shared store, auth",
  );
}

export async function smokeReadingWorkflow(url: string, token: string): Promise<void> {
  const { sampleReading } = await import("./reading-sample.js");
  await verifyModelSettingsAuth(url, token);
  const client = new Client<MeetingRecap, Partial<MeetingRecap>>({
    apiUrl: url,
    defaultHeaders: { authorization: `Bearer ${token}` },
  });
  const thread = await client.threads.create({
    metadata: { demo: "reading-room", title: sampleReading.title },
  });
  await client.store.putItem(["reading-library"], thread.thread_id, {
    title: sampleReading.title,
    content: sampleReading.notes,
  });
  const run = await client.runs.create(thread.thread_id, "workflow", {
    input: { ...sampleReading, documentId: thread.thread_id, application: "reading" },
    streamMode: ["custom", "values"],
  });
  let progress = false;
  for await (const frame of client.runs.joinStream(thread.thread_id, run.run_id))
    if (frame.event === "custom") progress = true;
  const paused = await client.threads.getState(thread.thread_id);
  if (!progress || !paused.next.includes("approve") || !paused.values.quotes?.length)
    throw new Error("Reading brief did not reach review with source excerpts");
  await client.runs.wait(thread.thread_id, "workflow", {
    command: { resume: { approved: true, actions: [], summary: "Reviewed reading brief." } },
  });
  const saved = await client.threads.getState(thread.thread_id);
  const markdown = await readFile(saved.values.savedPath, "utf8");
  if (
    !markdown.includes("Reviewed reading brief.") ||
    !markdown.includes("## Original document") ||
    !markdown.includes("They did not work longer hours.")
  )
    throw new Error("Reading brief did not save its reviewed summary and verified source excerpt");
  const library = await client.store.searchItems(["reading-library"], { query: "switching" });
  if (!library.items.some((item) => item.key === thread.thread_id))
    throw new Error("Imported document is not searchable");
  const chat = await client.threads.create({ graphId: "assistant" });
  await client.runs.wait(chat.thread_id, "assistant", {
    input: {
      messages: [{ role: "user", content: "Explain the argument." }],
      meetingContext: JSON.stringify({ documentId: thread.thread_id }),
    },
  });
  const conversation = await client.threads.getState<{ messages: unknown[] }>(chat.thread_id);
  if (conversation.values.messages.length < 2)
    throw new Error("Reading conversation was not persisted");
  console.log(
    "READING_PROTOCOL_OK import, library search, background brief, source excerpts, review, conversation, auth",
  );
}
