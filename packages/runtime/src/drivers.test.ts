// Connection tuning resolved from the environment. These run without a database: every assertion is
// about what `postgresConnectionOptions()` returns, which is what both `buildRuntime` and
// `embedPostgresGraphs` hand to every pool they open.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { postgresConnectionOptions, redisEventBusOptions } from "./drivers.js";
import { RuntimeConfigError } from "./errors.js";

const MANAGED_ENV_VARS = [
  "PG_POOL_MAX",
  "PG_CONNECTION_TIMEOUT_MS",
  "PG_IDLE_TIMEOUT_MS",
  "PG_STATEMENT_TIMEOUT_MS",
  "DATABASE_SSL_NO_VERIFY",
  "SKEIN_REDIS_STREAM_MAXLEN",
  "SKEIN_STREAM_BUFFER_FRAMES",
] as const;

// Save/restore rather than mutate: these read `process.env` directly, so leaking a value would make
// later cases depend on ordering.
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of MANAGED_ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("postgresConnectionOptions", () => {
  it("defaults the connection timeout rather than leaving pg to wait forever", () => {
    // The reason this default exists at all: `pg` waits indefinitely for a pool connection, so a
    // database that has gone away turns every request into a hang with no error and no log line.
    //
    // Thirty seconds rather than something tighter: `pg` uses this timer both for the handshake *and*
    // for waiting on a free client when the pool is at `max`, so a tighter bound would fail a burst of
    // slow-but-working queries and an autosuspended serverless Postgres waking on the boot path.
    expect(postgresConnectionOptions().connectionTimeoutMs).toBe(30_000);
  });

  it("accepts 0 for the connection and idle timeouts as an escape hatch", () => {
    // The way back to `pg`'s own behaviour for anyone the default hurts. Rejecting zero would leave
    // them no option, and the sibling PG_STATEMENT_TIMEOUT_MS already reads 0 as "off".
    process.env["PG_CONNECTION_TIMEOUT_MS"] = "0";
    process.env["PG_IDLE_TIMEOUT_MS"] = "0";
    expect(postgresConnectionOptions()).toMatchObject({
      connectionTimeoutMs: 0,
      idleTimeoutMs: 0,
    });
  });

  it("leaves the idle timeout unset and defaults the statement timeout", () => {
    const options = postgresConnectionOptions();
    expect(options.idleTimeoutMs).toBeUndefined();
    // On by default: the list/search paths are page-bounded and indexed now, so a statement still
    // running after 30s is a stuck query rather than a large one.
    expect(options.statementTimeoutMs).toBe(30_000);
  });

  it("reads each timeout from its own variable", () => {
    process.env["PG_CONNECTION_TIMEOUT_MS"] = "2500";
    process.env["PG_IDLE_TIMEOUT_MS"] = "30000";
    process.env["PG_STATEMENT_TIMEOUT_MS"] = "15000";

    expect(postgresConnectionOptions()).toMatchObject({
      connectionTimeoutMs: 2500,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 15_000,
    });
  });

  it("treats a statement timeout of 0 as an explicit no-limit", () => {
    // The escape hatch from the default, so it has to be *accepted* rather than rejected as
    // out-of-range — and it has to reach the pool as `0`, which suppresses the `SET`. Falling back to
    // the default here would make the knob impossible to turn off.
    process.env["PG_STATEMENT_TIMEOUT_MS"] = "0";
    expect(postgresConnectionOptions().statementTimeoutMs).toBe(0);
  });

  it("treats a blank value as unset", () => {
    // `Number("")` is 0, which for a timeout would silently mean something rather than nothing.
    process.env["PG_IDLE_TIMEOUT_MS"] = "   ";
    expect(postgresConnectionOptions().idleTimeoutMs).toBeUndefined();
  });

  it.each([
    ["PG_POOL_MAX", "0"],
    ["PG_CONNECTION_TIMEOUT_MS", "-1"],
    ["PG_IDLE_TIMEOUT_MS", "-1"],
    ["PG_STATEMENT_TIMEOUT_MS", "-1"],
    ["PG_CONNECTION_TIMEOUT_MS", "1.5"],
    ["PG_POOL_MAX", "lots"],
  ])("rejects %s=%s at boot rather than silently ignoring it", (name, value) => {
    process.env[name] = value;
    expect(() => postgresConnectionOptions()).toThrow(RuntimeConfigError);
  });

  it("still honours the pre-existing pool and TLS variables", () => {
    process.env["PG_POOL_MAX"] = "5";
    process.env["DATABASE_SSL_NO_VERIFY"] = "true";
    expect(postgresConnectionOptions()).toMatchObject({ poolMax: 5, sslNoVerify: true });
  });
});

describe("redisEventBusOptions", () => {
  it("is empty when nothing is configured, so the bus keeps its own defaults", () => {
    expect(redisEventBusOptions()).toEqual({});
  });

  it("accepts a stream MAXLEN of 0 as 'do not trim'", () => {
    process.env["SKEIN_REDIS_STREAM_MAXLEN"] = "0";
    expect(redisEventBusOptions().streamMaxLen).toBe(0);
  });

  it("rejects a zero subscriber buffer, which would drop every frame", () => {
    process.env["SKEIN_STREAM_BUFFER_FRAMES"] = "0";
    expect(() => redisEventBusOptions()).toThrow(RuntimeConfigError);
  });
});
