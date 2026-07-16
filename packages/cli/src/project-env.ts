// Shared env resolution for the CLI commands. A conventional `.env` in the project is the base,
// `langgraph.json`'s declared `env` overrides it, and the ambient environment wins over both
// (dotenv convention). Both `skein dev` and `skein import-langgraph` apply env this way, so keeping
// it in one place stops the two commands from resolving the same project's env (e.g. POSTGRES_URI)
// differently. `resolveEnv` itself is intentionally pure (it just computes the map); this is the
// thin "apply to process.env" layer on top.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseEnvFile, resolveEnv, type LanggraphJson } from "@skein-js/config";

/** Apply resolved env to `process.env` without clobbering values already set (ambient wins). */
function applyEnv(resolved: Record<string, string>): void {
  for (const [key, value] of Object.entries(resolved)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Parse a conventional `.env` in `dir`, if present. Best-effort — a read/parse error yields `{}`. */
function readConventionalDotEnv(dir: string): Record<string, string> {
  const envPath = path.join(dir, ".env");
  if (!existsSync(envPath)) return {};
  try {
    return parseEnvFile(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Resolve `config`'s env against `configDir` and apply it to `process.env`. Warns (once) if the
 * declared `env` file is missing but continues. Skips the conventional `.env` read when the declared
 * `env` already points at the same file, so it isn't read and parsed twice.
 */
export async function applyProjectEnv(config: LanggraphJson, configDir: string): Promise<void> {
  const declaredEnvPath =
    typeof config.env === "string" ? path.resolve(configDir, config.env) : undefined;
  const conventional =
    declaredEnvPath === path.join(configDir, ".env") ? {} : readConventionalDotEnv(configDir);
  applyEnv({ ...conventional, ...(await resolveEnv(config, configDir)) });
  if (declaredEnvPath !== undefined && !existsSync(declaredEnvPath)) {
    console.warn(`skein: env file "${config.env}" not found; continuing without it.`);
  }
}
