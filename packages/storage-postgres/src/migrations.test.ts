// Guards the generated migration module against the .sql files it is generated from, and pins the
// ledger contract. The oracle below re-implements the up/down split independently rather than
// importing scripts/generate-migrations.mjs — a test that reuses the generator's own logic cannot
// catch a bug in that logic.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SKEIN_MIGRATIONS } from "./migrations.generated.js";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/** node-pg-migrate's section marker, re-derived from its documented `-- Up/Down Migration` form. */
const sectionMarker = (direction: "up" | "down") =>
  new RegExp(`^\\s*--[\\s-]*${direction}\\s+migration`, "im");

/** What SKEIN_MIGRATIONS should contain, read straight from the .sql files. */
function readMigrationsFromDisk(): { name: string; up: string }[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const contents = readFileSync(path.join(migrationsDir, file), "utf8");
      const upStart = contents.search(sectionMarker("up"));
      const downStart = contents.search(sectionMarker("down"));
      return {
        name: path.basename(file, ".sql"),
        up:
          upStart < 0
            ? contents
            : contents.slice(upStart, downStart < upStart ? undefined : downStart),
      };
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
    ]);
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
