// Guards the explicit `SELECT`/`RETURNING` projections against the live schema.
//
// The projections exist so a read does not haul columns the row mappers never touch — `runs.kwargs`
// (a run's whole input payload) and `crons.auth` (a caller's stored credentials), both of which were
// previously fetched on every list. The failure mode of getting one wrong is invisible: `rowToRun` and
// friends cast with `as Run`, so a missing column reads back as `undefined` rather than as a type error,
// and no ordinary test notices because the field is one nobody asserts on.
//
// So this asserts the *complement*: every column the table has, minus the projection, must equal the
// set we deliberately left out. Adding a column to a migration and forgetting the projection fails here
// — which is the actual way this breaks.

import { startPostgres, type StartedResource } from "@skein-js/test-support";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresPool,
  CRON_COLUMNS,
  PostgresSkeinStore,
  RUN_COLUMNS,
  THREAD_COLUMNS,
} from "./postgres-skein-store.js";

let pg: StartedResource;
let store: PostgresSkeinStore;
// The store keeps its pool private, so the catalog is read over a pool of this test's own.
let pool: Pool;

beforeAll(async () => {
  pg = await startPostgres();
  store = await PostgresSkeinStore.connect(pg.url);
  await store.migrate();
  pool = createPostgresPool(pg.url);
}, 180_000);
afterAll(async () => {
  await pool?.end();
  await store?.close();
  await pg?.stop();
});

/** Column names actually on the table, from the catalog. */
async function tableColumns(table: string): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

/** The projection's column list, unquoted and trimmed — `"values"` is quoted in the SQL. */
function projected(columns: string): string[] {
  return columns.split(",").map((name) => name.trim().replace(/^"|"$/g, ""));
}

describe("query projections match the schema", () => {
  it.each([
    // [table, projection, the columns deliberately omitted and why]
    ["runs", RUN_COLUMNS, ["kwargs"]],
    ["crons", CRON_COLUMNS, ["auth"]],
    ["threads", THREAD_COLUMNS, ["ttl_minutes", "expires_at"]],
  ])(
    "projects every %s column except the documented omissions",
    async (table, columns, omitted) => {
      const actual = await tableColumns(table);
      const projection = projected(columns);

      // Nothing projected that the table lacks — catches a typo, which would otherwise be a runtime
      // `column "..." does not exist` on the first query rather than a failure here.
      expect(projection.filter((name) => !actual.includes(name))).toEqual([]);
      // And nothing on the table that is neither projected nor deliberately omitted.
      expect(actual.filter((name) => !projection.includes(name)).sort()).toEqual(
        [...omitted].sort(),
      );
    },
  );

  // The two omissions have dedicated readers, which is *why* they can be left out of the wide reads.
  // If either of these regressed, the fix would look like "add the column back to the projection" —
  // the wrong fix, since it would restore the cost on every list.
  it("still reads the omitted columns through their own accessors", async () => {
    const thread = await store.threads.create({});
    const run = await store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "a",
      kwargs: { input: { value: "hi" } },
    });

    expect(await store.runs.getKwargs(run.run_id)).toEqual({ input: { value: "hi" } });
  });
});
