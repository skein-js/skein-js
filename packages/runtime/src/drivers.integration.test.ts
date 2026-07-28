// The statement timeout is on by default, which puts a ceiling on every query the drivers make — and
// schema DDL is the one thing that must not be under it. `store.migrate()` and the pgvector setup lift
// it on their own clients, but `PostgresSaver.setup()` takes a client from whatever pool it is given, so
// `connectPostgresStore` has to hand it an exempt one. Getting that wrong is a boot *loop* on an
// existing database, not a slow boot, so it is asserted here against a real Postgres.

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
      disposers,
    });

    expect(store).toBeTruthy();
    expect(checkpointer).toBeTruthy();
  }, 120_000);
});
