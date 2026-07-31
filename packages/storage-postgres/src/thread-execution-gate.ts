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
// uses for migrations and pgvector setup (see `#setupPgvector`), including its two traps: exempt the
// lock wait from `statement_timeout`, and never return the client to the pool.
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
 */
export function createPostgresThreadExecutionGate(pool: Pool): ThreadExecutionGate {
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
          // Unlock explicitly so a waiting peer proceeds immediately rather than when the socket tears
          // down. Swallowed on failure: destroying the connection below ends the session, which frees
          // the lock anyway.
          await client
            .query("SELECT pg_advisory_unlock($1)", [key.toString()])
            .catch(() => undefined);
          // Never handed back to the pool. This session ran `SET statement_timeout = 0`, which is
          // session-scoped: a client returned carrying it would silently exempt whatever query reused
          // it. Destroying makes the pool open a fresh one, which runs the connect hook and gets the
          // configured timeout — and it guarantees the lock is gone even if the unlock failed.
          client.release(true);
        },
      };
    },
  };
}
