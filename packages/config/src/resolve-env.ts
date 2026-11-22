// `langgraph.json`'s `env` field — a `.env` file path or an inline map — resolved into a plain
// key→value map. This is a *pure* resolver: it reads the file (if a path) but never touches
// `process.env`. Callers decide how to apply it (`skein dev` merges it into the child's spawn
// env; `skein up` bakes it into the image), and callers own precedence against the ambient
// environment. Keeping it pure makes it trivially testable and reusable across both commands.

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { LanggraphJson } from "./langgraph-json.js";

/**
 * Parse `.env` file text into a key→value map. Supports blank lines, `#` comments, an optional
 * leading `export `, and single- or double-quoted values (quotes stripped). Later keys win.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (key === "") continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];

    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

/**
 * Resolve `config.env` to a key→value map. An inline map is returned as-is; a string is treated
 * as a `.env` path relative to `configDir` and parsed. A missing declared file resolves to `{}`
 * (a common, tolerable dev state) — the caller can warn. No `env` field also yields `{}`.
 */
export async function resolveEnv(
  config: LanggraphJson,
  configDir: string,
): Promise<Record<string, string>> {
  const { env } = config;
  if (env === undefined) return {};
  if (typeof env !== "string") return { ...env };

  const envPath = path.resolve(configDir, env);
  let text: string;

  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return {};
  }

  return parseEnvFile(text);
}
