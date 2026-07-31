// The Postgres execution gate against a real server. These are the assertions that cannot be made with
// a stub: an advisory lock only serializes across *connections*, so proving it takes two of them.

import { INFLIGHT_RUN_STATUSES, TERMINAL_RUN_STATUSES } from "@skein-js/core";
import { startPostgres, type StartedResource } from "@skein-js/test-support";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresPool, PostgresSkeinStore } from "./postgres-skein-store.js";
import { createPostgresThreadExecutionGate, threadLockKey } from "./thread-execution-gate.js";

let pg: StartedResource;

beforeAll(async () => {
  pg = await startPostgres();
});
afterAll(async () => {
  await pg?.stop();
});

/** Two gates on two pools — the same shape as two skein instances against one database. */
function twoInstances() {
  const pools = [createPostgresPool(pg.url, {}), createPostgresPool(pg.url, {})];
  return {
    gates: pools.map((pool) => createPostgresThreadExecutionGate(pool)),
    close: () => Promise.all(pools.map((pool) => pool.end())),
  };
}

describe("createPostgresThreadExecutionGate", () => {
  it("serializes two instances claiming the same thread", async () => {
    const { gates, close } = twoInstances();
    try {
      const [instanceA, instanceB] = gates as [
        ReturnType<typeof createPostgresThreadExecutionGate>,
        ReturnType<typeof createPostgresThreadExecutionGate>,
      ];
      const held = await instanceA.acquire("thread-1");

      // B's claim must not resolve while A holds it. Raced against a timer rather than asserted
      // immediately, so this fails if the lock is not actually taken rather than merely being slow.
      let bHasIt = false;
      const bClaim = instanceB.acquire("thread-1").then((lease) => {
        bHasIt = true;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(bHasIt).toBe(false);

      // …and it resolves once A lets go. Asserted as two facts rather than as a log of the order they
      // happened in: B's `then` runs on the microtask that A's unlock frees, so *which* of the two
      // continuations is observed first is scheduling detail, not the property under test.
      await held.release();
      const bLease = await bClaim;
      expect(bHasIt).toBe(true);
      await bLease.release();
    } finally {
      await close();
    }
  });

  it("lets two instances hold different threads at once", async () => {
    const { gates, close } = twoInstances();
    try {
      const [instanceA, instanceB] = gates as [
        ReturnType<typeof createPostgresThreadExecutionGate>,
        ReturnType<typeof createPostgresThreadExecutionGate>,
      ];
      const a = await instanceA.acquire("thread-1");
      // Would block forever if the lock were per-database rather than per-thread.
      const b = await instanceB.acquire("thread-2");
      await a.release();
      await b.release();
      expect(true).toBe(true);
    } finally {
      await close();
    }
  });

  it("frees a thread when the holding instance's connection dies", async () => {
    // The property that makes a session lock the right primitive: a crashed instance releases its
    // threads immediately, with no TTL to wait out and no lease to expire mid-run.
    const crashing = createPostgresPool(pg.url, {});
    const survivor = createPostgresPool(pg.url, {});
    try {
      await createPostgresThreadExecutionGate(crashing).acquire("thread-1");

      // Killed from the server side, which is what a crashed instance actually looks like to Postgres —
      // and, unlike `pool.end()`, it does not wait for the lock-holding client to be checked back in
      // (it never is; the gate holds it deliberately). Scoped to *this thread's* key so a test running
      // in parallel against the same container is untouched: an advisory lock's 64-bit key appears in
      // `pg_locks` split across `classid` (high 32 bits) and `objid` (low 32).
      const key = threadLockKey("thread-1");
      const high = Number(BigInt.asIntN(32, key >> 32n));
      const low = Number(BigInt.asUintN(32, key));
      const { rows } = await survivor.query<{ killed: boolean }>(
        `SELECT pg_terminate_backend(pid) AS killed FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND classid = $1 AND objid = $2`,
        [high, low],
      );
      expect(rows.length).toBe(1);

      const lease = await createPostgresThreadExecutionGate(survivor).acquire("thread-1");
      await lease.release();
    } finally {
      // `crashing` still has the (now dead) client checked out, so `end()` would wait for a release that
      // never comes. Destroying the pool's idle clients and abandoning it is what a crashed process does.
      crashing.removeAllListeners();
      await survivor.end();
    }
  });

  it("is idempotent on release", async () => {
    const { gates, close } = twoInstances();
    try {
      const lease = await gates[0]!.acquire("thread-1");
      await lease.release();
      // A double release must not unlock someone else's later claim on the same key.
      await expect(lease.release()).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });

  it("survives a statement timeout being configured, because the lock wait is exempt", async () => {
    // With `statement_timeout` applied to it, a run waiting behind a legitimately long peer would be
    // cancelled with 57014 instead of waiting its turn.
    const holder = createPostgresPool(pg.url, {});
    const waiter = createPostgresPool(pg.url, { statementTimeoutMs: 200 });
    try {
      const held = await createPostgresThreadExecutionGate(holder).acquire("thread-1");
      const claim = createPostgresThreadExecutionGate(waiter).acquire("thread-1");
      // Longer than the configured timeout, so an unexempted wait would already have been cancelled.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await held.release();

      const lease = await claim;
      await lease.release();
      expect(true).toBe(true);
    } finally {
      await holder.end();
      await waiter.end();
    }
  });
});

describe("threadLockKey", () => {
  it("is stable and fits a signed 64-bit Postgres parameter", () => {
    expect(threadLockKey("thread-1")).toBe(threadLockKey("thread-1"));
    const key = threadLockKey("thread-1");
    expect(key).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(key).toBeLessThan(2n ** 63n);
  });

  it("does not cluster ids that differ only in a suffix", () => {
    // Sequential and prefixed thread ids are the common shape, and a weak hash would map them onto
    // neighbouring keys — serializing unrelated threads across a whole deployment.
    const keys = new Set(
      Array.from({ length: 64 }, (_unused, index) => threadLockKey(`thread-${index}`)),
    );
    expect(keys.size).toBe(64);
  });
});

describe("runs_inflight_created_at_idx", () => {
  /** The plan Postgres chooses for `sql`, with sequential scans disabled. */
  async function planWithoutSeqScan(pool: Pool, sql: string, params: unknown[] = []) {
    const client = await pool.connect();
    try {
      // Disabling seq scans isolates the question this test is about: *can* the planner match the query
      // against the partial index's predicate. Left enabled, a small table is legitimately faster to scan
      // and the plan says nothing either way — which is exactly how the negated form's failure to match
      // stayed invisible.
      await client.query("SET enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally {
      client.release(true);
    }
  }

  it("is matched by the positive filter the drivers use, and not by a negated parameterized one", async () => {
    const store = await PostgresSkeinStore.connect(pg.url, {});
    await store.migrate();
    const pool = createPostgresPool(pg.url, {});
    try {
      const thread = await store.threads.create();
      for (let index = 0; index < 200; index += 1) {
        const run = await store.runs.create({ thread_id: thread.thread_id, assistant_id: "a" });
        if (index % 5 !== 0) await store.runs.setStatus(run.run_id, "success");
      }
      await pool.query("ANALYZE runs");

      // What `listActiveRuns` now sends: a literal list, built from INFLIGHT_RUN_STATUSES.
      const positive = await planWithoutSeqScan(
        pool,
        `SELECT * FROM runs WHERE status IN (${INFLIGHT_RUN_STATUSES.map((s) => `'${s}'`).join(", ")})
           ORDER BY created_at, run_id LIMIT 1000`,
      );
      expect(positive).toContain("runs_inflight_created_at_idx");

      // What it sent before, and why migration 0006 was dead weight: the planner cannot prove a negated,
      // parameterized filter implies the index predicate, so it cannot use the index *even when a
      // sequential scan is off the table*. This is the assertion that pins the coupling.
      const negated = await planWithoutSeqScan(
        pool,
        `SELECT * FROM runs WHERE NOT (status = ANY($1::text[]))
           ORDER BY created_at, run_id LIMIT 1000`,
        [TERMINAL_RUN_STATUSES],
      );
      expect(negated).not.toContain("runs_inflight_created_at_idx");
    } finally {
      await pool.end();
      await store.close();
    }
  });
});
