import path from "node:path";

import { format, resolveConfig } from "prettier";

import type { GeneratedFile } from "./scaffold-options.js";

/** Format new project files using the destination workspace's Prettier configuration. */
export async function formatProjectFiles(
  files: readonly GeneratedFile[],
  targetDirectory: string,
): Promise<GeneratedFile[]> {
  return Promise.all(
    files.map(async (file) =>
      /\.(?:json|ts|mjs|md|ya?ml)$/.test(file.path)
        ? {
            ...file,
            contents: await format(file.contents, {
              printWidth: 100,
              ...(await resolveConfig(path.join(targetDirectory, file.path))),
              filepath: path.join(targetDirectory, file.path),
            }),
          }
        : file,
    ),
  );
}
