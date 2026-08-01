// Guards the generated migration module against the .sql files it is generated from, and pins the
// ledger contract. The oracle below re-implements the up/down split independently rather than
// importing scripts/generate-migrations.mjs — a test that reuses the generator's own logic cannot
// catch a bug in that logic.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INFLIGHT_RUN_STATUSES, isTerminalRunStatus, type RunStatus } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { SKEIN_MIGRATIONS } from "./migrations.generated.js";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** node-pg-migrate's section marker, re-derived from its documented `-- Up/Down Migration` form. */
const sectionMarker = (direction: "up" | "down") =>
  new RegExp(`^\\s*--[\\s-]*${direction}\\s+migration`, "im");

/** Independently re-derived split for a `-- skein:concurrent` migration. */
function splitStatements(up: string): string[] {
  return up
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

/** What SKEIN_MIGRATIONS should contain, read straight from the .sql files. */
function readMigrationsFromDisk(): { name: string; up: string; statements?: string[] }[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const contents = readFileSync(path.join(migrationsDir, file), "utf8");
      const upStart = contents.search(sectionMarker("up"));
      const downStart = contents.search(sectionMarker("down"));
      const up =
        upStart < 0
          ? contents
          : contents.slice(upStart, downStart < upStart ? undefined : downStart);
      const name = path.basename(file, ".sql");
      // A concurrent migration carries its statements pre-split, since `CREATE INDEX CONCURRENTLY`
      // cannot run inside the transaction the normal multi-statement path implies.
      return /^\s*--\s*skein:concurrent\s*$/im.test(up)
        ? { name, up, statements: splitStatements(up) }
        : { name, up };
    });
}

describe("SKEIN_MIGRATIONS", () => {
  it("matches migrations/*.sql byte for byte", () => {
    // Fails when someone edits a .sql file without running `pnpm migrations:generate`.
    expect(SKEIN_MIGRATIONS).toEqual(readMigrationsFromDisk());
  });

  it("keeps the ledger names node-pg-migrate wrote before 0.10.0", () => {
    // Pinned literally: these are the primary keys of every existing production skein_migrations
    // ledger. Renaming one silently re-runs an already-applied migration against a live database.
    expect(SKEIN_MIGRATIONS.map((migration) => migration.name)).toEqual([
      "0001_init",
      "0002_store_ttl",
      "0003_assistant_versions",
      "0004_run_error",
      "0005_performance_indexes",
      "0006_inflight_runs_index",
      "0007_crons",
    ]);
  });

  it("keeps the inflight partial index in step with INFLIGHT_RUN_STATUSES", () => {
    // The queries behind `POST /runs/cancel` filter `status IN (…)` from `INFLIGHT_RUN_STATUSES`; this
    // index is predicated on a literal list. The planner matches a partial index only when the query's
    // restriction implies the predicate, so if the two lists ever disagree the sweep silently reverts to
    // a sequential scan over every run ever recorded — with nothing failing to say so.
    const migration = SKEIN_MIGRATIONS.find((entry) => entry.name === "0006_inflight_runs_index");
    const predicate = /WHERE status IN \(([^)]*)\)/.exec(migration?.up ?? "")?.[1];
    const indexed = predicate?.split(",").map((status) => status.trim().replace(/'/g, ""));

    expect(indexed).toBeDefined();
    expect(indexed?.sort()).toEqual([...INFLIGHT_RUN_STATUSES].sort());
    // And they really are the non-terminal ones, so the index covers the set the guard calls inflight.
    for (const status of indexed ?? []) {
      expect(isTerminalRunStatus(status as RunStatus)).toBe(false);
    }
  });

  it("pre-splits a concurrent migration into index DDL only", () => {
    // The runner executes these outside a transaction, one at a time, so each must genuinely be a
    // single statement — and only index DDL, which is the one thing the naive `;` split is safe for.
    const concurrent = SKEIN_MIGRATIONS.filter((migration) => migration.statements !== undefined);
    expect(concurrent.length).toBeGreaterThan(0);

    for (const migration of concurrent) {
      expect(migration.statements?.length).toBeGreaterThan(0);
      for (const statement of migration.statements ?? []) {
        expect(statement).toMatch(/^(CREATE|DROP)\s+INDEX\b/i);
        expect(statement).not.toContain(";");
        // Non-transactional means non-atomic, so a retry has to be a no-op for what already applied.
        expect(statement).toMatch(/IF (NOT )?EXISTS/i);
      }
    }
  });

  it("marks only migrations that need it as concurrent", () => {
    // A migration wrongly marked concurrent loses its transaction; one wrongly left unmarked fails
    // outright, since Postgres rejects CONCURRENTLY inside a transaction block.
    for (const migration of SKEIN_MIGRATIONS) {
      const usesConcurrently = /\bCONCURRENTLY\b/i.test(migration.up);
      expect(migration.statements !== undefined).toBe(usesConcurrently);
    }
  });

  it("carries only the up half of each file", () => {
    for (const migration of SKEIN_MIGRATIONS) {
      expect(migration.up.trim()).not.toBe("");
      expect(migration.up).toContain("-- Up Migration");
      expect(migration.up).not.toContain("-- Down Migration");
    }
  });

  it("survived template-literal escaping intact", () => {
    // A stray `${` in the generated source would have been interpolated instead of embedded.
    for (const migration of SKEIN_MIGRATIONS) {
      expect(migration.up).not.toContain("${");
    }
  });
});
