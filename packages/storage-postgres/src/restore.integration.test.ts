// The Postgres bulk-import path used by migration tooling (`skein import-langgraph --store
// postgres`). Unlike the public `create` repos — which stamp `created_at = now()` — `restore`
// inserts rows verbatim, preserving ids AND original timestamps, and is idempotent (existing rows
// are left untouched). Needs Docker (Testcontainers); see docs/testing.md.

import type { SkeinStoreSnapshot } from "@skein-js/core";
import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresSkeinStore } from "./postgres-skein-store.js";

let pg: StartedResource;
let store: PostgresSkeinStore;

beforeAll(async () => {
  pg = await startPostgres();
  store = await PostgresSkeinStore.connect(pg.url);
  await store.migrate();
});
afterAll(async () => {
  await store?.close();
  await pg?.stop();
});
beforeEach(async () => {
  await store.truncateAll();
});

const at = "2023-01-02T03:04:05.000Z";

/** A snapshot with one of every row, all timestamped `at`. */
function fixture(): SkeinStoreSnapshot {
  return {
    assistants: [
      [
        "a1",
        {
          assistant_id: "a1",
          graph_id: "agent",
          name: "Agent",
          description: undefined,
          config: {},
          context: {},
          metadata: { team: "core" },
          version: 3,
          created_at: at,
          updated_at: at,
        },
      ],
    ] as SkeinStoreSnapshot["assistants"],
    assistantVersions: [
      [
        JSON.stringify(["a1", 1]),
        {
          assistant_id: "a1",
          version: 1,
          graph_id: "agent",
          name: "Agent",
          description: undefined,
          config: {},
          context: {},
          metadata: { team: "core" },
          created_at: at,
        },
      ],
      [
        JSON.stringify(["a1", 3]),
        {
          assistant_id: "a1",
          version: 3,
          graph_id: "agent",
          name: "Agent",
          description: undefined,
          config: {},
          context: {},
          metadata: { team: "core" },
          created_at: at,
        },
      ],
    ] as SkeinStoreSnapshot["assistantVersions"],
    threads: [
      [
        "t1",
        {
          thread_id: "t1",
          status: "idle",
          metadata: {},
          values: { messages: ["hi"] },
          interrupts: {},
          created_at: at,
          updated_at: at,
          state_updated_at: at,
        },
      ],
    ] as SkeinStoreSnapshot["threads"],
    runs: [
      [
        "r1",
        {
          run_id: "r1",
          thread_id: "t1",
          assistant_id: "a1",
          status: "success",
          metadata: {},
          multitask_strategy: null,
          created_at: at,
          updated_at: at,
        },
      ],
    ] as SkeinStoreSnapshot["runs"],
    runKwargs: [["r1", { input: { foo: "bar" } }]],
    items: [
      [
        JSON.stringify([["memories"], "k1"]),
        {
          namespace: ["memories"],
          key: "k1",
          value: { note: "remember" },
          createdAt: at,
          updatedAt: at,
        },
      ],
    ] as SkeinStoreSnapshot["items"],
  };
}

describe("PostgresSkeinStore.restore", () => {
  it("bulk-loads every row, preserving ids and timestamps", async () => {
    await store.restore(fixture());

    const assistant = await store.assistants.get("a1");
    expect(assistant).toMatchObject({
      assistant_id: "a1",
      version: 3,
      created_at: at,
      updated_at: at,
    });

    // Version history is restored verbatim, newest-first.
    const versions = await store.assistants.listVersions("a1");
    expect(versions.map((v) => v.version)).toEqual([3, 1]);
    expect(versions[0]).toMatchObject({ assistant_id: "a1", version: 3, created_at: at });

    const thread = await store.threads.get("t1");
    expect(thread).toMatchObject({
      thread_id: "t1",
      values: { messages: ["hi"] },
      created_at: at,
      state_updated_at: at,
    });

    const run = await store.runs.get("r1");
    expect(run).toMatchObject({ run_id: "r1", thread_id: "t1", status: "success", created_at: at });
    expect(await store.runs.getKwargs("r1")).toEqual({ input: { foo: "bar" } });

    const item = await store.store.get(["memories"], "k1");
    expect(item).toMatchObject({ key: "k1", value: { note: "remember" }, createdAt: at });
  });

  it("is idempotent — re-running leaves existing rows untouched (ON CONFLICT DO NOTHING)", async () => {
    await store.restore(fixture());

    // A second import with the same ids but different values must not clobber what's there.
    const changed = fixture();
    changed.threads[0]![1].values = { messages: ["OVERWRITTEN"] };
    changed.assistants[0]![1].name = "Renamed";
    await store.restore(changed);

    const thread = await store.threads.get("t1");
    expect(thread?.values).toEqual({ messages: ["hi"] });
    const assistant = await store.assistants.get("a1");
    expect(assistant?.name).toBe("Agent");
  });

  it("skips a run whose thread isn't in the import instead of aborting the whole transaction", async () => {
    const snapshot = fixture();
    snapshot.runs.push([
      "orphan",
      {
        run_id: "orphan",
        thread_id: "missing",
        assistant_id: "a1",
        status: "success",
        metadata: {},
        multitask_strategy: null,
        created_at: at,
        updated_at: at,
      },
    ] as SkeinStoreSnapshot["runs"][number]);

    await store.restore(snapshot);

    // The orphan run is skipped (its thread would violate the FK), but everything valid imports.
    expect(await store.runs.get("orphan")).toBeNull();
    expect(await store.runs.get("r1")).not.toBeNull();
    expect(await store.threads.get("t1")).not.toBeNull();
    expect(await store.store.get(["memories"], "k1")).not.toBeNull();
  });
});
