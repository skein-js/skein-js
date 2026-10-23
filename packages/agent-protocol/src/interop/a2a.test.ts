import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SendMessageRequest, GetTaskRequest, TaskState, type Task } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { openSqliteStorage, type SqliteStorage } from "@skein-js/storage-sqlite";
import { expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolRuntime } from "../runtime.js";

it.each(["memory", "sqlite"])(
  "%s retains first-task output after later turns, pruning and reopening",
  async (backend) => {
    const directory = await mkdtemp(join(tmpdir(), "skein-a2a-"));
    let storage: SqliteStorage | undefined;
    const openDeps = async () => {
      if (backend === "memory") return createFixtureDeps();
      storage = await openSqliteStorage({ filename: join(directory, "state.sqlite") });
      const checkpointer = new SqliteSaver(storage.database);
      await checkpointer.getTuple({ configurable: { thread_id: "__initialize__" } });
      return createFixtureDeps({ store: storage.store, queue: storage.queue, checkpointer });
    };
    let runtime = createProtocolRuntime(await openDeps());
    await runtime.service.assistants.registerGraphAssistants();
    runtime.worker.start();
    const server = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const url = new URL(request.url!, `http://${request.headers.host}`);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        const result = await runtime.handlers.handleA2a!({
          method: request.method!,
          url: url.href,
          params: url.pathname.startsWith("/a2a/") ? { assistant_id: url.pathname.slice(5) } : {},
          query: Object.fromEntries(url.searchParams),
          body,
          headers: { "content-type": "application/json" },
        });
        response.writeHead(result.status, {
          "content-type": result.kind === "sse" ? "text/event-stream" : "application/json",
          ...result.headers,
        });
        if (result.kind === "json") response.end(JSON.stringify(result.body));
        else if (result.kind === "sse") {
          for await (const frame of result.events) response.write(frame);
          response.end();
        } else response.end();
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      const client = await new ClientFactory().createFromUrl(
        `http://127.0.0.1:${address.port}`,
        "/.well-known/agent-card.json?assistant_id=echo",
      );
      const first = (await client.sendMessage(
        SendMessageRequest.fromJSON({
          message: { messageId: "first", role: "ROLE_USER", parts: [{ data: { value: "first" } }] },
        }),
      )) as Task;
      expect(first.artifacts[0]?.parts[0]?.content?.value).toEqual({ value: "echo: first" });
      await client.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: "second",
            contextId: first.contextId,
            role: "ROLE_USER",
            parts: [{ data: { value: "second" } }],
          },
        }),
      );
      await runtime.service.threads.prune({
        threadIds: [first.contextId],
        strategy: "keep_latest",
      });
      if (storage) {
        await runtime.worker.stop();
        await storage.dispose();
        runtime = createProtocolRuntime(await openDeps());
        runtime.worker.start();
      }
      const restored = await client.getTask(GetTaskRequest.fromJSON({ id: first.id }));
      expect(restored.artifacts).toEqual(first.artifacts);
      const hitl = await new ClientFactory().createFromUrl(
        `http://127.0.0.1:${address.port}`,
        "/.well-known/agent-card.json?assistant_id=interrupting",
      );
      const interrupted = (await hitl.sendMessage(
        SendMessageRequest.fromJSON({
          message: { messageId: "ask", role: "ROLE_USER", parts: [{ data: { value: "ask" } }] },
        }),
      )) as Task;
      expect(interrupted.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      expect(interrupted.artifacts[0]?.name).toBe("Interrupt");
      const copied = await runtime.service.threads.copy(interrupted.contextId);
      const copiedRun = (await runtime.service.runs.listByThread(copied.thread_id))[0]!;
      const copiedTask = await hitl.getTask(GetTaskRequest.fromJSON({ id: copiedRun.run_id }));
      expect(copiedTask.contextId).toBe(copied.thread_id);
      expect(copiedTask.artifacts).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "Interrupt" })]),
      );
      const copiedResume = (await hitl.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: "copy-answer",
            role: "ROLE_USER",
            contextId: copied.thread_id,
            taskId: copiedRun.run_id,
            parts: [{ data: { resume: "copy" } }],
          },
        }),
      )) as Task;
      expect(copiedResume.id).toBe(copiedRun.run_id);
      expect(copiedResume.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      const resumed = (await hitl.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: "answer",
            role: "ROLE_USER",
            contextId: interrupted.contextId,
            taskId: interrupted.id,
            parts: [{ data: { resume: "yes" } }],
          },
        }),
      )) as Task;
      expect(resumed.id).toBe(interrupted.id);
      expect(resumed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(resumed.artifacts[0]?.parts[0]?.content?.value).toEqual({ value: "resumed: yes" });
      await expect(
        hitl.sendMessage(
          SendMessageRequest.fromJSON({
            message: {
              messageId: "stale",
              role: "ROLE_USER",
              taskId: interrupted.id,
              parts: [{ data: { resume: "again" } }],
            },
          }),
        ),
      ).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.worker.stop();
      await storage?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

it("rejects unsupported persistence before creating a thread or run", async () => {
  const deps = createFixtureDeps();
  const { recordResult: _write, getResult: _read, ...runs } = deps.store.runs;
  const runtime = createProtocolRuntime({ ...deps, store: { ...deps.store, runs } });
  await runtime.service.assistants.registerGraphAssistants();
  const response = await runtime.handlers.handleA2a!({
    method: "POST",
    url: "http://localhost/a2a/echo",
    params: { assistant_id: "echo" },
    query: {},
    headers: {},
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: { messageId: "one", role: "ROLE_USER", parts: [{ data: { value: "no" } }] },
      },
    },
  });
  expect(response).toMatchObject({ kind: "json", body: { error: { code: -32004 } } });
  expect(await deps.store.threads.list()).toEqual([]);
});

it("does not expose a computed artifact when cancellation wins result settlement", async () => {
  const deps = createFixtureDeps();
  const record = deps.store.runs.recordResult!;
  deps.store.runs.recordResult = async (id, result) => {
    await record(id, result);
    await deps.store.runs.setStatus(id, "cancelled");
  };
  const runtime = createProtocolRuntime(deps);
  await runtime.service.assistants.registerGraphAssistants();
  runtime.worker.start();
  try {
    const response = await runtime.handlers.handleA2a!({
      method: "POST",
      url: "http://localhost/a2a/echo",
      params: { assistant_id: "echo" },
      query: {},
      headers: {},
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: {
          message: {
            messageId: "cancel-race",
            role: "ROLE_USER",
            parts: [{ data: { value: "computed" } }],
          },
        },
      },
    });
    expect(response).toMatchObject({
      kind: "json",
      body: { result: { task: { status: { state: "TASK_STATE_CANCELED" } } } },
    });
    if (response.kind === "json")
      expect(
        (response.body as { result: { task: { artifacts?: unknown[] } } }).result.task.artifacts ??
          [],
      ).toEqual([]);
  } finally {
    await runtime.worker.stop();
  }
});
