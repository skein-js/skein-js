// The schema migration runner, against a real Postgres. The contract that matters most is backward
// compatibility: databases migrated by node-pg-migrate through 0.9.x must upgrade in place, so these
// tests assert the ledger table shape, the migration names, and that an already-applied migration is
// never re-run. Needs Docker (Testcontainers); see docs/testing.md.

import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SKEIN_MIGRATIONS } from "./migrations.generated.js";
import { PostgresSkeinStore } from "./postgres-skein-store.js";
import { applySkeinMigrations } from "./run-migrations.js";

/**
 * The ledger DDL node-pg-migrate created through 0.9.x, written out literally. Reproducing it here
 * rather than importing it is the point: it is the frozen legacy shape the runner must stay
 * compatible with, so it must not move when our own DDL does.
 */
const LEGACY_LEDGER_DDL = `CREATE TABLE "public"."skein_migrations" (
  id SERIAL PRIMARY KEY,
  name varchar(255) NOT NULL,
  run_on timestamp NOT NULL
)`;

let pg: StartedResource;
const openPools: Pool[] = [];

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);
afterAll(async () => {
  await pg?.stop();
});
afterEach(async () => {
  await Promise.all(openPools.splice(0).map((pool) => pool.end()));
});

/** A virgin database on the shared container, so each case migrates from nothing. */
async function createScratchDatabase(name: string): Promise<string> {
  const admin = new Pool({ connectionString: pg.url });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(pg.url);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A pool on a fresh scratch database, closed automatically after the test. */
async function connectScratch(name: string): Promise<Pool> {
  const pool = new Pool({ connectionString: await createScratchDatabase(name) });
  openPools.push(pool);
  return pool;
}

const readLedger = async (pool: Pool): Promise<{ name: string; run_on: Date }[]> =>
  (
    await pool.query<{ name: string; run_on: Date }>(
      `SELECT name, run_on FROM "public"."skein_migrations" ORDER BY run_on, id`,
    )
  ).rows;

const tableExists = async (pool: Pool, table: string): Promise<boolean> =>
  (
    await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    )
  ).rowCount === 1;

describe("applySkeinMigrations", () => {
  it("migrates a fresh database and records every migration", async () => {
    const pool = await connectScratch("migrate_fresh");

    expect(await applySkeinMigrations(pool)).toEqual([
      "0001_init",
      "0002_store_ttl",
      "0003_assistant_versions",
      "0004_run_error",
      "0005_performance_indexes",
    ]);

    expect((await readLedger(pool)).map((row) => row.name)).toEqual([
      "0001_init",
      "0002_store_ttl",
      "0003_assistant_versions",
      "0004_run_error",
      "0005_performance_indexes",
    ]);

    for (const table of ["assistants", "assistant_versions", "threads", "runs", "store_items"]) {
      expect(await tableExists(pool, table), `${table} should exist`).toBe(true);
    }

    const storeItemColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'store_items'`,
    );
    expect(storeItemColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(["ttl_minutes", "expires_at"]),
    );

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'store_items'`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain("store_items_expires_at_idx");

    // 0004 hangs the failure reason off both the run and the thread.
    const failureColumns = await pool.query<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type FROM information_schema.columns
        WHERE column_name = 'error' AND table_name IN ('runs', 'threads')
        ORDER BY table_name`,
    );
    expect(failureColumns.rows).toEqual([
      { table_name: "runs", data_type: "jsonb" },
      { table_name: "threads", data_type: "text" },
    ]);
  });

  it("creates the performance indexes, and drops the one they supersede", async () => {
    const pool = await connectScratch("migrate_indexes");
    await applySkeinMigrations(pool);

    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('threads', 'assistants', 'runs', 'store_items')`,
    );
    const indexes = rows.map((row) => row.indexname);

    expect(indexes).toEqual(
      expect.arrayContaining([
        "threads_created_at_thread_id_idx",
        "threads_updated_at_thread_id_idx",
        "threads_status_created_at_idx",
        "threads_metadata_idx",
        "assistants_metadata_idx",
        "assistants_created_at_assistant_id_idx",
        "runs_thread_id_created_at_idx",
        "store_items_created_at_key_idx",
      ]),
    );
    // Superseded by the composite whose leading column is the same; a redundant index costs writes.
    expect(indexes).not.toContain("runs_thread_id_idx");
  });

  it("leaves no invalid index behind", async () => {
    // A CREATE INDEX CONCURRENTLY that is interrupted leaves an *invalid* index that `IF NOT EXISTS`
    // then skips forever, so the query silently never uses it. Cheap to assert, and the failure mode
    // is otherwise invisible.
    const pool = await connectScratch("migrate_indexes_valid");
    await applySkeinMigrations(pool);

    const { rows } = await pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE NOT i.indisvalid`,
    );
    expect(rows.map((row) => row.relname)).toEqual([]);
  });

  it("uses an index for the thread search's default sort", async () => {
    // The point of the migration: `POST /threads/search` was a sequential scan plus a sort.
    const pool = await connectScratch("migrate_index_used");
    await applySkeinMigrations(pool);
    for (let index = 0; index < 2000; index += 1) {
      await pool.query(`INSERT INTO threads (thread_id) VALUES ($1)`, [`t-${index}`]);
    }
    await pool.query("ANALYZE threads");

    const { rows } = await pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT * FROM threads ORDER BY created_at DESC, thread_id DESC LIMIT 20`,
    );
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain("threads_created_at_thread_id_idx");
  });

  it("creates the ledger with the column types node-pg-migrate used", async () => {
    const pool = await connectScratch("migrate_ledger_shape");
    await applySkeinMigrations(pool);

    const columns = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'skein_migrations'
        ORDER BY ordinal_position`,
    );

    expect(columns.rows).toEqual([
      {
        column_name: "id",
        data_type: "integer",
        is_nullable: "NO",
        column_default: expect.stringContaining("nextval"),
      },
      {
        column_name: "name",
        data_type: "character varying",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "run_on",
        data_type: "timestamp without time zone",
        is_nullable: "NO",
        column_default: null,
      },
    ]);
  });

  it("is a no-op when re-run against an already-migrated database", async () => {
    const pool = await connectScratch("migrate_idempotent");
    await applySkeinMigrations(pool);
    const before = await readLedger(pool);

    expect(await applySkeinMigrations(pool)).toEqual([]);

    // run_on identical means nothing was re-inserted — and so nothing was re-run.
    expect(await readLedger(pool)).toEqual(before);
  });

  it("applies only what is missing from a 0.9.x ledger", async () => {
    const pool = await connectScratch("migrate_legacy_partial");
    // Rebuild exactly what a 0.9.x database that only ever saw 0001_init looks like.
    await pool.query(LEGACY_LEDGER_DDL);
    await pool.query(SKEIN_MIGRATIONS[0]!.up);
    await pool.query(
      `INSERT INTO "public"."skein_migrations" (name, run_on) VALUES ('0001_init', NOW())`,
    );
    const [legacyRow] = await readLedger(pool);

    expect(await applySkeinMigrations(pool)).toEqual([
      "0002_store_ttl",
      "0003_assistant_versions",
      "0004_run_error",
      "0005_performance_indexes",
    ]);

    const ledger = await readLedger(pool);
    expect(ledger.map((row) => row.name)).toEqual([
      "0001_init",
      "0002_store_ttl",
      "0003_assistant_versions",
      "0004_run_error",
      "0005_performance_indexes",
    ]);
    // The pre-existing row is untouched, so 0001_init was not re-applied.
    expect(ledger[0]).toEqual(legacyRow);
    expect(await tableExists(pool, "assistant_versions")).toBe(true);
  });

  it("rolls back a failing migration, names it, and stays retryable", async () => {
    const pool = await connectScratch("migrate_failure");
    const broken = [
      { name: "0001_init", up: "CREATE TABLE only_good (id text PRIMARY KEY)" },
      {
        name: "0002_broken",
        up: "CREATE TABLE bad (id text); SELECT this_function_does_not_exist()",
      },
    ];

    await expect(applySkeinMigrations(pool, { migrations: broken })).rejects.toThrow(
      /Migration "0002_broken" failed and was rolled back/,
    );

    // The failed migration left nothing behind — neither its table nor a ledger row.
    expect(await tableExists(pool, "bad")).toBe(false);
    expect((await readLedger(pool)).map((row) => row.name)).toEqual(["0001_init"]);

    // The lock was released and the connection is still usable, so a corrected build recovers
    // without operator intervention.
    const fixed = [broken[0]!, { name: "0002_broken", up: "CREATE TABLE now_fixed (id text)" }];
    expect(await applySkeinMigrations(pool, { migrations: fixed })).toEqual(["0002_broken"]);
    expect(await tableExists(pool, "now_fixed")).toBe(true);
  });

  it("gives up rather than hanging when another session holds the lock", async () => {
    const url = await createScratchDatabase("migrate_lock_timeout");
    const squatter = new Pool({ connectionString: url });
    const blocked = new Pool({ connectionString: url });
    openPools.push(squatter, blocked);

    // Stand in for an instance that died holding the lock, or a half-open connection.
    await squatter.query("SELECT pg_advisory_lock($1)", [7241865325823964]);

    await expect(applySkeinMigrations(blocked, { lockTimeoutMs: 750 })).rejects.toThrow(
      /Timed out after 750ms waiting for the skein migration lock/,
    );
  });

  it("serializes concurrent migrations instead of failing one of them", async () => {
    // node-pg-migrate used pg_try_advisory_lock and threw "Another migration is already running"
    // here, which could crash boot during a rolling deploy. The blocking lock makes the loser wait
    // and then find nothing to do.
    const url = await createScratchDatabase("migrate_concurrent");
    const first = new Pool({ connectionString: url });
    const second = new Pool({ connectionString: url });
    openPools.push(first, second);

    const [firstApplied, secondApplied] = await Promise.all([
      applySkeinMigrations(first),
      applySkeinMigrations(second),
    ]);

    expect([firstApplied.length, secondApplied.length].sort()).toEqual([0, 5]);
    expect((await readLedger(first)).map((row) => row.name)).toEqual([
      "0001_init",
      "0002_store_ttl",
      "0003_assistant_versions",
      "0004_run_error",
      "0005_performance_indexes",
    ]);
  });
});

describe("PostgresSkeinStore.migrate", () => {
  it("migrates on its own pool and leaves the store usable", async () => {
    const url = await createScratchDatabase("migrate_store_smoke");
    const store = await PostgresSkeinStore.connect(url);
    try {
      await store.migrate();
      await store.migrate(); // idempotent on the boot path too

      const thread = await store.threads.create({ metadata: { via: "migrate-smoke" } });
      expect(await store.threads.get(thread.thread_id)).toMatchObject({
        thread_id: thread.thread_id,
      });
    } finally {
      await store.close();
    }
  });
});
