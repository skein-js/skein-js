import { startPostgres, type StartedResource } from "@skein-js/test-support";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { createPostgresPool, PostgresSkeinStore } from "./postgres-skein-store.js";

let postgres: StartedResource;
let store: PostgresSkeinStore;
let pool: Pool;
beforeAll(async () => {
  postgres = await startPostgres();
  store = await PostgresSkeinStore.connect(postgres.url);
  await store.migrate();
  pool = createPostgresPool(postgres.url);
}, 180000);
afterAll(async () => {
  await pool?.end();
  await store?.close();
  await postgres?.stop();
});
beforeEach(async () => {
  await store.truncateAll();
});

it("pages genuine timestamp ties with binary run ids and applies exact time bounds", async () => {
  const thread = await store.threads.create();
  for (const run_id of ["a", "\uE000", "😀"])
    await store.runs.create({
      thread_id: thread.thread_id,
      assistant_id: "agent",
      run_id,
      status: "error",
    });
  // Pin the stored timestamps, not just their millisecond wire projections: Postgres stores microseconds.
  const timestamp = "2026-11-01T00:00:00.000Z";
  await pool.query("UPDATE runs SET created_at=$1,updated_at=$1", [timestamp]);
  const first = await store.runs.search!({ limit: 2 });
  const second = await store.runs.search!({ limit: 2, offset: 2 });
  expect([...first, ...second].map((run) => run.run_id)).toEqual(["😀", "\uE000", "a"]);
  expect(
    await store.runs.search!({ createdAfter: timestamp, updatedAfter: timestamp }),
  ).toHaveLength(3);
  expect(await store.runs.search!({ createdBefore: timestamp })).toEqual([]);
  expect(await store.runs.search!({ updatedBefore: timestamp })).toEqual([]);
});

it("retains inflight indexes and provides indexed historical status/ownership search without execution payloads", async () => {
  const thread = await store.threads.create();
  await pool.query(
    `INSERT INTO runs(run_id,thread_id,assistant_id,status,metadata,kwargs,created_at)
    SELECT 'run-'||ordinal,$1,CASE WHEN ordinal%100=0 THEN 'agent' ELSE 'other' END,
      CASE WHEN ordinal%100=0 THEN 'error' ELSE 'success' END,
      jsonb_build_object('owner',CASE WHEN ordinal%100=0 THEN 'alice' ELSE 'bob' END),
      '{"input":"private"}'::jsonb,now()-(ordinal*interval '1 second') FROM generate_series(1,5000) ordinal`,
    [thread.thread_id],
  );
  await pool.query("ANALYZE runs");
  const indexes = await pool.query<{ indexname: string }>(
    "SELECT indexname FROM pg_indexes WHERE tablename='runs'",
  );
  expect(indexes.rows.map((row) => row.indexname)).toEqual(
    expect.arrayContaining([
      "runs_inflight_created_at_idx",
      "runs_search_created_at_idx",
      "runs_search_status_created_at_idx",
      "runs_search_assistant_idx",
      "runs_search_updated_at_idx",
      "runs_search_metadata_idx",
    ]),
  );
  const plan = await pool.query(
    `EXPLAIN SELECT run_id FROM runs WHERE status='error' ORDER BY created_at DESC,run_id COLLATE "C" DESC LIMIT 2`,
  );
  expect(JSON.stringify(plan.rows)).toContain("runs_search_status_created_at_idx");
  const assistantPlan = await pool.query(
    "EXPLAIN SELECT run_id FROM runs WHERE assistant_id='agent'",
  );
  expect(JSON.stringify(assistantPlan.rows)).toContain("runs_search_assistant_idx");
  const found = await store.runs.search!({
    status: "error",
    enforcedMetadata: { owner: "alice" },
    limit: 2,
    offset: 1,
  });
  expect(found).toHaveLength(2);
  expect(found.map((run) => run.run_id)).toEqual(["run-200", "run-300"]);
  for (const run of found) {
    expect(run).not.toHaveProperty("kwargs");
    expect(run).not.toHaveProperty("result");
  }
});
