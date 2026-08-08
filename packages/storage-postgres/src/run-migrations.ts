// The schema migration runner. Deliberately in-package rather than node-pg-migrate: that library
// can only load migrations from a directory (`RunnerOption.dir` is required and always `readdir`s),
// which is exactly the filesystem dependency that stopped this package from being bundled. The SQL
// now ships compiled in (migrations.generated.ts) and this applies it. See docs/bundling.md.
//
// Everything here is bug-for-bug compatible with the node-pg-migrate setup skein used through 0.9.x
// — same ledger table and DDL, same migration names, same one-transaction-per-migration, same
// advisory lock id — so an existing database upgrades in place, and a rolling deploy where 0.9.x and
// 0.10.x instances overlap still mutually excludes. The one intentional behaviour change is the lock
// itself: see SKEIN_MIGRATIONS_LOCK.

import type { Pool, PoolClient } from "pg";

import { SKEIN_MIGRATIONS, type SkeinMigration } from "./migrations.generated.js";

/**
 * The ledger, schema-qualified exactly as node-pg-migrate qualified it. skein never passed a
 * `schema` option, so its table landed in `public` regardless of the connection's search_path —
 * qualifying keeps us pointed at the same table on databases that set one.
 */
const MIGRATIONS_TABLE = `"public"."skein_migrations"`;

/**
 * node-pg-migrate's `PG_MIGRATE_LOCK_ID`, kept byte-identical so a 0.9.x instance and a 0.10.x
 * instance booting at once still exclude each other.
 *
 * node-pg-migrate took this with `pg_try_advisory_lock` and threw "Another migration is already
 * running" the moment it lost the race, which could crash boot during a rolling deploy — the
 * opposite of what docs/deploy.md promises. We wait for it instead, so the loser wakes up, re-reads
 * a full ledger and applies nothing.
 */
const SKEIN_MIGRATIONS_LOCK = 7241865325823964;

/**
 * How long to wait for another instance's migration before giving up.
 *
 * We poll `pg_try_advisory_lock` rather than blocking on `pg_advisory_lock` precisely so this bound
 * exists: `migrate()` runs before the server listens, so an unbounded wait would hang every pod
 * pre-readiness with no diagnostic if the lock were ever orphaned — by a session whose
 * `pg_advisory_unlock` never ran, or a half-open TCP connection Postgres won't reap for hours.
 * Bounded-and-loud beats indefinitely-silent.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

const LOCK_POLL_INTERVAL_MS = 250;

/**
 * The lock guarding the **checkpointer's** schema — `PostgresSaver.setup()` in
 * `@langchain/langgraph-checkpoint-postgres`, which reads `checkpoint_migrations` and then inserts
 * the pending versions with no exclusion of its own. Two instances booting at once against a
 * database with pending migrations both read the same version and both insert, and the loser dies
 * with `duplicate key value violates unique constraint "checkpoint_migrations_pkey"` — during a
 * first deploy or an upgrade that bumps that package's schema, which is exactly when a rolling
 * deploy is starting several replicas at once.
 *
 * A *different* key from {@link SKEIN_MIGRATIONS_LOCK}: the two schemas are independent, so
 * serializing them against each other would make every boot wait on a migration it does not depend
 * on for no exclusion benefit. Adjacent value, deliberately, so the two stay visibly related and
 * nobody reuses one.
 */
export const CHECKPOINTER_MIGRATIONS_LOCK = 7241865325823965;

interface SessionAdvisoryLockOptions {
  key: number;
  timeoutMs: number;
  timeoutMessage: string;
}

/** Options for {@link applySkeinMigrations}. */
export interface ApplySkeinMigrationsOptions {
  /** Defaults to the compiled-in {@link SKEIN_MIGRATIONS}. Injectable for tests. */
  migrations?: readonly SkeinMigration[];
  /** How long to wait for a concurrent migration. Defaults to 60s. */
  lockTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take a session advisory lock without leaving a statement blocked in Postgres.
 *
 * A blocked `pg_advisory_lock` statement owns a snapshot. That can deadlock with
 * `CREATE INDEX CONCURRENTLY`: the index build waits for the old snapshot while the blocked statement
 * waits for the session running the build to release this lock. Short `pg_try_advisory_lock` probes
 * end their snapshots between attempts, so the index build can finish and release the lock.
 */
export async function acquireSessionAdvisoryLock(
  client: PoolClient,
  options: SessionAdvisoryLockOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const held = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [options.key],
    );
    if (held.rows[0]?.locked === true) return;
    if (Date.now() >= deadline) {
      throw new Error(options.timeoutMessage);
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

/** Options for {@link withSessionAdvisoryLock}. */
export interface WithSessionAdvisoryLockOptions {
  /** The `pg_advisory_lock` key to hold. */
  key: number;
  /** Names the lock in the timeout error, e.g. `"checkpointer migration"`. */
  lockName: string;
  /** How long to wait for a peer holding it. Defaults to 60s. */
  timeoutMs?: number;
}

/**
 * Run `work` while holding a session advisory lock, so only one instance runs it at a time.
 *
 * For guarding a migration skein does not own — {@link applySkeinMigrations} inlines the same
 * discipline because it also needs the locked client to apply the SQL, whereas `work` here does its
 * own thing and only needs the exclusion.
 *
 * The lock lives on its own connection for the whole call, because a session advisory lock is
 * scoped to a session rather than a transaction. `work` may use the same pool — but the pool must
 * therefore be able to hand out a *second* connection, or it deadlocks against itself. Callers size
 * it accordingly.
 */
export async function withSessionAdvisoryLock<T>(
  pool: Pool,
  options: WithSessionAdvisoryLockOptions,
  work: () => Promise<T>,
): Promise<T> {
  const { key, lockName, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = options;
  const client = await pool.connect();
  try {
    // Exempt from any configured `statement_timeout`, for the reason migrations are: a cancelled
    // lock wait would kill an instance that is merely waiting for a peer during a rolling deploy.
    await client.query("SET statement_timeout = 0");
    await acquireSessionAdvisoryLock(client, {
      key,
      timeoutMs,
      timeoutMessage:
        `Timed out after ${timeoutMs}ms waiting for the ${lockName} lock ` +
        `(pg_advisory_lock key ${key}). Another instance is either still holding it, or a previous ` +
        `one died with it — check for idle sessions with ` +
        `\`SELECT * FROM pg_locks WHERE locktype = 'advisory'\`.`,
    });
    try {
      return await work();
    } finally {
      // Best-effort, and not what actually guarantees release: the client is destroyed below either
      // way, and ending the session is what frees a session-scoped lock. Unlocking first just stops
      // peers polling immediately rather than when the socket closes.
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [key]);
      } catch {
        // The destroy below covers it.
      }
    }
  } finally {
    // Always destroyed, never returned: this connection may hold the lock and definitely carries the
    // `SET statement_timeout = 0` above, which would silently exempt whatever query reused it.
    client.release(true);
  }
}

/** Creates the ledger if absent, with the column types node-pg-migrate created it with. */
const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  id SERIAL PRIMARY KEY,
  name varchar(255) NOT NULL,
  run_on timestamp NOT NULL
)`;

/**
 * The migrations not yet in `appliedNames`, in declared order.
 *
 * Throws if the ledger disagrees with the declared order — with the SQL now living in an array
 * literal rather than a sorted directory listing, an accidental reorder is a one-line mistake, and
 * applying migrations out of order against a live database is unrecoverable. Ledger entries beyond
 * what this build knows about are tolerated: that is a downgrade, not corruption.
 */
export function selectPendingMigrations(
  migrations: readonly SkeinMigration[],
  appliedNames: readonly string[],
): SkeinMigration[] {
  const comparableCount = Math.min(appliedNames.length, migrations.length);
  for (let index = 0; index < comparableCount; index += 1) {
    const appliedName = appliedNames[index];
    const declaredName = migrations[index]?.name;
    if (appliedName !== declaredName) {
      throw new Error(
        `Migration order mismatch: the database has "${appliedName}" at position ${index + 1} but ` +
          `this build declares "${declaredName}". Migrations must never be reordered or renamed ` +
          `once released.`,
      );
    }
  }
  const applied = new Set(appliedNames);
  return migrations.filter((migration) => !applied.has(migration.name));
}

/**
 * Apply a migration whose statements must run outside a transaction, one at a time.
 *
 * `CREATE INDEX CONCURRENTLY` is rejected inside a transaction block, and `pg`'s simple query protocol
 * wraps a multi-statement string in an implicit one — so this cannot go through the BEGIN/COMMIT path
 * above. The trade-off is that the migration is not atomic: a failure partway leaves some statements
 * applied and the ledger row unwritten, so the next boot re-runs the whole thing. Every statement is
 * therefore written `IF NOT EXISTS` / `IF EXISTS`.
 *
 * The advisory lock still serializes instances, so a rolling deploy does not build the same index
 * twice concurrently.
 */
async function applyConcurrentMigration(
  client: PoolClient,
  migration: SkeinMigration,
): Promise<void> {
  for (const statement of migration.statements ?? []) {
    try {
      await client.query(statement);
    } catch (error) {
      throw new Error(
        `Migration "${migration.name}" failed on a concurrent statement and was NOT rolled back ` +
          `(concurrent index builds cannot be transactional). Statements already applied remain; ` +
          `the ledger row was not written, so the next boot retries the whole migration. If a ` +
          `CREATE INDEX CONCURRENTLY was interrupted, Postgres may have left an *invalid* index that ` +
          `\`IF NOT EXISTS\` will skip — see docs/storage.md for how to find and drop one. ` +
          `Statement: ${statement.slice(0, 120)}. Cause: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  // Recorded only once every statement landed, which is what makes the retry above safe.
  await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, run_on) VALUES ($1, NOW())`, [
    migration.name,
  ]);
}

/**
 * Apply every pending migration and record it, serialized across instances by an advisory lock.
 * Idempotent — a fully-migrated database applies nothing. Returns the names applied, oldest first.
 *
 * Takes the pool rather than a client because the advisory lock is session-scoped: it has to live on
 * one connection for the whole run, so this owns connect → lock → apply → unlock → release.
 */
export async function applySkeinMigrations(
  pool: Pool,
  options: ApplySkeinMigrationsOptions = {},
): Promise<string[]> {
  const { migrations = SKEIN_MIGRATIONS, lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS } = options;
  const client = await pool.connect();
  // Set when the connection must not go back to the pool: a client that may still hold the session lock
  // would wedge every later boot, and one carrying the `SET statement_timeout = 0` below would silently
  // exempt whatever query reused it. Destroying it makes the pool open a fresh connection, which runs
  // the connect hook and gets the configured timeout.
  let discardClient = false;
  try {
    // Migrations are exempt from any configured `statement_timeout`. Schema DDL is legitimately slow —
    // `CREATE INDEX CONCURRENTLY` on a large table takes minutes — and a cancelled index build leaves
    // an *invalid* index that the retry's `IF NOT EXISTS` matches by name and skips, so the migration
    // records as applied while the index is permanently unused. A cancelled `pg_advisory_lock` would
    // also kill an instance merely waiting for a peer during a rolling deploy.
    await client.query("SET statement_timeout = 0");
    // Session-level, so it outlives this function unless the connection does not survive it.
    discardClient = true;
    await acquireSessionAdvisoryLock(client, {
      key: SKEIN_MIGRATIONS_LOCK,
      timeoutMs: lockTimeoutMs,
      timeoutMessage:
        `Timed out after ${lockTimeoutMs}ms waiting for the skein migration lock ` +
        `(pg_advisory_lock key ${SKEIN_MIGRATIONS_LOCK}). Another instance is either still ` +
        `migrating, or a previous one died holding the lock — check for idle sessions with ` +
        `\`SELECT * FROM pg_locks WHERE locktype = 'advisory'\`.`,
    });
    try {
      await client.query(CREATE_MIGRATIONS_TABLE);
      // Read the ledger only after the lock: whoever waited sees the winner's committed rows and
      // correctly finds nothing to do.
      const applied = await client.query<{ name: string }>(
        `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY run_on, id`,
      );
      const pending = selectPendingMigrations(
        migrations,
        applied.rows.map((row) => row.name),
      );

      for (const migration of pending) {
        if (migration.statements) {
          await applyConcurrentMigration(client, migration);
          continue;
        }
        await client.query("BEGIN");
        try {
          // No values array — that keeps `pg` on the simple query protocol, which is what allows a
          // multi-statement migration body. The extended protocol would reject it.
          await client.query(migration.up);
          await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (name, run_on) VALUES ($1, NOW())`, [
            migration.name,
          ]);
          await client.query("COMMIT");
        } catch (error) {
          // The ROLLBACK is best-effort: the usual cause of a failed migration is a dropped
          // connection, and letting its rejection propagate would replace the only error that names
          // the migration. Postgres discards an uncommitted transaction on disconnect anyway.
          try {
            await client.query("ROLLBACK");
          } catch {
            discardClient = true;
          }
          throw new Error(
            `Migration "${migration.name}" failed and was rolled back: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }

      return pending.map((migration) => migration.name);
    } finally {
      // Releasing the lock matters more than anything that went wrong above: every other instance
      // is polling for it. If we can't prove it was released, destroy the connection — that ends
      // the session, which is what actually frees a session-scoped advisory lock.
      try {
        const released = await client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock($1) AS released",
          [SKEIN_MIGRATIONS_LOCK],
        );
        if (released.rows[0]?.released !== true) discardClient = true;
      } catch {
        discardClient = true;
      }
    }
  } finally {
    client.release(discardClient);
  }
}
