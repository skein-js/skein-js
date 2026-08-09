// The only I/O in the package. `buildProjectFiles` returns finished file contents; this is the one
// thing that puts them anywhere — the same split as packages/cli/src/bundle/write-manifest.ts, where
// pure builders return strings and the caller does the writing.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { GeneratedFile } from "./scaffold-options.js";

/** Reject any path that would escape the project root before we hand it to the filesystem. */
function assertContainedPath(filePath: string): void {
  if (path.isAbsolute(filePath)) {
    throw new Error(`Refusing to write an absolute path: ${filePath}`);
  }
  if (filePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Refusing to write a path that escapes the project root: ${filePath}`);
  }
}

/** Write generated files into a directory, creating parent directories as needed. */
export function writeFilesToDisk(projectRoot: string, files: readonly GeneratedFile[]): void {
  for (const file of files) {
    assertContainedPath(file.path);
    const destination = path.join(projectRoot, file.path);
    if (file.preserveIfPresent && existsSync(destination)) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.contents, "utf8");
  }
}
