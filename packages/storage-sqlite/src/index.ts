import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import type { RunQueue, SkeinStore, StoreTtlConfig, ThreadTtlConfig } from "@skein-js/core";
import DatabaseConstructor, { type Database } from "better-sqlite3";

import { migrateDatabase } from "./database.js";
import { reconcileAbandonedRuns } from "./reconcile.js";
import { createSqliteQueue } from "./sqlite-queue.js";
import { SqliteSkeinStore } from "./sqlite-store.js";

export interface SqliteStorageOptions {
  filename: string;
  maxPageSize?: number;
  ttl?: StoreTtlConfig;
  threadTtl?: ThreadTtlConfig;
}
export interface SqliteStorage {
  store: SkeinStore;
  queue: RunQueue;
  /** Borrowed connection. Do not close it or change its ownership/locking settings. */
  database: Database;
  dispose(): Promise<void>;
}
export async function openSqliteStorage(options: SqliteStorageOptions): Promise<SqliteStorage> {
  if (!isAbsolute(options.filename))
    throw new Error("SQLite filename must be an absolute file path.");
  await mkdir(dirname(options.filename), { recursive: true });
  const database = new DatabaseConstructor(options.filename, { timeout: 5000 });
  try {
    database.pragma("locking_mode = EXCLUSIVE");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("foreign_keys = ON");
    // An initialization write actually takes the lock; setting locking_mode alone does not.
    migrateDatabase(database);
    database.prepare("UPDATE skein_migrations SET version=version").run();
    const queue = createSqliteQueue(database);
    const store = new SqliteSkeinStore(database, options, queue.wake);
    reconcileAbandonedRuns(database);
    let disposal: Promise<void> | undefined;
    return {
      store,
      queue,
      database,
      dispose() {
        disposal ??= (async () => {
          await queue.dispose();
          database.close();
        })();
        return disposal;
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
