import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { globSync } from "tinyglobby";

import { hasWorkspaceMarker, type WorkspaceSnapshot } from "./workspace.js";

/** Read only; never creates a directory or changes a workspace during discovery. */
export function findWorkspace(target: string): WorkspaceSnapshot | undefined {
  let directory = path.resolve(target);
  while (true) {
    const read = (filename: string): string | undefined => {
      const absolute = path.join(directory, filename);
      return existsSync(absolute) && statSync(absolute).isFile()
        ? readFileSync(absolute, "utf8")
        : undefined;
    };
    if (hasWorkspaceMarker(read)) {
      const root = directory;
      return {
        root,
        target: path.relative(root, target).split(path.sep).join("/"),
        read: (filename) => {
          const absolute = path.join(root, filename);
          return existsSync(absolute) && statSync(absolute).isFile()
            ? readFileSync(absolute, "utf8")
            : undefined;
        },
        listPackagePaths: (patterns) =>
          patterns.length === 0
            ? []
            : globSync(
                patterns.map(
                  (pattern) => pattern.replace(/^\.\//, "").replace(/\/$/, "") + "/package.json",
                ),
                { cwd: root, ignore: ["**/node_modules/**", "**/.git/**", "**/.skein/**"] },
              ),
      };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
