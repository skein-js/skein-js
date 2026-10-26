import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPartitionedRunQueueConformance } from "@skein-js/test-support";
import {
  runSkeinStoreConformance,
  runRunQueueConformance,
  runStoreOptionsConformance,
} from "@skein-js/test-support";
import { afterEach, describe, expect, it } from "vitest";

import { openSqliteStorage, type SqliteStorage, type SqliteStorageOptions } from "./index.js";

const resources: { storage: SqliteStorage; directory: string }[] = [];
async function open(options: Partial<SqliteStorageOptions> = {}): Promise<SqliteStorage> {
  const directory = await mkdtemp(join(tmpdir(), "skein-sqlite-"));
  const storage = await openSqliteStorage({
    filename: join(directory, "state.sqlite"),
    ...options,
  });
  resources.push({ storage, directory });
  return storage;
}
afterEach(async () => {
  for (const { storage, directory } of resources.splice(0)) {
    await storage.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
runSkeinStoreConformance("sqlite", async (options) => (await open(options)).store);
runRunQueueConformance("sqlite", async () => (await open()).queue);

describe("durability and ownership", () => {
  it("preserves an unclaimed delayed job's original sequence and due time through deferral and reopening", async () => {
    const storage = await open();
    const filename = storage.database.name;
    const thread = await storage.store.threads.create();
    const due = new Date(Date.now() + 100).toISOString();
    const run = await storage.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "agent",
      kwargs: { queue_not_before: due },
    });
    const original = storage.database
      .prepare("SELECT sequence,due_at FROM skein_run_jobs WHERE run_id=?")
      .get(run.run_id);
    let probed = false;
    const first = storage.queue.consumePartitioned!(async () => {
      probed = true;
      return false;
    });
    await expect.poll(() => probed).toBe(true);
    await first.close();
    expect(
      storage.database
        .prepare("SELECT sequence,due_at FROM skein_run_jobs WHERE run_id=?")
        .get(run.run_id),
    ).toEqual(original);
    await storage.dispose();
    const reopened = await openSqliteStorage({ filename });
    let consumer;
    try {
      expect((await reopened.store.runs.get(run.run_id))?.status).toBe("pending");
      const handled: string[] = [];
      consumer = reopened.queue.consumePartitioned!(async (queued) => {
        handled.push(queued.run_id);
        return true;
      });
      await expect.poll(() => handled).toEqual([run.run_id]);
    } finally {
      await consumer?.close();
      await reopened.dispose();
    }
  });
  it("upgrades a populated version-3 file and preserves immutable results", async () => {
    const storage = await open();
    const filename = storage.database.name;
    const thread = await storage.store.threads.create();
    const run = await storage.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "agent",
      status: "success",
    });
    await storage.store.runs.recordResult!(run.run_id, { values: { answer: "retained" } });
    storage.database.exec(
      "DROP TABLE skein_native_resumes; DROP TABLE skein_native_dispatch; DROP INDEX skein_runs_inflight; DELETE FROM skein_migrations WHERE version=4",
    );
    await storage.dispose();
    const reopened = await openSqliteStorage({ filename });
    try {
      expect(await reopened.store.runs.getResult!(run.run_id)).toEqual({
        values: { answer: "retained" },
      });
      expect(
        await reopened.store.admission!.admitRun({
          scope: "upgrade",
          key: "first",
          fingerprint: "one",
          now: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          run: { thread_id: thread.thread_id, assistant_id: "agent" },
          guard: { requireNoActiveRun: true },
        }),
      ).toMatchObject({ threadId: thread.thread_id });
    } finally {
      await reopened.dispose();
    }
  });
  it("commits run intent and original due time together before enqueue", async () => {
    const storage = await open();
    const filename = storage.database.name;
    const thread = await storage.store.threads.create();
    const due = new Date(Date.now() + 60_000).toISOString();
    const run = await storage.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "agent",
      kwargs: {
        input: { value: 1 },
        stream_subgraphs: true,
        config: { configurable: { assistant_id: "legacy" } },
        auth_user: {
          identity: "alice",
          display_name: "Alice",
          is_authenticated: true,
          permissions: [],
        },
        queue_not_before: due,
      },
    });
    await storage.dispose();
    const reopened = await openSqliteStorage({ filename });
    try {
      expect((await reopened.store.runs.get(run.run_id))?.status).toBe("pending");
      expect(await reopened.store.runs.getKwargs(run.run_id)).toMatchObject({
        stream_subgraphs: true,
        config: { configurable: { assistant_id: "legacy" } },
        auth_user: { identity: "alice" },
      });
      await reopened.queue.enqueue(run);
      expect(
        reopened.database
          .prepare("SELECT due_at FROM skein_run_jobs WHERE run_id=?")
          .get(run.run_id),
      ).toEqual({ due_at: Date.parse(due) });
    } finally {
      await reopened.dispose();
    }
  });
  // 140 durable inserts plus reopening/recovery exceed the default 5s budget on Windows runners.
  it("fails every abandoned attempt beyond the page cap, preserving saved state and real interrupts", async () => {
    const storage = await open({ maxPageSize: 1 });
    const filename = storage.database.name;
    const thread = await storage.store.threads.create();
    await storage.store.threads.update(thread.thread_id, {
      values: { saved: true },
      interrupts: { node: [{ value: "approve", id: "interrupt" }] },
    });
    for (let index = 0; index < 140; index++)
      await storage.store.runs.create({ thread_id: thread.thread_id, assistant_id: "agent" });
    const paused = await storage.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "agent",
      status: "interrupted",
    });
    await storage.dispose();
    const reopened = await openSqliteStorage({ filename, maxPageSize: 1 });
    try {
      expect(await reopened.store.runs.listActiveRuns()).toEqual([]);
      expect((await reopened.store.runs.get(paused.run_id))?.status).toBe("interrupted");
      const failures = await reopened.store.runs.listByThread(thread.thread_id, {
        status: "error",
      });
      expect(failures).toHaveLength(140);
      expect(failures[0]?.error?.name).toBe("ProcessLostError");
      expect((await reopened.store.threads.get(thread.thread_id))?.values).toEqual({ saved: true });
    } finally {
      await reopened.dispose();
    }
  }, 30_000);
  it("rejects a second owner and releases ownership on idempotent disposal", async () => {
    const storage = await open();
    await expect(openSqliteStorage({ filename: storage.database.name })).rejects.toThrow(/locked/);
    await Promise.all([storage.dispose(), storage.dispose()]);
    const reopened = await openSqliteStorage({ filename: storage.database.name });
    await reopened.dispose();
  }, 10_000);
  it("rolls back cron advancement if run admission fails", async () => {
    const storage = await open();
    const cron = await storage.store.crons.create({
      assistant_id: "agent",
      schedule: "* * * * *",
      next_run_date: new Date().toISOString(),
    });
    await expect(
      storage.store.crons.claimAndCreateRun(
        cron.cron_id,
        { expectedSeq: 0, nextRunDate: null },
        { thread_id: "missing", assistant_id: "agent" },
      ),
    ).rejects.toThrow();
    expect((await storage.store.crons.get(cron.cron_id))?.next_run_date).toBe(cron.next_run_date);
  });
});

describe("configured retention", () => {
  it("applies default item TTL, hides expired items in search and namespaces, and sweeps", async () => {
    const storage = await open({ ttl: { defaultTtl: 0.0001 } });
    await storage.store.store.put(["expires"], "key", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await storage.store.store.search({})).toEqual([]);
    expect(await storage.store.store.listNamespaces()).toEqual([]);
    expect(await storage.store.store.sweepExpired()).toBe(1);
  });
  it.each([true, false])("refreshes only when refreshOnRead is %s", async (refreshOnRead) => {
    const storage = await open({ ttl: { defaultTtl: 60, refreshOnRead } });
    await storage.store.store.put(["ns"], "key", {});
    storage.database.prepare("UPDATE skein_items SET expires_at=?").run(Date.now() + 1000);
    const before = storage.database.prepare("SELECT expires_at FROM skein_items").get() as {
      expires_at: number;
    };
    await storage.store.store.get(["ns"], "key");
    const after = storage.database.prepare("SELECT expires_at FROM skein_items").get() as {
      expires_at: number;
    };
    expect(after.expires_at > before.expires_at).toBe(refreshOnRead);
  });
  it("applies default thread TTL without hiding a thread before service cleanup", async () => {
    const storage = await open({ threadTtl: { defaultTtl: 0.0001 } });
    const thread = await storage.store.threads.create();
    const pinned = await storage.store.threads.create({ ttl: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await storage.store.threads.listExpired({ now: new Date().toISOString(), limit: 10 }),
    ).toEqual([thread.thread_id]);
    expect(await storage.store.threads.get(thread.thread_id)).not.toBeNull();
    expect(await storage.store.threads.get(pinned.thread_id)).not.toBeNull();
  });
});

it("rolls back an entire migration when one statement fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-migration-"));
  const filename = join(directory, "state.sqlite");
  const { default: Database } = await import("better-sqlite3");
  let database = new Database(filename);
  database.exec("CREATE TABLE skein_items (collision TEXT)");
  database.close();
  try {
    await expect(openSqliteStorage({ filename })).rejects.toThrow(/already exists/);
    database = new Database(filename);
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name='skein_migrations'").get(),
    ).toBeUndefined();
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name='skein_assistants'").get(),
    ).toBeUndefined();
  } finally {
    if (database.open) database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("wakes an existing consumer for atomic admission before the later enqueue call", async () => {
  const storage = await open();
  const thread = await storage.store.threads.create();
  let received: (value: string) => void = () => {};
  const delivered = new Promise<string>((resolve) => {
    received = resolve;
  });
  const consumer = storage.queue.consume(async (job) => {
    expect(storage.database.inTransaction).toBe(false);
    expect(await storage.store.runs.get(job.run_id)).not.toBeNull();
    received(job.run_id);
  });
  try {
    const run = await storage.store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "agent",
      kwargs: { queue_not_before: new Date().toISOString() },
    });
    expect(await delivered).toBe(run.run_id);
  } finally {
    await consumer.close();
  }
});

it("repairs a failed attempt's busy thread without cancelling its queued backlog", async () => {
  const storage = await open();
  const filename = storage.database.name;
  const thread = await storage.store.threads.create({ status: "busy" });
  const due = new Date(Date.now() + 60_000).toISOString();
  const active = await storage.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "agent",
    status: "running",
    kwargs: { queue_not_before: due },
  });
  const pending = await storage.store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "agent",
    kwargs: { queue_not_before: due },
  });
  await storage.dispose();
  const reopened = await openSqliteStorage({ filename });
  try {
    expect((await reopened.store.runs.get(active.run_id))?.error?.name).toBe("ProcessLostError");
    expect((await reopened.store.threads.get(thread.thread_id))?.status).toBe("error");
    expect((await reopened.store.runs.get(pending.run_id))?.status).toBe("pending");
    expect(
      reopened.database
        .prepare("SELECT due_at,status FROM skein_run_jobs WHERE run_id=?")
        .get(pending.run_id),
    ).toEqual({ due_at: Date.parse(due), status: "waiting" });
  } finally {
    await reopened.dispose();
  }
});

runStoreOptionsConformance("sqlite", async (ttl) => (await open({ ttl })).store);

it("reopens per-item indexing, no-expiry writes and thread retention policy", async () => {
  const storage = await open({ ttl: { defaultTtl: 60 }, threadTtl: { defaultTtl: 60 } });
  const filename = storage.database.name;
  await storage.store.store.putWithOptions!(
    ["notes"],
    "private",
    { secret: "needle" },
    { index: false, ttl: null },
  );
  await storage.store.store.putWithOptions!(
    ["notes"],
    "title",
    { title: "needle", secret: "hidden" },
    { index: ["title"] },
  );
  const thread = await storage.store.threads.create({ ttl: 5, ttlStrategy: "keep_latest" });
  await storage.dispose();
  const reopened = await openSqliteStorage({
    filename,
    ttl: { defaultTtl: 60 },
    threadTtl: { defaultTtl: 60 },
  });
  try {
    expect(
      (await reopened.store.store.search({ prefix: ["notes"], query: "needle" })).map(
        (item) => item.key,
      ),
    ).toEqual(["title"]);
    expect(await reopened.store.store.search({ prefix: ["notes"], query: "hidden" })).toEqual([]);
    expect(
      reopened.database
        .prepare("SELECT expires_at FROM skein_items WHERE json_extract(body,'$.key')='private'")
        .get(),
    ).toEqual({ expires_at: null });
    expect(await reopened.store.threads.getTtl!(thread.thread_id)).toEqual({
      ttl: 5,
      strategy: "keep_latest",
    });
  } finally {
    await reopened.dispose();
  }
});

runPartitionedRunQueueConformance("sqlite", async () => (await open()).queue);
