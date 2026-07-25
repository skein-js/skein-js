import { describe, expect, it } from "vitest";

import { selectPendingMigrations } from "./run-migrations.js";

const migrations = [
  { name: "0001_init", up: "SELECT 1" },
  { name: "0002_store_ttl", up: "SELECT 2" },
  { name: "0003_assistant_versions", up: "SELECT 3" },
];

const namesOf = (pending: { name: string }[]) => pending.map((migration) => migration.name);

describe("selectPendingMigrations", () => {
  it("returns nothing when there is nothing declared", () => {
    expect(selectPendingMigrations([], [])).toEqual([]);
  });

  it("returns every migration for a fresh database, oldest first", () => {
    expect(namesOf(selectPendingMigrations(migrations, []))).toEqual([
      "0001_init",
      "0002_store_ttl",
      "0003_assistant_versions",
    ]);
  });

  it("returns only what a partially-migrated database is missing", () => {
    expect(namesOf(selectPendingMigrations(migrations, ["0001_init"]))).toEqual([
      "0002_store_ttl",
      "0003_assistant_versions",
    ]);
  });

  it("returns nothing for a fully-migrated database", () => {
    expect(selectPendingMigrations(migrations, namesOf(migrations))).toEqual([]);
  });

  it("tolerates ledger entries this build has never heard of", () => {
    // A downgrade: an older binary meeting a database migrated by a newer one. Not corruption —
    // the newer migrations simply aren't ours to run.
    expect(selectPendingMigrations(migrations, [...namesOf(migrations), "0004_future"])).toEqual(
      [],
    );
  });

  it("refuses to run when the ledger disagrees with the declared order", () => {
    expect(() => selectPendingMigrations(migrations, ["0002_store_ttl"])).toThrow(
      /order mismatch.*0002_store_ttl.*0001_init/s,
    );
  });
});
