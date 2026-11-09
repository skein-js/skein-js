import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCodeInterpreterMiddleware } from "@langchain/quickjs";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedSqliteGraphs } from "@skein-js/local";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import {
  createDeepAgent,
  createFilesystemMiddleware,
  createSummarizationMiddleware,
  FilesystemBackend,
} from "deepagents";
import { tool } from "langchain";
import { expect, it } from "vitest";
import { z } from "zod";
import { FixtureModel } from "./fixture-model.mjs";

async function serve(graph) {
  const runtime = createProtocolRuntime(embedInMemoryGraphs({ agent: graph }));
  await runtime.service.assistants.registerGraphAssistants();
  return {
    runtime,
    run: async (input, threadId) => {
      const outcome = await runtime.service.runs.createWait({
        assistant_id: "agent",
        input,
        ...(threadId ? { thread_id: threadId } : {}),
      });
      if (outcome.result.__error__) throw new Error(JSON.stringify(outcome.result.__error__));
      return outcome;
    },
  };
}

it("discovers, pins and refreshes upstream skills without Skein-specific middleware", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-candidate-skills-"));
  await mkdir(join(directory, "skills/fixture"), { recursive: true });
  const filename = join(directory, "skills/fixture/SKILL.md");
  const skill = (text) =>
    `---\nname: fixture\ndescription: Candidate fixture skill\n---\n${text}\n`;
  await writeFile(filename, skill("INITIAL_SKILL_INSTRUCTION"));
  try {
    const model = new FixtureModel();
    const { run } = await serve(
      createDeepAgent({
        model,
        backend: new FilesystemBackend({ rootDir: directory, virtualMode: true }),
        skills: ["/skills/"],
      }),
    );
    const first = await run({
      messages: [{ role: "user", content: "Use the fixture skill" }],
      pinnedSkills: ["fixture"],
    });
    expect(JSON.stringify(model.seen.at(-1))).toContain("INITIAL_SKILL_INSTRUCTION");
    expect(JSON.stringify(first.result.skillsMetadata)).toContain("fixture");
    await writeFile(filename, skill("REFRESHED_SKILL_INSTRUCTION"));
    await run(
      {
        messages: [{ role: "user", content: "Reload the fixture skill" }],
        skillsMetadata: null,
        pinnedSkills: ["fixture"],
      },
      first.threadId,
    );
    expect(JSON.stringify(model.seen.at(-1))).toContain("REFRESHED_SKILL_INSTRUCTION");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("enforces upstream filesystem permissions and retains permitted file writes", async () => {
  const model = new FixtureModel([
    { name: "read_file", args: { file_path: "/private/secret.txt" } },
    { name: "write_file", args: { file_path: "/public/note.txt", content: "permitted" } },
  ]);
  const { run } = await serve(
    createDeepAgent({
      model,
      permissions: [{ operations: ["read"], paths: ["/private/**"], mode: "deny" }],
    }),
  );
  const timestamp = new Date().toISOString();
  const { result } = await run({
    messages: [{ role: "user", content: "Read private then write public" }],
    files: {
      "/private/secret.txt": {
        content: "SECRET_MUST_NOT_REACH_MODEL",
        mimeType: "text/plain",
        created_at: timestamp,
        modified_at: timestamp,
      },
    },
  });
  const tools = model.seen.flat().filter((message) => message.getType() === "tool");
  expect(JSON.stringify(tools)).not.toContain("SECRET_MUST_NOT_REACH_MODEL");
  expect(JSON.stringify(tools)).toMatch(/denied|permission/i);
  expect(JSON.stringify(result.files["/public/note.txt"])).toContain("permitted");
});

it("offloads a real large tool result with upstream filesystem middleware", async () => {
  const model = new FixtureModel([{ name: "large_result", args: {} }]);
  const large = tool(async () => "OFFLOAD_CONTENT_".repeat(2000), {
    name: "large_result",
    description: "Large fixture result",
    schema: z.object({}),
  });
  const { run } = await serve(
    createDeepAgent({
      model,
      tools: [large],
      middleware: [createFilesystemMiddleware({ toolTokenLimitBeforeEvict: 20 })],
    }),
  );
  const { result } = await run({ messages: [{ role: "user", content: "Get the large result" }] });
  expect(Object.keys(result.files)).toContainEqual(expect.stringContaining("tool_results"));
  const latestTools = model.seen.at(-1).filter((message) => message.getType() === "tool");
  expect(JSON.stringify(latestTools).length).toBeLessThan(5000);
  expect(JSON.stringify(result.files)).toContain("OFFLOAD_CONTENT_");
});

it("summarizes and offloads history with the upstream summarization middleware", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-candidate-history-"));
  try {
    const model = new FixtureModel();
    const backend = new FilesystemBackend({ rootDir: directory, virtualMode: true });
    const { run } = await serve(
      createDeepAgent({
        model,
        backend,
        middleware: [
          createSummarizationMiddleware({
            backend,
            trigger: { type: "messages", value: 4 },
            keep: { type: "messages", value: 2 },
          }),
        ],
      }),
    );
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `Historical message ${index}`,
    }));
    messages.push({ role: "user", content: "Continue after summarizing" });
    await run({ messages });
    expect(model.seen.length).toBeGreaterThan(1);
    expect(JSON.stringify(model.seen.at(-1))).toContain("Fixture completed.");
    const history = await backend.ls("/conversation_history/");
    expect(history.files.length).toBeGreaterThan(0);
    expect(JSON.stringify(await backend.readRaw(history.files[0].path))).toContain(
      "Historical message",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("runs the official QuickJS interpreter tool inside the served graph", async () => {
  const model = new FixtureModel([
    { name: "eval", args: { code: "[1,2,3].reduce((sum,value)=>sum+value,0)" } },
  ]);
  const { run } = await serve(
    createDeepAgent({ model, middleware: [createCodeInterpreterMiddleware()] }),
  );
  const { result } = await run({ messages: [{ role: "user", content: "Compute the sum" }] });
  expect(JSON.stringify(result.messages.filter((message) => message.type === "tool"))).toContain(
    "6",
  );
});

it("reopens upstream binary file checkpoint state from a real SQLite file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-candidate-binary-"));
  const filename = join(directory, "state.sqlite");
  const graph = createDeepAgent({ model: new FixtureModel() });
  let embedded = await embedSqliteGraphs({ agent: graph }, { sqlitePath: filename });
  let runtime = createProtocolRuntime(embedded.deps);
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const timestamp = new Date().toISOString();
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const { threadId } = await runtime.service.runs.createWait({
      assistant_id: "agent",
      input: {
        messages: [{ role: "user", content: "Retain this file" }],
        files: {
          "/image.png": {
            content: bytes,
            mimeType: "image/png",
            created_at: timestamp,
            modified_at: timestamp,
          },
        },
      },
    });
    const run = await embedded.deps.store.runs.latestForThread(threadId);
    if (run.error) throw new Error(JSON.stringify(run.error));
    await runtime.worker.stop();
    await embedded.dispose();
    embedded = await embedSqliteGraphs({ agent: graph }, { sqlitePath: filename });
    runtime = createProtocolRuntime(embedded.deps);
    const checkpoint = await embedded.deps.checkpointer.getTuple({
      configurable: { thread_id: threadId },
    });
    expect(checkpoint.checkpoint.channel_values.files["/image.png"].content).toEqual(bytes);
    expect(
      (await runtime.service.threads.getState(threadId)).values.files["/image.png"].mimeType,
    ).toBe("image/png");
  } finally {
    await runtime.worker.stop();
    await embedded.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
