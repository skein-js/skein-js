// Unit test for the LangGraph in-memory dev-state importer. We build the three files exactly as
// `@langchain/langgraph-api` writes them — superjson-encoded, with the same `Uint8Array` ⇄ base64
// custom transformer and realistic checkpoint blobs from a real `MemorySaver` — into a temp
// `.langgraph_api/`, then assert `readLanggraphDevState` reconstructs skein's snapshot and
// `loadSnapshotIntoStore` loads it into a live store + checkpointer with nothing lost.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemorySaver, emptyCheckpoint } from "@langchain/langgraph";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { SuperJSON } from "superjson";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeSnapshot,
  loadSnapshotIntoStore,
  readLanggraphDevState,
} from "./langgraph-import.js";

/** A superjson encoder configured like `@langchain/langgraph-api`'s writer. */
const encoder = new SuperJSON();
encoder.registerCustom<Uint8Array, string>(
  {
    isApplicable: (value): value is Uint8Array => value instanceof Uint8Array,
    serialize: (value) => Buffer.from(value).toString("base64"),
    deserialize: (value) => new Uint8Array(Buffer.from(value, "base64")),
  },
  "Uint8Array",
);

const createdAt = new Date("2023-01-02T03:04:05.000Z");
const iso = createdAt.toISOString();

let dir: string;
let apiDir: string;

/** Write a fully-populated `.langgraph_api/` (ops + store + checkpointer) into `apiDir`. */
async function writeFixture(): Promise<{ checkpointId: string }> {
  const ops = {
    assistants: {
      a1: {
        assistant_id: "a1",
        graph_id: "agent",
        name: "Research Agent",
        description: "does research",
        config: { configurable: { model: "gemini" } },
        context: {},
        metadata: { team: "core" },
        version: 4,
        created_at: createdAt,
        updated_at: createdAt,
      },
    },
    threads: {
      t1: {
        thread_id: "t1",
        status: "idle",
        metadata: { topic: "skein" },
        values: { messages: [{ role: "human", content: "hi" }] },
        interrupts: {},
        created_at: createdAt,
        updated_at: createdAt,
      },
    },
    runs: {
      r1: {
        run_id: "r1",
        thread_id: "t1",
        assistant_id: "a1",
        status: "success",
        metadata: {},
        multitask_strategy: "reject",
        kwargs: { input: { messages: ["hi"] }, webhook: "https://drop.me" },
        created_at: createdAt,
        updated_at: createdAt,
      },
    },
    assistant_versions: [
      {
        assistant_id: "a1",
        version: 4,
        graph_id: "agent",
        name: "Research Agent",
        description: "does research",
        config: { configurable: { model: "gemini" } },
        context: {},
        metadata: { team: "core" },
        created_at: createdAt,
      },
    ],
    retry_counter: {},
  };

  const storeData = new Map([
    [
      "memories",
      new Map([
        [
          "k1",
          {
            namespace: ["memories"],
            key: "k1",
            value: { note: "user likes TypeScript" },
            createdAt,
            updatedAt: createdAt,
          },
        ],
      ]),
    ],
  ]);

  // Realistic checkpoint blobs: a real MemorySaver produces exactly the storage/writes maps
  // LangGraph persists.
  const lgSaver = new MemorySaver();
  const config = { configurable: { thread_id: "t1", checkpoint_ns: "" } };
  const checkpoint = emptyCheckpoint();
  const stored = await lgSaver.put(config, checkpoint, { source: "input", step: 0, parents: {} });
  await lgSaver.putWrites(stored, [["messages", { role: "ai", content: "hello" }]], "task-1");

  writeFileSync(path.join(apiDir, ".langgraphjs_ops.json"), encoder.stringify(ops));
  writeFileSync(
    path.join(apiDir, ".langgraphjs_api.store.json"),
    encoder.stringify({ data: storeData, vectors: new Map() }),
  );
  writeFileSync(
    path.join(apiDir, ".langgraphjs_api.checkpointer.json"),
    encoder.stringify({ storage: lgSaver.storage, writes: lgSaver.writes }),
  );

  return { checkpointId: checkpoint.id };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "skein-lg-import-"));
  apiDir = path.join(dir, ".langgraph_api");
  mkdirSync(apiDir, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readLanggraphDevState", () => {
  it("returns null when the directory has no LangGraph files", async () => {
    expect(await readLanggraphDevState(path.join(dir, "does-not-exist"))).toBeNull();
  });

  it("coerces a non-terminal imported run to a terminal status so the thread isn't frozen", async () => {
    // A run captured mid-flight by `langgraph dev` persists as pending/running; left that way it
    // would make hasActiveRun() report the thread busy forever.
    const ops = {
      assistants: {},
      threads: {
        t: { thread_id: "t", status: "busy", created_at: createdAt, updated_at: createdAt },
      },
      runs: {
        r: {
          run_id: "r",
          thread_id: "t",
          assistant_id: "a",
          status: "running",
          created_at: createdAt,
          updated_at: createdAt,
        },
      },
    };
    writeFileSync(path.join(apiDir, ".langgraphjs_ops.json"), encoder.stringify(ops));

    const snapshot = await readLanggraphDevState(apiDir);
    const run = snapshot?.store.runs[0]?.[1];
    expect(run?.status).toBe("error"); // was "running" (non-terminal) → coerced to terminal
  });

  it("rejects a malformed LangGraph ops file at the boundary", async () => {
    // A run row missing its required thread_id should fail Zod validation, not slip through to a
    // corrupt row / FK violation later.
    writeFileSync(
      path.join(apiDir, ".langgraphjs_ops.json"),
      encoder.stringify({ runs: { r: { run_id: "r", assistant_id: "a" } } }),
    );
    await expect(readLanggraphDevState(apiDir)).rejects.toThrow(/Invalid LangGraph/);
  });

  it("maps ops, store items, and checkpoints into a DevStateSnapshot", async () => {
    await writeFixture();
    const snapshot = await readLanggraphDevState(apiDir);
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(describeSnapshot(snapshot)).toEqual({
      assistants: 1,
      threads: 1,
      runs: 1,
      items: 1,
      checkpointedThreads: 1,
    });

    const [, assistant] = snapshot.store.assistants[0]!;
    expect(assistant).toMatchObject({
      assistant_id: "a1",
      graph_id: "agent",
      name: "Research Agent",
      version: 4,
      created_at: iso,
      updated_at: iso,
    });

    // Version history is imported (keyed by [assistant_id, version]) so getVersions/rollback work.
    expect(snapshot.store.assistantVersions).toHaveLength(1);
    const [versionKey, version] = snapshot.store.assistantVersions[0]!;
    expect(versionKey).toBe(JSON.stringify(["a1", 4]));
    expect(version).toMatchObject({ assistant_id: "a1", version: 4, name: "Research Agent" });

    const [, thread] = snapshot.store.threads[0]!;
    expect(thread).toMatchObject({
      thread_id: "t1",
      status: "idle",
      values: { messages: [{ role: "human", content: "hi" }] },
      state_updated_at: iso,
    });

    // runKwargs keeps skein's replay fields, and now carries LangGraph's `webhook` through so an
    // imported run still fires its completion webhook.
    const [, kwargs] = snapshot.store.runKwargs[0]!;
    expect(kwargs).toEqual({
      input: { messages: ["hi"] },
      command: undefined,
      config: undefined,
      context: undefined,
      stream_mode: undefined,
      interrupt_before: undefined,
      interrupt_after: undefined,
      webhook: "https://drop.me",
    });

    const [id, item] = snapshot.store.items[0]!;
    expect(id).toBe(JSON.stringify([["memories"], "k1"]));
    expect(item).toEqual({
      namespace: ["memories"],
      key: "k1",
      value: { note: "user likes TypeScript" },
      createdAt: iso,
      updatedAt: iso,
    });
  });
});

describe("loadSnapshotIntoStore", () => {
  it("loads resources and checkpoint history into a live store + checkpointer", async () => {
    const { checkpointId } = await writeFixture();
    const snapshot = await readLanggraphDevState(apiDir);
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    const store = new MemorySkeinStore();
    const checkpointer = new MemorySaver();
    await loadSnapshotIntoStore(snapshot, store, checkpointer);

    // Resource rows preserved (ids + timestamps).
    const assistant = await store.assistants.get("a1");
    expect(assistant?.created_at).toBe(iso);
    const thread = await store.threads.get("t1");
    expect(thread?.values).toEqual({ messages: [{ role: "human", content: "hi" }] });
    expect(thread?.created_at).toBe(iso);
    const run = await store.runs.get("r1");
    expect(run?.status).toBe("success");
    expect(await store.runs.getKwargs("r1")).toMatchObject({ input: { messages: ["hi"] } });
    const item = await store.store.get(["memories"], "k1");
    expect(item?.value).toEqual({ note: "user likes TypeScript" });

    // Checkpoint history carried over: the latest tuple + its pending write are readable.
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: "t1" } });
    expect(tuple?.checkpoint.id).toBe(checkpointId);
    expect(tuple?.pendingWrites).toEqual([
      ["task-1", "messages", { role: "ai", content: "hello" }],
    ]);
  });
});
