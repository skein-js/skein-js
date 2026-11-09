import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { openSqliteStorage } from "@skein-js/storage-sqlite";
import { expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolRuntime } from "../runtime.js";

it.each(["memory", "sqlite"])(
  "uses a programmatically supplied upstream %s saver for history, copy and prune without taking its ownership",
  async (backend) => {
    const directory = await mkdtemp(join(tmpdir(), "skein-saver-proof-"));
    const storage =
      backend === "sqlite"
        ? await openSqliteStorage({ filename: join(directory, "state.sqlite") })
        : undefined;
    const saver = storage ? new SqliteSaver(storage.database) : new MemorySaver();
    // Public setup/read, including upstream lazy initialization. The host owns saver resources.
    await saver.getTuple({ configurable: { thread_id: "setup" } });
    const runtime = createProtocolRuntime(
      createFixtureDeps({
        checkpointer: saver,
        ...(storage ? { store: storage.store, queue: storage.queue } : {}),
      }),
    );
    try {
      await runtime.service.assistants.registerGraphAssistants();
      const { threadId } = await runtime.service.runs.createWait({
        assistant_id: "echo",
        input: { value: "one" },
      });
      await runtime.service.runs.createWait({
        thread_id: threadId,
        assistant_id: "echo",
        input: { value: "two" },
      });
      const history = await runtime.service.threads.history(threadId);
      expect(history.length).toBeGreaterThan(1);
      const copy = await runtime.service.threads.copy(threadId);
      expect((await runtime.service.threads.getState(copy.thread_id)).values).toEqual({
        value: "echo: two",
      });
      expect(await runtime.service.threads.history(copy.thread_id)).toHaveLength(history.length);
      await runtime.service.threads.prune({ threadIds: [threadId], strategy: "keep_latest" });
      expect(await runtime.service.threads.history(threadId)).toHaveLength(1);
      expect((await runtime.service.threads.getState(threadId)).values).toEqual({
        value: "echo: two",
      });
      await runtime.worker.stop();
      expect(
        (await saver.getTuple({ configurable: { thread_id: copy.thread_id } }))?.checkpoint,
      ).toBeDefined();
      if (storage) expect(storage.database.open).toBe(true);
    } finally {
      await runtime.worker.stop();
      await storage?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
