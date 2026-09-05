// Initializing a git repository in the scaffolded project.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Run a git command in `directory`, swallowing its output. Returns whether it succeeded. */
function git(directory: string, ...args: string[]): boolean {
  const result = spawnSync("git", args, { cwd: directory, stdio: "ignore", shell: false });
  return result.status === 0;
}

/** Whether `directory` already sits inside a git work tree. */
export function isInsideGitWorkTree(directory: string): boolean {
  return git(directory, "rev-parse", "--is-inside-work-tree");
}

/**
 * The nearest ancestor of `directory` that exists, or `directory` itself if it does.
 *
 * `git rev-parse` needs a directory it can `cd` into, and the git question has to be answerable
 * *before* the project is written — that is when the user is asked about it, and when the default
 * for that question is decided. Asking about a path that does not exist yet would answer "not in a
 * work tree" for every nested target, which is precisely backwards inside someone's monorepo.
 */
function nearestExistingDirectory(directory: string): string {
  let current = path.resolve(directory);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current; // filesystem root; give up rather than loop
    current = parent;
  }
  return current;
}

/** Whether scaffolding into `directory` would land inside a repository that already exists. */
export function wouldNestInsideGitWorkTree(directory: string): boolean {
  return isInsideGitWorkTree(nearestExistingDirectory(directory));
}

/**
 * What `initializeGitRepository` did.
 *
 * Three outcomes, not a boolean: `false` used to mean both "deliberately skipped, you are already in
 * a repository" and "tried and failed", which is exactly the distinction someone staring at a
 * project with no `.git` needs — and the caller could not report what it could not tell apart.
 */
export type GitOutcome = "initialized" | "skipped-existing-repo" | "failed";

/**
 * Initialize a repository and make the first commit.
 *
 * Skipped by default when the target is already inside a work tree — scaffolding into a clone is a
 * normal thing to do, and nesting a repository inside another is rarely what someone meant. Rarely,
 * not never: `allowNested` exists because the interactive prompt offers exactly that choice, and a
 * question whose "yes" silently did nothing would be worse than not asking. So the skip is the
 * default, and an explicit answer overrides it.
 *
 * Every failure is non-fatal and reported by the return value: git may be missing, or present but
 * without `user.email` configured, and neither is a reason to fail a scaffold that has already
 * written every file successfully.
 */
export function initializeGitRepository(
  projectDirectory: string,
  options: { allowNested?: boolean } = {},
): GitOutcome {
  if (options.allowNested !== true && isInsideGitWorkTree(projectDirectory)) {
    return "skipped-existing-repo";
  }
  if (!git(projectDirectory, "init", "-b", "main")) return "failed";
  if (!git(projectDirectory, "add", "-A")) return "failed";
  return git(projectDirectory, "commit", "-m", "chore: scaffold skein-js project")
    ? "initialized"
    : "failed";
}
