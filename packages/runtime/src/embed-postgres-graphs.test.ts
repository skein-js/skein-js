import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { embedPostgresGraphs } from "./embed-postgres-graphs.js";
import { RuntimeConfigError } from "./errors.js";

/** A minimal, real compiled graph — a valid `EmbeddableGraph` map value (never loaded in these tests). */
function buildGraph() {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({ messages: [] }))
    .addEdge("__start__", "noop")
    .addEdge("noop", "__end__")
    .compile();
}

// These assertions all fail BEFORE any pool is opened (a missing URL or a bad PG_POOL_MAX throws during
// option resolution), so they need no Docker — the connect-and-round-trip path lives in the integration
// test. Save/restore the env we mutate so the cases stay independent.
describe("embedPostgresGraphs — config validation (no connection)", () => {
  const saved: Record<string, string | undefined> = {};
  const stash = (name: string) => {
    saved[name] = process.env[name];
    delete process.env[name];
  };

  beforeEach(() => {
    stash("POSTGRES_URI");
    stash("REDIS_URI");
    stash("PG_POOL_MAX");
    stash("PG_CONNECTION_TIMEOUT_MS");
    stash("PG_IDLE_TIMEOUT_MS");
    stash("PG_STATEMENT_TIMEOUT_MS");
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("rejects with RuntimeConfigError when POSTGRES_URI is unset and no postgresUri is passed", async () => {
    await expect(embedPostgresGraphs({ echo: buildGraph() })).rejects.toThrow(RuntimeConfigError);
  });

  it("rejects with RuntimeConfigError when PG_POOL_MAX is not a positive integer", async () => {
    process.env["PG_POOL_MAX"] = "0";
    // An explicit postgresUri gets past the URL check, but the bad pool tuning still throws first.
    await expect(
      embedPostgresGraphs({ echo: buildGraph() }, { postgresUri: "postgres://unused/db" }),
    ).rejects.toThrow(/PG_POOL_MAX/);
  });

  it("rejects with RuntimeConfigError when an explicit poolMax is not a positive integer", async () => {
    // The explicit option is validated the same as the env var — before any pool is opened.
    await expect(
      embedPostgresGraphs(
        { echo: buildGraph() },
        { postgresUri: "postgres://unused/db", poolMax: 0 },
      ),
    ).rejects.toThrow(/poolMax/);
    await expect(
      embedPostgresGraphs(
        { echo: buildGraph() },
        { postgresUri: "postgres://unused/db", poolMax: -1 },
      ),
    ).rejects.toThrow(/poolMax/);
  });

  it("treats a blank postgresUri as unset (falls through to the env requirement)", async () => {
    // POSTGRES_URI is unset (beforeEach), so a blank explicit URI must yield the actionable
    // RuntimeConfigError, not an opaque connection attempt to "".
    await expect(
      embedPostgresGraphs({ echo: buildGraph() }, { postgresUri: "   " }),
    ).rejects.toThrow(RuntimeConfigError);
  });
});
