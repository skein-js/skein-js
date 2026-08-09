// Initializing a git repository in the scaffolded project.

import { spawnSync } from "node:child_process";

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
 * Initialize a repository and make the first commit.
 *
 * Skipped entirely when the target is already inside a work tree — scaffolding into a clone is a
 * normal thing to do, and nesting a repository inside another is never what someone meant.
 *
 * Every failure is non-fatal and reported by the return value: git may be missing, or present but
 * without `user.email` configured, and neither is a reason to fail a scaffold that has already
 * written every file successfully.
 */
export function initializeGitRepository(projectDirectory: string): boolean {
  if (isInsideGitWorkTree(projectDirectory)) return false;
  if (!git(projectDirectory, "init", "-b", "main")) return false;
  if (!git(projectDirectory, "add", "-A")) return false;
  return git(projectDirectory, "commit", "-m", "chore: scaffold skein-js project");
}
