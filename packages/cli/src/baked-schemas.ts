import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { GraphSchemas } from "@skein-js/config";

/** Build writes beside the selected config, which may live outside the working directory. */
function findBuiltConfig(configDir: string): string | undefined {
  const artifactDir = path.join(configDir, ".skein", "build");
  const configFile = path.join(artifactDir, "langgraph.json");
  try {
    if (
      statSync(configFile, { throwIfNoEntry: false })?.isFile() &&
      statSync(path.join(artifactDir, "schemas.json"), { throwIfNoEntry: false })?.isFile()
    ) {
      return configFile;
    }
  } catch {
    // A hint is best-effort: a failed probe must not replace the missing-schema diagnostic.
  }
  return undefined;
}

function quoteCommandPath(filePath: string): string {
  if (/^[\w./:-]+$/.test(filePath)) return filePath;
  return `'${filePath.replaceAll("'", "'\\''")}'`;
}

function missingSchemasMessage(configDir: string, cwd: string): string {
  const message = "no schemas.json next to the config — `skein start` expects a built artifact. ";
  const builtConfig = findBuiltConfig(configDir);
  if (builtConfig) {
    const configArgument = quoteCommandPath(path.relative(cwd, builtConfig));
    return (
      message +
      `Found a built artifact at ${JSON.stringify(path.dirname(builtConfig))}. ` +
      `Run \`skein start -c ${configArgument}\` to serve it.`
    );
  }
  return message + "Run `skein build` (or `skein up`), or use `skein dev` for a source project.";
}

/** Load the artifact's precomputed schemas, without inspecting or importing source graphs. */
export function readBakedSchemas(
  configDir: string,
  cwd = process.cwd(),
): Record<string, GraphSchemas> {
  const schemasFile = path.join(configDir, "schemas.json");
  if (!existsSync(schemasFile)) {
    throw new Error(missingSchemasMessage(configDir, cwd));
  }
  return JSON.parse(readFileSync(schemasFile, "utf8")) as Record<string, GraphSchemas>;
}
