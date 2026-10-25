import { randomUUID } from "node:crypto";

import { startPostgres, type StartedResource } from "@skein-js/test-support";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PostgresSkeinStore } from "./postgres-skein-store.js";

let postgres: StartedResource;
let store: PostgresSkeinStore;
let admin: Pool;
beforeAll(async () => {
  postgres = await startPostgres();
  store = await PostgresSkeinStore.connect(postgres.url);
  await store.migrate();
  admin = new Pool({ connectionString: postgres.url });
});
afterAll(async () => {
  await admin?.end();
  await store?.close();
  await postgres?.stop();
});
const key = () => ({
  scope: "signal",
  key: randomUUID(),
  fingerprint: "one",
  now: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});

it("rejects a lease lost while waiting for another connection's thread lock", async () => {
  const thread = await store.threads.create();
  const holder = await admin.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT thread_id FROM threads WHERE thread_id=$1 FOR UPDATE", [
    thread.thread_id,
  ]);
  const controller = new AbortController();
  const admission = key();
  const pending = store.admission.admitRun({
    ...admission,
    signal: controller.signal,
    run: { thread_id: thread.thread_id, assistant_id: "agent" },
    guard: { requireNoActiveRun: true },
  });
  const rejected = expect(pending).rejects.toThrow("lease lost");
  try {
    await expect
      .poll(
        async () =>
          Number(
            (
              await admin.query(
                "SELECT count(*) AS total FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT status FROM threads%'",
              )
            ).rows[0].total,
          ),
        { timeout: 5000, interval: 10 },
      )
      .toBeGreaterThan(0);
    controller.abort(new Error("lease lost"));
    await holder.query("COMMIT");
    await rejected;
    expect(await store.runs.listByThread(thread.thread_id)).toHaveLength(0);
    expect(await store.idempotency.get(admission.scope, admission.key)).toBeNull();
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
}, 10_000);
async function waitForSleep(query: string) {
  await expect
    .poll(
      async () =>
        Number(
          (
            await admin.query(
              "SELECT count(*) AS total FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event='PgSleep' AND query LIKE $1",
              [query],
            )
          ).rows[0].total,
        ),
      { timeout: 5000, interval: 10 },
    )
    .toBeGreaterThan(0);
}

it("rolls back run, receipt, reservation and dispatch if abort is observed before COMMIT", async () => {
  const thread = await store.threads.create();
  const interrupted = await store.runs.create({
    thread_id: thread.thread_id,
    assistant_id: "agent",
    status: "interrupted",
  });
  await admin.query(
    "CREATE FUNCTION test_native_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$; CREATE TRIGGER test_native_pause BEFORE INSERT ON idempotency_records FOR EACH ROW EXECUTE FUNCTION test_native_pause()",
  );
  try {
    const controller = new AbortController();
    const admission = key();
    const pending = store.admission.admitRun({
      ...admission,
      signal: controller.signal,
      run: { thread_id: thread.thread_id, assistant_id: "agent" },
      guard: { requireNoActiveRun: true },
      expectedRunId: interrupted.run_id,
    });
    // Observe the rejection immediately so the intentionally aborted operation is always handled.
    const rejected = expect(pending).rejects.toThrow("lease lost");
    await waitForSleep("INSERT INTO idempotency_records%");
    controller.abort(new Error("lease lost"));
    await rejected;
    expect(await store.idempotency.get(admission.scope, admission.key)).toBeNull();
    expect(await store.runs.listByThread(thread.thread_id)).toHaveLength(1);
    expect(
      Number(
        (
          await admin.query(
            "SELECT count(*) AS total FROM native_resume_reservations WHERE expected_run_id=$1",
            [interrupted.run_id],
          )
        ).rows[0].total,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await admin.query("SELECT count(*) AS total FROM native_dispatches WHERE thread_id=$1", [
            thread.thread_id,
          ])
        ).rows[0].total,
      ),
    ).toBe(0);
  } finally {
    await admin.query(
      "DROP TRIGGER test_native_pause ON idempotency_records; DROP FUNCTION test_native_pause()",
    );
  }
}, 10_000);

it("keeps the receipt authoritative when abort races an already-dispatched COMMIT", async () => {
  const thread = await store.threads.create();
  await admin.query(
    "CREATE FUNCTION test_native_commit_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER test_native_commit_pause AFTER INSERT ON runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_native_commit_pause()",
  );
  try {
    const controller = new AbortController();
    const admission = key();
    const pending = store.admission.admitRun({
      ...admission,
      signal: controller.signal,
      run: { thread_id: thread.thread_id, assistant_id: "agent" },
      guard: { requireNoActiveRun: true },
    });
    await waitForSleep("COMMIT");
    controller.abort(new Error("late lease loss"));
    const receipt = await pending;
    expect(await store.idempotency.get(admission.scope, admission.key)).toMatchObject({
      run_id: receipt.runId,
      status: "done",
    });
    expect(await store.runs.get(receipt.runId)).toMatchObject({ status: "pending" });
  } finally {
    await admin.query(
      "DROP TRIGGER test_native_commit_pause ON runs; DROP FUNCTION test_native_commit_pause()",
    );
  }
}, 10_000);
