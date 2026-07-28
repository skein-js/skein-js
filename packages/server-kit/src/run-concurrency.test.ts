import { DEFAULT_RUN_CONCURRENCY } from "@skein-js/agent-protocol";
import { SkeinConfigError } from "@skein-js/config";
import { describe, expect, it } from "vitest";

import { describePoolPressure, resolveRunConcurrency } from "./run-concurrency.js";

describe("resolveRunConcurrency", () => {
  it("defaults to the LangGraph-matching default when nothing is configured", () => {
    expect(resolveRunConcurrency(undefined, {})).toBe(DEFAULT_RUN_CONCURRENCY);
    expect(DEFAULT_RUN_CONCURRENCY).toBe(10);
  });

  it("reads SKEIN_RUN_CONCURRENCY", () => {
    expect(resolveRunConcurrency(undefined, { SKEIN_RUN_CONCURRENCY: "4" })).toBe(4);
  });

  it("falls back to N_JOBS_PER_WORKER when SKEIN_RUN_CONCURRENCY is unset", () => {
    expect(resolveRunConcurrency(undefined, { N_JOBS_PER_WORKER: "6" })).toBe(6);
  });

  it("prefers SKEIN_RUN_CONCURRENCY over N_JOBS_PER_WORKER when both are set", () => {
    const env = { SKEIN_RUN_CONCURRENCY: "4", N_JOBS_PER_WORKER: "6" };
    expect(resolveRunConcurrency(undefined, env)).toBe(4);
  });

  it("treats a blank env value as unset", () => {
    const env = { SKEIN_RUN_CONCURRENCY: "   ", N_JOBS_PER_WORKER: "3" };
    expect(resolveRunConcurrency(undefined, env)).toBe(3);
    expect(resolveRunConcurrency(undefined, { SKEIN_RUN_CONCURRENCY: "" })).toBe(
      DEFAULT_RUN_CONCURRENCY,
    );
  });

  it("lets an explicit option win over the environment", () => {
    expect(resolveRunConcurrency(2, { SKEIN_RUN_CONCURRENCY: "8" })).toBe(2);
  });

  // The non-obvious rule: both sources must agree, so a typo in a deployment's environment can't hide
  // behind an explicit option that happens to be set.
  it("still rejects an invalid env value when an explicit option is given", () => {
    expect(() => resolveRunConcurrency(2, { SKEIN_RUN_CONCURRENCY: "zero" })).toThrow(
      SkeinConfigError,
    );
  });

  it.each(["0", "-1", "1.5", "zero"])("rejects SKEIN_RUN_CONCURRENCY=%s", (raw) => {
    expect(() => resolveRunConcurrency(undefined, { SKEIN_RUN_CONCURRENCY: raw })).toThrow(
      SkeinConfigError,
    );
  });

  it("names the offending variable in the error", () => {
    expect(() => resolveRunConcurrency(undefined, { N_JOBS_PER_WORKER: "0" })).toThrow(
      /N_JOBS_PER_WORKER must be a positive integer \(got "0"\)/,
    );
  });

  it.each([0, -1, 1.5])("rejects an explicit maxConcurrency of %s", (explicit) => {
    expect(() => resolveRunConcurrency(explicit, {})).toThrow(/worker\.maxConcurrency/);
  });
});

// The failure this warns about is invisible in logs: runs queue on the Postgres pool rather than on
// the run queue, so throughput flattens and nothing points at the pool.
describe("describePoolPressure", () => {
  it("is quiet when the pool can serve every concurrent run", () => {
    expect(describePoolPressure(10, 10)).toBeUndefined();
    expect(describePoolPressure(4, 20)).toBeUndefined();
  });

  it("warns when concurrency outgrows an explicit PG_POOL_MAX, naming both numbers", () => {
    const warning = describePoolPressure(20, 5);

    expect(warning).toContain("20");
    expect(warning).toContain("5");
    expect(warning).toContain("PG_POOL_MAX");
  });

  // The case a deployment falls into without touching anything: `PG_POOL_MAX` unset leaves `pg`'s
  // default of 10, which a raised `SKEIN_RUN_CONCURRENCY` then silently outgrows.
  it("assumes pg's default when PG_POOL_MAX is unset, and says so", () => {
    expect(describePoolPressure(10, undefined)).toBeUndefined();

    const warning = describePoolPressure(11, undefined);
    expect(warning).toContain("pg's default of 10");
  });

  // skein opens two pools per instance (store + checkpointer), which is the number that actually has
  // to fit a managed database's connection cap.
  it("budgets for both pools in its advice", () => {
    expect(describePoolPressure(20, 5)).toContain("40 connections");
  });
});
