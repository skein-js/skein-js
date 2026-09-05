// Shared env resolution for the CLI commands. A conventional `.env` in the project is the base,
// `langgraph.json`'s declared `env` overrides it, and the ambient environment wins over both
// (dotenv convention). `skein dev`, `skein start` and `skein import-langgraph` all apply env this
// way, so keeping it in one place stops them from resolving the same project's env (e.g.
// POSTGRES_URI) differently. `resolveEnv` itself is intentionally pure (it just computes the map); this is the
// thin "apply to process.env" layer on top.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseEnvFile, resolveEnv, type LanggraphJson } from "@skein-js/config";

/**
 * Keys this module put into `process.env` itself, so a later call may update *its own* values while a
 * value it never set keeps outranking the file.
 *
 * Without this, `skein dev`'s reload could apply a key exactly once and never again — and the first
 * application is frequently the wrong one. A scaffolded `.env` ships `# GOOGLE_API_KEY=` (commented,
 * no value); uncommenting it before pasting the key — an autosave, or simply the order most people
 * type in — parses to `""`, applies, and from then on the variable is no longer `undefined`. Pasting
 * the real key and saving would do nothing for the life of the process, while every message skein
 * prints says "save and the dev server picks it up".
 */
const appliedKeys = new Set<string>();

/**
 * Apply resolved env to `process.env`. Fills a hole, or updates a value this module set on an earlier
 * call; a value that was already in the ambient environment is never clobbered (dotenv convention).
 */
function applyEnv(resolved: Record<string, string>): void {
  for (const [key, value] of Object.entries(resolved)) {
    if (process.env[key] === undefined || appliedKeys.has(key)) {
      process.env[key] = value;
      appliedKeys.add(key);
    }
  }
}

/** Whether the missing-env-file warning has been emitted, so a reload does not repeat it. */
let warnedMissingEnvFile = false;

/**
 * The env files this project reads, absolute and de-duplicated: the conventional `<dir>/.env` and
 * `langgraph.json`'s declared `env` when it names a file rather than an inline map.
 *
 * `skein dev` adds these to its watcher so that filling in a missing key — the single most common
 * reason a graph fails to load — reloads the graphs instead of needing a restart. Returned whether
 * or not the files exist: one that is created later is exactly the case worth watching for.
 */
export function projectEnvPaths(config: LanggraphJson, configDir: string): string[] {
  const paths = [path.join(configDir, ".env")];
  if (typeof config.env === "string") paths.push(path.resolve(configDir, config.env));
  return [...new Set(paths)];
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
 * Resolve `config`'s env against `configDir` and apply it to `process.env`. Warns if the declared
 * `env` file is missing but continues — once per process, not once per call, since `skein dev` calls
 * this again on every reload. Skips the conventional `.env` read when the declared
 * `env` already points at the same file, so it isn't read and parsed twice.
 *
 * `alsoReadDotEnvIn` adds a second conventional `.env`, ranked *below* everything else — see below.
 */
export async function applyProjectEnv(
  config: LanggraphJson,
  configDir: string,
  options: { alsoReadDotEnvIn?: string } = {},
): Promise<void> {
  const declaredEnvPath =
    typeof config.env === "string" ? path.resolve(configDir, config.env) : undefined;
  const conventional =
    declaredEnvPath === path.join(configDir, ".env") ? {} : readConventionalDotEnv(configDir);
  // A second conventional `.env`, at the lowest precedence, for a command whose config does not sit
  // in the project. `skein start` is the only such command: it serves a *build*, so `configDir` is
  // `.skein/build`, and a build deliberately carries no `.env` — it is the Docker build context, and
  // `write-manifest` drops a file `env` for the same reason. Without this the URIs a scaffolded
  // project ships in its own `.env` are never seen by the entrypoint that requires them.
  const extra =
    options.alsoReadDotEnvIn !== undefined &&
    path.resolve(options.alsoReadDotEnvIn) !== path.resolve(configDir)
      ? readConventionalDotEnv(options.alsoReadDotEnvIn)
      : {};
  applyEnv({ ...extra, ...conventional, ...(await resolveEnv(config, configDir)) });
  if (declaredEnvPath !== undefined && !existsSync(declaredEnvPath) && !warnedMissingEnvFile) {
    warnedMissingEnvFile = true;
    console.warn(`skein: env file "${config.env}" not found; continuing without it.`);
  }
}
