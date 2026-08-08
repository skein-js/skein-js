// The statement timeout is on by default, which puts a ceiling on every query the drivers make — and
// schema DDL is the one thing that must not be under it. `store.migrate()` and the pgvector setup lift
// it on their own clients, but `PostgresSaver.setup()` takes a client from whatever pool it is given, so
// `connectPostgresStore` has to hand it an exempt one. Getting that wrong is a boot *loop* on an
// existing database, not a slow boot, so it is asserted here against a real Postgres.

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  CHECKPOINTER_MIGRATIONS_LOCK,
  createPostgresPool,
  withSessionAdvisoryLock,
} from "@skein-js/storage-postgres";
import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectPostgresStore, type Disposer } from "./drivers.js";

let pg: StartedResource;
const disposers: Disposer[] = [];

beforeAll(async () => {
  pg = await startPostgres();
}, 120_000);

afterAll(async () => {
  for (const dispose of disposers.reverse()) await dispose();
  await pg?.stop();
});

describe("connectPostgresStore — statement timeout", () => {
  it("boots under a timeout far too short for any DDL", async () => {
    // 1ms cancels essentially any statement, so every set of schema migrations on this path has to be
    // exempt for this to return at all: ours, the pgvector setup, and `PostgresSaver.setup()` — the last
    // of which takes its client from whatever pool it is given, and so needs its own untimed one.
    // Getting it wrong is a boot *loop* on an existing database, not a slow boot.
    //
    // The assertion is only that boot *returns*. Nothing here queries through the store: at 1ms, whether
    // an ordinary statement survives depends on how loaded the machine is, so an assertion either way is
    // a race. That the pool applies the timeout at all is proven where a genuinely slow statement is
    // available — `migrate.integration.test.ts`, with `pg_sleep`.
    const { store, checkpointer } = await connectPostgresStore({
      url: pg.url,
      connectionOptions: { statementTimeoutMs: 1 },
      maxPageSize: 1000,
      runConcurrency: 10,
      disposers,
    });

    expect(store).toBeTruthy();
    expect(checkpointer).toBeTruthy();
  }, 120_000);
});

describe("connectPostgresStore — concurrent boot", () => {
  // Its **own** container, deliberately. `PostgresSaver.setup()` only inserts when migrations are
  // pending, so on the already-migrated database above every instance would find nothing to do and
  // this would pass without exercising anything. A fresh database is the window the race lives in —
  // and the window a first deploy, or an upgrade that bumps the checkpointer's schema, lands in.
  let fresh: StartedResource;

  beforeAll(async () => {
    fresh = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await fresh?.stop();
  });

  // The pointed one, and it must run first: it is the case that needs migrations still pending.
  //
  // Measured against this exact container, 12 unguarded concurrent `setup()` calls produced **11
  // failures**, in three distinct shapes — `duplicate key ... "checkpoint_migrations_pkey"` (what CI
  // caught), `duplicate key ... "pg_type_typname_nsp_index"` from a concurrent `CREATE TYPE`, and
  // `type "checkpoint_migrations" already exists`. So upstream's setup is not merely racy on the
  // version insert; the DDL itself is unsafe to run concurrently. Wrapped, all twelve succeed.
  //
  // This is the regression test. The end-to-end boot below is only a smoke test, because
  // `store.migrate()` runs first on that path and *is* locked — which staggers the instances enough
  // to hide this most of the time, and is precisely why it reproduced in CI only intermittently.
  it("serializes the checkpointer's schema setup across instances", async () => {
    const pools = Array.from({ length: 12 }, () =>
      createPostgresPool(fresh.url, { poolMax: 2, statementTimeoutMs: 0 }),
    );
    try {
      const results = await Promise.allSettled(
        pools.map((pool) =>
          withSessionAdvisoryLock(
            pool,
            { key: CHECKPOINTER_MIGRATIONS_LOCK, lockName: "checkpointer migration" },
            () => new PostgresSaver(pool).setup(),
          ),
        ),
      );

      // Compared as messages rather than a count so a regression names its own cause.
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason?.message));
      expect(failures).toEqual([]);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 180_000);

  it("admits several instances booting at once", async () => {
    // Smoke: the whole boot path under concurrency, which also catches the deadlock the lock could
    // introduce — it holds one connection from `setupPool` while `setup()` needs a second.
    const boots = await Promise.all(
      Array.from({ length: 5 }, () =>
        connectPostgresStore({
          url: fresh.url,
          connectionOptions: {},
          maxPageSize: 1000,
          runConcurrency: 10,
          disposers,
        }),
      ),
    );

    expect(boots).toHaveLength(5);
    for (const boot of boots) {
      expect(boot.store).toBeTruthy();
      expect(boot.checkpointer).toBeTruthy();
    }
  }, 180_000);
});
