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

/** Options for {@link applySkeinMigrations}. */
export interface ApplySkeinMigrationsOptions {
  /** Defaults to the compiled-in {@link SKEIN_MIGRATIONS}. Injectable for tests. */
  migrations?: readonly SkeinMigration[];
  /** How long to wait for a concurrent migration. Defaults to 60s. */
  lockTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Take the migration lock, waiting for a concurrent migration up to `timeoutMs`. */
async function acquireMigrationLock(client: PoolClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const held = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [SKEIN_MIGRATIONS_LOCK],
    );
    if (held.rows[0]?.locked === true) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the skein migration lock ` +
          `(pg_advisory_lock key ${SKEIN_MIGRATIONS_LOCK}). Another instance is either still ` +
          `migrating, or a previous one died holding the lock — check for idle sessions with ` +
          `\`SELECT * FROM pg_locks WHERE locktype = 'advisory'\`.`,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
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
    await acquireMigrationLock(client, lockTimeoutMs);
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
