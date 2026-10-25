import { randomUUID } from "node:crypto";

import {
  SkeinHttpError,
  isTerminalRunStatus,
  serializeWireJson,
  type AdmissionKey,
  type AdmissionReceipt,
  type AdmissionRepo,
  type Delivery,
  type DeliveryCreate,
  type DispatchClaim,
  type Run,
  type RunCreate,
  type RunSettlement,
  type SettledRun,
} from "@skein-js/core";
import type { PoolClient } from "pg";

interface NativePostgresDeps {
  pageLimit(limit?: number): number;
  transaction<T>(operation: (client: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T>;
  insertRun(client: PoolClient, input: RunCreate): Promise<Run>;
  settle(client: PoolClient, runId: string, final: RunSettlement): Promise<SettledRun>;
}

async function replay(
  client: PoolClient,
  input: AdmissionKey,
): Promise<AdmissionReceipt | undefined> {
  // Key ownership precedes thread locks, including when two commands select different threads.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    JSON.stringify(["skein-native", input.scope, input.key]),
  ]);
  const { rows } = await client.query<{
    fingerprint: string;
    run_id: string | null;
    thread_id: string | null;
    expires_at: Date;
  }>(
    "SELECT fingerprint,run_id,thread_id,expires_at FROM idempotency_records WHERE scope=$1 AND key=$2",
    [input.scope, input.key],
  );
  const row = rows[0];
  if (!row || row.expires_at.getTime() <= Date.parse(input.now)) return;
  if (row.fingerprint !== input.fingerprint)
    throw SkeinHttpError.conflict("The operation key was already used for different input.", {
      code: "idempotency_key_reused",
    });
  if (!row.run_id || !row.thread_id)
    throw SkeinHttpError.conflict("Admission is in progress.", {
      code: "idempotency_key_in_flight",
    });
  return { idempotencyKey: input.key, runId: row.run_id, threadId: row.thread_id };
}

async function record(
  client: PoolClient,
  input: AdmissionKey,
  run: Run,
): Promise<AdmissionReceipt> {
  const receipt = { idempotencyKey: input.key, runId: run.run_id, threadId: run.thread_id };
  await client.query(
    `INSERT INTO idempotency_records(scope,key,fingerprint,claim_id,status,response,run_id,thread_id,expires_at)
VALUES($1,$2,$3,$4,'done',$5::jsonb,$6,$7,$8::timestamptz)
ON CONFLICT(scope,key) DO UPDATE SET fingerprint=excluded.fingerprint,claim_id=excluded.claim_id,status='done',
response=excluded.response,run_id=excluded.run_id,thread_id=excluded.thread_id,expires_at=excluded.expires_at,updated_at=now()`,
    [
      input.scope,
      input.key,
      input.fingerprint,
      randomUUID(),
      JSON.stringify({ status: 202, body: receipt }),
      run.run_id,
      run.thread_id,
      input.expiresAt,
    ],
  );
  return receipt;
}

async function dispatch(
  client: PoolClient,
  run: Run,
  kind: "run" | "cancel",
  action?: "interrupt" | "rollback",
): Promise<void> {
  await client.query(
    `INSERT INTO native_dispatches(run_id,thread_id,kind,action,not_before)
SELECT run_id,thread_id,$2,$3,CASE WHEN $2='run' THEN COALESCE((kwargs->>'queue_not_before')::timestamptz,now()) ELSE now() END FROM runs WHERE run_id=$1
ON CONFLICT(run_id) DO UPDATE SET kind=excluded.kind,action=excluded.action,not_before=excluded.not_before,token=NULL,lease_until=NULL,dispatched=false`,
    [run.run_id, kind, action ?? null],
  );
}

export function createPostgresAdmission(deps: NativePostgresDeps): AdmissionRepo {
  return {
    admitRun: (input) =>
      deps.transaction(async (client) => {
        input.signal?.throwIfAborted();
        const previous = await replay(client, input);
        if (previous) return previous;
        const prepared = JSON.parse(serializeWireJson(input.run)) as RunCreate;
        const { rows: threads } = await client.query<{ status: string }>(
          "SELECT status FROM threads WHERE thread_id=$1 FOR UPDATE",
          [prepared.thread_id],
        );
        const thread = threads[0];
        if (!thread) throw SkeinHttpError.notFound("Thread not found.");
        if (
          input.guard.threadStatusIn &&
          !input.guard.threadStatusIn.some((status) => status === thread.status)
        )
          throw SkeinHttpError.conflict("Thread status changed.", {
            code: "thread_status_mismatch",
          });
        const { rows: active } = await client.query<{ run_id: string }>(
          "SELECT run_id FROM runs WHERE thread_id=$1 AND status IN ('pending','running') FOR UPDATE",
          [prepared.thread_id],
        );
        const displaced = input.displacements ?? [];
        if (
          (input.guard.requireNoActiveRun && active.length) ||
          (displaced.length &&
            (active.length !== displaced.length ||
              active.some((run) => !displaced.some((item) => item.runId === run.run_id))))
        )
          throw SkeinHttpError.conflict("Active runs changed.", { code: "thread_busy" });
        if (input.expectedRunId) {
          const { rows } = await client.query<{
            status: string;
            thread_id: string;
            reserved: boolean;
          }>(
            `SELECT status,thread_id,
EXISTS(SELECT 1 FROM native_resume_reservations WHERE expected_run_id=$1) AS reserved FROM runs WHERE run_id=$1`,
            [input.expectedRunId],
          );
          if (
            rows[0]?.thread_id !== prepared.thread_id ||
            rows[0].status !== "interrupted" ||
            rows[0].reserved
          )
            throw SkeinHttpError.conflict("Resume target was consumed or changed.", {
              code: "stale_resume",
            });
        }
        for (const item of displaced) {
          input.signal?.throwIfAborted();
          const settled = await deps.settle(client, item.runId, item.settlement);
          input.signal?.throwIfAborted();
          if (settled.run)
            await dispatch(
              client,
              settled.run,
              "cancel",
              prepared.multitask_strategy === "rollback" ? "rollback" : "interrupt",
            );
        }
        input.signal?.throwIfAborted();
        const run = await deps.insertRun(client, prepared);
        input.signal?.throwIfAborted();
        if (input.expectedRunId)
          await client.query(
            "INSERT INTO native_resume_reservations(expected_run_id,run_id) VALUES($1,$2)",
            [input.expectedRunId, run.run_id],
          );
        input.signal?.throwIfAborted();
        await dispatch(client, run, "run");
        input.signal?.throwIfAborted();
        return record(client, input, run);
      }, input.signal),
    admitCancel: (input) =>
      deps.transaction(async (client) => {
        const previous = await replay(client, input);
        if (previous) return previous;
        const { rows } = await client.query<Run>(
          `SELECT run_id,thread_id,assistant_id,status,metadata,multitask_strategy,
created_at::text,updated_at::text FROM runs WHERE run_id=$1`,
          [input.runId],
        );
        const run = rows[0];
        if (!run) throw SkeinHttpError.notFound("Run not found.");
        await client.query("SELECT thread_id FROM threads WHERE thread_id=$1 FOR UPDATE", [
          run.thread_id,
        ]);
        if (!isTerminalRunStatus(run.status)) {
          const settled = await deps.settle(client, run.run_id, {
            status: "cancelled",
            ...(input.delivery ? { delivery: input.delivery } : {}),
          });
          if (settled.run?.status === "cancelled")
            await dispatch(client, settled.run, "cancel", input.action);
        }
        return record(client, input, run);
      }),
    claimDispatches: (query) =>
      deps.transaction(async (client) => {
        type DispatchRow = {
          run_id: string;
          thread_id: string;
          kind: DispatchClaim["kind"];
          action: DispatchClaim["action"] | null;
          not_before: Date;
        };
        const limit = Math.max(1, Math.min(deps.pageLimit(query.limit ?? 100), 1000));
        const { rows } = await client.query<DispatchRow>(
          `SELECT run_id,thread_id,kind,action,not_before FROM native_dispatches
WHERE kind='cancel' AND NOT dispatched AND (lease_until IS NULL OR lease_until<=$1::timestamptz)
ORDER BY lease_until NULLS FIRST,run_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
          [query.now, limit],
        );
        if (rows.length < limit) {
          // Ownership survives ACKs and terminal status until run deletion. Active rows use the
          // inflight runs index rather than scanning all historical admission receipts.
          const active = await client.query<DispatchRow>(
            `SELECT d.run_id,d.thread_id,d.kind,d.action,d.not_before FROM runs r
JOIN native_dispatches d ON d.run_id=r.run_id
WHERE r.status IN ('pending','running') AND d.kind='run'
AND (d.lease_until IS NULL OR d.lease_until<=$1::timestamptz)
ORDER BY r.created_at,r.run_id LIMIT $2 FOR UPDATE OF d SKIP LOCKED`,
            [query.now, limit - rows.length],
          );
          rows.push(...active.rows);
        }
        const claims: DispatchClaim[] = [];
        for (const row of rows) {
          const token = randomUUID();
          await client.query(
            "UPDATE native_dispatches SET token=$2,lease_until=$3::timestamptz WHERE run_id=$1",
            [row.run_id, token, query.leaseUntil],
          );
          claims.push({
            runId: row.run_id,
            threadId: row.thread_id,
            kind: row.kind,
            token,
            notBefore: row.not_before.toISOString(),
            ...(row.action ? { action: row.action } : {}),
          });
        }
        return claims;
      }),
    markDispatched: (runId, token) =>
      deps.transaction(async (client) => {
        await client.query(
          "UPDATE native_dispatches SET dispatched=true WHERE run_id=$1 AND token::text=$2",
          [runId, token],
        );
      }),
  };
}

/** One result/status/outbox transaction, using the driver's existing row encoders. */
export async function settlePostgresRun(
  client: PoolClient,
  runId: string,
  final: RunSettlement,
  codecs: {
    readRun(client: PoolClient, runId: string): Promise<Run | null>;
    readDelivery(client: PoolClient, id: string): Promise<Delivery | null>;
    insertDelivery(
      client: PoolClient,
      runId: string,
      status: Run["status"],
      delivery: DeliveryCreate,
    ): Promise<Delivery>;
  },
): Promise<SettledRun> {
  const result = final.result === undefined ? undefined : serializeWireJson(final.result);
  if (final.delivery) serializeWireJson(final.delivery);
  await client.query("SELECT run_id FROM runs WHERE run_id=$1 FOR UPDATE", [runId]);
  await client.query(
    "UPDATE runs SET status=$2,error=$3::jsonb,updated_at=now() WHERE run_id=$1 AND status IN ('pending','running')",
    [runId, final.status, JSON.stringify(final.error ?? null)],
  );
  const run = await codecs.readRun(client, runId);
  if (run?.status === final.status && result !== undefined)
    await client.query("UPDATE runs SET result=$2::jsonb WHERE run_id=$1 AND result IS NULL", [
      runId,
      result,
    ]);
  const delivery = final.delivery
    ? ((final.delivery.delivery_id
        ? await codecs.readDelivery(client, final.delivery.delivery_id)
        : null) ??
      (await codecs.insertDelivery(client, runId, run?.status ?? final.status, final.delivery)))
    : undefined;
  return { run, ...(delivery ? { delivery } : {}) };
}
