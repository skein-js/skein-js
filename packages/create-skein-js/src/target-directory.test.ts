import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertTargetDirectoryUsable, findBlockingEntries } from "./target-directory.js";

function temporaryDirectory(): string {
  return mkdtempSync(path.join(tmpdir(), "create-skein-js-"));
}

describe("assertTargetDirectoryUsable", () => {
  it("allows a directory that does not exist yet", () => {
    const target = path.join(temporaryDirectory(), "my-agent");
    expect(() => assertTargetDirectoryUsable(target, { force: false })).not.toThrow();
  });

  it("allows an empty directory", () => {
    expect(() => assertTargetDirectoryUsable(temporaryDirectory(), { force: false })).not.toThrow();
  });

  // Creating an empty repo, cloning it, then scaffolding into the clone is a common first move.
  // Refusing it would send the user off to look up a flag for no reason.
  it("allows a fresh git clone", () => {
    const target = temporaryDirectory();
    mkdirSync(path.join(target, ".git"));
    writeFileSync(path.join(target, "LICENSE"), "Apache-2.0\n");
    expect(() => assertTargetDirectoryUsable(target, { force: false })).not.toThrow();
  });

  it("refuses a directory with real files in it, naming them", () => {
    const target = temporaryDirectory();
    writeFileSync(path.join(target, "index.ts"), "");
    expect(() => assertTargetDirectoryUsable(target, { force: false })).toThrow(/index\.ts/);
    expect(() => assertTargetDirectoryUsable(target, { force: false })).toThrow(/--force/);
  });

  it("scaffolds into a non-empty directory when forced", () => {
    const target = temporaryDirectory();
    writeFileSync(path.join(target, "index.ts"), "");
    expect(() => assertTargetDirectoryUsable(target, { force: true })).not.toThrow();
  });
});

describe("findBlockingEntries", () => {
  it("reports nothing for a missing directory", () => {
    expect(findBlockingEntries(path.join(temporaryDirectory(), "absent"))).toEqual([]);
  });
});
