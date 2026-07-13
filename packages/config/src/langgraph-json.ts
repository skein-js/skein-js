// The `langgraph.json` contract, exactly as the LangGraph CLI defines it — skein-js reads an
// existing file unchanged (docs/langgraph-cli-compat.md). We validate only the fields we act
// on and pass everything else through, so a config with newer/unknown keys still loads and a
// round-trip preserves it. Zod gives us a typed value plus a precise error at the boundary.

import { z } from "zod";

import { SkeinConfigError } from "./errors.js";

/** `store.index` — drives pgvector semantic search on the Postgres driver. */
const storeIndexSchema = z
  .object({
    embed: z.string().optional(),
    dims: z.number().optional(),
    fields: z.array(z.string()).optional(),
  })
  .passthrough();

export const langgraphJsonSchema = z
  .object({
    /** REQUIRED: map of graph id → "path:export". */
    graphs: z.record(z.string()),
    /** JS/Node runtime pin (used by `skein build` / `dockerfile`). */
    node_version: z.string().optional(),
    /** `.env` path or an inline map, loaded into `process.env` at boot. */
    env: z.union([z.string(), z.record(z.string())]).optional(),
    /** Long-term memory store config. */
    store: z.object({ index: storeIndexSchema.optional() }).passthrough().optional(),
    /** Checkpointer backend; `"default"` == Postgres, absent == in-memory. */
    checkpointer: z.object({ type: z.string() }).passthrough().optional(),
    /** Server customization (CORS, route toggles) applied by the framework adapter. */
    http: z.object({}).passthrough().optional(),
    /** Extra lines appended by `skein dockerfile` / `build`. */
    dockerfile_lines: z.array(z.string()).optional(),
    /** Dependency hints for image builds. */
    dependencies: z.array(z.string()).optional(),
  })
  .passthrough();

/** The validated `langgraph.json` shape (unknown keys preserved via passthrough). */
export type LanggraphJson = z.infer<typeof langgraphJsonSchema>;

/** Validate parsed JSON against the {@link langgraphJsonSchema}, throwing on any violation. */
export function parseLanggraphJson(raw: unknown): LanggraphJson {
  const result = langgraphJsonSchema.safeParse(raw);
  if (!result.success) {
    throw new SkeinConfigError("Invalid langgraph.json.", {
      cause: result.error,
      details: result.error.issues,
    });
  }
  return result.data;
}
