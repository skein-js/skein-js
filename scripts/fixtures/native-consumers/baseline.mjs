// Deliberately uses only the preserved a2e1a8e public API, through package-root imports.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { embedSqliteGraphs } from "@skein-js/local";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { approvalGraph } from "./approval.mjs";

const local = await embedSqliteGraphs(
  { approval: approvalGraph() },
  { sqlitePath: resolve("baseline.sqlite") },
);
const runtime = createProtocolRuntime(local.deps, { scheduler: { enabled: false } });
try {
  await runtime.service.assistants.registerGraphAssistants();
  const thread = await runtime.service.threads.create();
  const now = new Date();
  const claim = await local.deps.store.idempotency.claim({
    scope: "baseline-worker",
    key: "command",
    fingerprint: "one",
    claim_id: "first",
    now: now.toISOString(),
    expires_at: new Date(now.getTime() + 1).toISOString(),
  });
  assert.equal(claim.claimed, true);
  const first = await runtime.service.runs.createBackground(thread.thread_id, {
    assistant_id: "approval",
    input: {},
  });
  // Exact gap: createBackground has committed the run/job; idempotency.record has not happened.
  // A crash here leaves an unlinked claim. Reopening or the queue's own retry cannot discover its run.
  assert.equal(
    (await local.deps.store.idempotency.get("baseline-worker", "command")).run_id,
    undefined,
  );
  runtime.worker.start();
  for (
    let index = 0;
    (await local.deps.store.runs.get(first.run_id)).status !== "interrupted";
    index++
  ) {
    assert.ok(index < 500);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const later = new Date(Date.now() + 1000);
  const retry = await local.deps.store.idempotency.claim({
    scope: "baseline-worker",
    key: "command",
    fingerprint: "one",
    claim_id: "retry",
    now: later.toISOString(),
    expires_at: new Date(later.getTime() + 60000).toISOString(),
  });
  assert.equal(retry.claimed, true);
  const duplicate = await runtime.service.runs.createBackground(thread.thread_id, {
    assistant_id: "approval",
    input: {},
  });
  assert.notEqual(duplicate.run_id, first.run_id);
  assert.equal((await local.deps.store.runs.listByThread(thread.thread_id)).length, 2);
  console.log(
    "PACKED_EXISTING_API_GAP_OK: createBackground -> idempotency.record are separate commits; retries create a second run",
  );
} finally {
  await runtime.worker.stop();
  await local.dispose();
}
