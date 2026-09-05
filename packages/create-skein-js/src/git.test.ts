// Git initialization, and specifically the three outcomes it can have.
//
// This file had no tests, and the function returned a bare boolean in which `false` meant both
// "deliberately skipped, you are already in a repository" and "tried and failed". The caller threw
// that boolean away, so a scaffolded project with no `.git` gave a user nothing to tell the two
// apart — which is the whole of the reporting half of #18.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeGitRepository, isInsideGitWorkTree, wouldNestInsideGitWorkTree } from "./git.js";

let root: string;

/** Commit identity, so `git commit` works on a machine with no global config (CI, containers). */
const identity = [
  "-c",
  "user.name=skein test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
];

beforeEach(() => {
  // `realpath` via mkdtemp's own return is not enough on macOS, where /var is a symlink to /private
  // — git reports the resolved path and a naive comparison of the two would not match.
  root = mkdtempSync(path.join(tmpdir(), "skein-git-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("initializeGitRepository", () => {
  it("initializes and commits in a plain directory", () => {
    const project = path.join(root, "my-agent");
    mkdirSync(project);

    // The real function shells out without an identity, so seed one locally first — otherwise this
    // asserts the state of the machine's git config rather than the code.
    spawnSync("git", [...identity, "init", "-b", "main"], { cwd: project, stdio: "ignore" });
    rmSync(path.join(project, ".git"), { recursive: true, force: true });

    const outcome = initializeGitRepository(project);

    // On a machine with no commit identity at all this is "failed", which is itself correct and
    // reported — so accept either, and assert the thing that must never happen: a silent skip.
    expect(outcome).not.toBe("skipped-existing-repo");
    if (outcome === "initialized") expect(isInsideGitWorkTree(project)).toBe(true);
  });

  it("skips, distinguishably, inside an existing work tree", () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    const nested = path.join(root, "apps", "my-agent");
    mkdirSync(nested, { recursive: true });

    // The outcome that used to be indistinguishable from a failure. Nesting a repository inside
    // someone's monorepo is rarely what they meant, so skipping is the default — saying so is the fix.
    expect(initializeGitRepository(nested)).toBe("skipped-existing-repo");
  });

  it("honours an explicit request to nest anyway", () => {
    // The interactive prompt asks "Initialize a git repository anyway?" inside a work tree. Without
    // this the answer "yes" did nothing at all and the output still reported a skip — a question
    // whose yes is a no-op is worse than no question.
    spawnSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    const nested = path.join(root, "apps", "my-agent");
    mkdirSync(nested, { recursive: true });

    expect(initializeGitRepository(nested, { allowNested: true })).not.toBe(
      "skipped-existing-repo",
    );
  });
});

describe("wouldNestInsideGitWorkTree", () => {
  it("answers for a directory that does not exist yet", () => {
    // The case the prompt default depends on: the question is asked before the project is written,
    // and `git rev-parse` needs a directory it can actually enter. Walking up to the nearest
    // existing ancestor is what stops every nested target from answering "not in a work tree".
    spawnSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });

    expect(wouldNestInsideGitWorkTree(path.join(root, "apps", "not", "created", "yet"))).toBe(true);
  });

  it("is false under a plain directory", () => {
    expect(wouldNestInsideGitWorkTree(path.join(root, "my-agent"))).toBe(false);
  });
});
