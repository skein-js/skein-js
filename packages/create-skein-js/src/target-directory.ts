// Deciding whether it is safe to scaffold into a given directory.

import { existsSync, readdirSync, statSync } from "node:fs";

/**
 * Entries that do not make a directory "occupied".
 *
 * `.git` is the important one: creating an empty repo on GitHub, cloning it, and scaffolding into
 * the clone is a common first move, and refusing it would send the user off to read a flag.
 */
const IGNORABLE_ENTRIES = new Set([
  ".git",
  ".gitkeep",
  ".gitattributes",
  ".hg",
  ".DS_Store",
  "Thumbs.db",
  ".idea",
  ".vscode",
  "LICENSE",
  "LICENSE.md",
]);

/** Raised when the target directory holds files we would otherwise write over. */
export class TargetDirectoryNotEmptyError extends Error {
  constructor(
    readonly targetDirectory: string,
    readonly blockingEntries: readonly string[],
  ) {
    super(
      `${targetDirectory} is not empty (${blockingEntries.slice(0, 5).join(", ")}` +
        `${blockingEntries.length > 5 ? ", …" : ""}). Pass --force to scaffold into it anyway.`,
    );
    this.name = "TargetDirectoryNotEmptyError";
  }
}

/** The entries in `targetDirectory` that would make scaffolding unsafe. Empty when it is fine. */
export function findBlockingEntries(targetDirectory: string): readonly string[] {
  if (!existsSync(targetDirectory)) return [];
  if (!statSync(targetDirectory).isDirectory()) return [targetDirectory];
  return readdirSync(targetDirectory).filter((entry) => !IGNORABLE_ENTRIES.has(entry));
}

/**
 * Throw unless it is safe to scaffold into `targetDirectory`. A missing directory is fine — the
 * writer creates it — as is one holding nothing but the ignorable entries above.
 */
export function assertTargetDirectoryUsable(
  targetDirectory: string,
  options: { readonly force: boolean },
): void {
  if (options.force) return;
  const blockingEntries = findBlockingEntries(targetDirectory);
  if (blockingEntries.length > 0) {
    throw new TargetDirectoryNotEmptyError(targetDirectory, blockingEntries);
  }
}
