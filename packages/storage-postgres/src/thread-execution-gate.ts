// Cross-instance per-thread execution serialization, on a Postgres **session** advisory lock.
//
// Why Postgres and not a Redis lease: a run holds its claim for its entire execution, which can be
// minutes of LLM calls. A TTL-based lease has to be renewed for that whole time, and if a renewal is
// ever late — a blocked event loop, a GC pause, a network blip — the lease expires while the run is
// still writing and a second instance starts on the same thread. That is precisely the checkpoint
// corruption the claim exists to prevent. A session lock has no TTL: Postgres holds it until the session
// releases it *or the connection dies*, so a crashed instance frees its threads immediately and a slow
// one keeps them.
//
// This mirrors how LangGraph Platform splits the job — Postgres owns run rows and dispatch exclusivity,
// Redis carries ephemeral pub/sub — and it follows the same session-lock pattern this package already
// uses for migrations and pgvector setup (see `#setupPgvector`), including its trap: the blocking lock
// wait has to be exempt from `statement_timeout`, or a run queued behind a legitimately long peer is
// cancelled with `57014` instead of waiting its turn. Unlike those one-shot boot paths this runs per run,
// so it *undoes* the exemption and hands the connection back rather than discarding it — see `release`.
//
// The cost, which is the trade LangGraph Platform also makes: one pooled connection per
// concurrently-executing run. Budget `PG_POOL_MAX` accordingly — see docs/deploy.md.

import { createHash } from "node:crypto";

import type { ThreadExecutionGate, ThreadExecutionLease } from "@skein-js/core";
import type { Pool } from "pg";

/**
 * Map a thread id onto the `bigint` key `pg_advisory_lock` takes.
 *
 * A hash, because the key space is 64 bits and thread ids are arbitrary strings. Collisions are
 * therefore possible and **safe in the only direction that matters**: two threads sharing a key
 * over-serialize (one waits for the other unnecessarily), which costs latency. It can never
 * under-serialize, so the invariant holds regardless.
 *
 * SHA-256 rather than a cheap string hash so ids that differ only in a suffix — which sequential or
 * prefixed thread ids often do — do not cluster onto one key and serialize a whole deployment.
 * Read as a *signed* 64-bit integer, since that is what the Postgres parameter is.
 */
export function threadLockKey(threadId: string): bigint {
  const digest = createHash("sha256").update(threadId).digest();
  return digest.readBigInt64BE(0);
}

/**
 * Serialize run execution per thread across every instance sharing this Postgres.
 *
 * Pass the result as `ProtocolDeps.threadExecutionGate`. Give it its **own** pool, sized for the run
 * concurrency: every executing run holds one connection from it for the run's duration, so sharing the
 * store's pool would let a burst of runs starve ordinary queries.
 *
 * `logger` reports a claim that could not be released cleanly — the one failure here with a lasting
 * consequence, since a leaked lock stalls the thread until its connection tears down.
 */
export function createPostgresThreadExecutionGate(
  pool: Pool,
  logger?: { warn(message: string, meta?: unknown): void },
): ThreadExecutionGate {
  return {
    async acquire(threadId: string): Promise<ThreadExecutionLease> {
      const key = threadLockKey(threadId);
      const client = await pool.connect();
      try {
        // Exempt from any configured `statement_timeout`. This statement *blocks* until the lock is
        // free, which is the point — under a 30s timeout an `enqueue` run waiting behind a legitimately
        // long peer would be cancelled with `57014` rather than waiting its turn.
        await client.query("SET statement_timeout = 0");
        await client.query("SELECT pg_advisory_lock($1)", [key.toString()]);
      } catch (error) {
        // Destroyed, not released: this client may carry `statement_timeout = 0`, and it may or may not
        // hold the lock. Ending the session is the only way to be sure of both.
        client.release(true);
        throw error;
      }

      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try {
            // Unlock explicitly so a waiting peer proceeds immediately rather than when the socket tears
            // down, then undo the session-scoped `statement_timeout` this connection set. Both have to
            // succeed for the client to be safe to reuse: a client returned still carrying
            // `statement_timeout = 0` would silently exempt whatever query picked it up next.
            await client.query("SELECT pg_advisory_unlock($1)", [key.toString()]);
            await client.query("RESET statement_timeout");
            // Returned to the pool, not destroyed. Destroying meant a brand-new backend connection —
            // TCP, TLS, auth — for *every* run, purely for lock bookkeeping: at 100 runs/minute that is
            // 100 connections/minute of churn a managed Postgres or PgBouncer notices, on the run-start
            // path.
            client.release();
          } catch (error) {
            // Either statement failed, so the session's state is unknown: it may still hold the lock, or
            // still be exempt from the timeout. Destroy it — ending the session frees the lock and
            // discards the setting — and say so, because a lock leaked to the socket's teardown stalls
            // every later run on this thread until then.
            client.release(true);
            logger?.warn(
              `thread execution claim for "${threadId}" could not be released cleanly; its connection ` +
                `was discarded to free the lock`,
              error,
            );
          }
        },
      };
    },
  };
}
