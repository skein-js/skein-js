import type { Database } from "better-sqlite3";

// Compiled into the bundle: opening a database never reads package-relative assets.
const migrations = [
  String.raw`
CREATE TABLE skein_assistants (key TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)));
CREATE TABLE skein_assistant_versions (key TEXT PRIMARY KEY, body TEXT NOT NULL,
 assistant_id TEXT GENERATED ALWAYS AS (json_extract(body, '$.assistant_id')) STORED
 REFERENCES skein_assistants(key) ON DELETE CASCADE);
CREATE TABLE skein_threads (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE skein_runs (key TEXT PRIMARY KEY, body TEXT NOT NULL, kwargs TEXT,
 thread_id TEXT GENERATED ALWAYS AS (json_extract(body, '$.thread_id')) STORED
 REFERENCES skein_threads(key) ON DELETE CASCADE,
 status TEXT GENERATED ALWAYS AS (json_extract(body, '$.status')) STORED);
CREATE INDEX skein_runs_thread ON skein_runs(thread_id, status);
CREATE TABLE skein_items (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires_at INTEGER, ttl_minutes REAL);
CREATE INDEX skein_items_expiry ON skein_items(expires_at);
CREATE INDEX skein_threads_expiry ON skein_threads(expires_at);
CREATE TABLE skein_crons (key TEXT PRIMARY KEY, body TEXT NOT NULL, occurrence_seq INTEGER NOT NULL DEFAULT 0, auth TEXT,
 thread_id TEXT GENERATED ALWAYS AS (json_extract(body, '$.thread_id')) STORED
 REFERENCES skein_threads(key) ON DELETE CASCADE);
CREATE TABLE skein_idempotency (key TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE skein_deliveries (key TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE INDEX skein_deliveries_due ON skein_deliveries(json_extract(body, '$.status'), json_extract(body, '$.next_attempt_at'));
CREATE TABLE skein_run_jobs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE,
 thread_id TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'waiting'
 CHECK(status IN ('waiting','active','done')));
CREATE INDEX skein_run_jobs_due ON skein_run_jobs(status, due_at, sequence);
CREATE TRIGGER skein_delete_thread_jobs AFTER DELETE ON skein_threads BEGIN
 DELETE FROM skein_run_jobs WHERE thread_id = OLD.key;
END;
CREATE TRIGGER skein_delete_run_jobs AFTER DELETE ON skein_runs BEGIN
 DELETE FROM skein_run_jobs WHERE run_id = OLD.key;
END;
`,
];

export function migrateDatabase(database: Database): void {
  database.transaction(() => {
    database.exec("CREATE TABLE IF NOT EXISTS skein_migrations (version INTEGER PRIMARY KEY)");
    const versions = database
      .prepare("SELECT version FROM skein_migrations ORDER BY version")
      .all() as { version: number }[];
    if (versions.some(({ version }) => version > migrations.length)) {
      throw new Error("This SQLite database requires a newer version of @skein-js/storage-sqlite.");
    }
    for (let index = 0; index < migrations.length; index++) {
      if (versions.some(({ version }) => version === index + 1)) continue;
      database.exec(migrations[index]!);
      database.prepare("INSERT INTO skein_migrations(version) VALUES (?)").run(index + 1);
    }
  })();
}
