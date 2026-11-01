import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createProtocolHandlers, type ProtocolRequest } from "../create-handlers.js";
import { createProtocolRuntime } from "../runtime.js";

import { runSearchSchema } from "./run-search-schema.js";

const request: ProtocolRequest = {
  method: "POST",
  url: "http://localhost/runs/search",
  params: {},
  query: {},
  headers: {},
  body: {},
};
describe("run search boundary", () => {
  it("normalizes offsets, defaults pagination, and discards client ownership constraints", () => {
    expect(
      runSearchSchema.parse({
        created_after: "2026-11-01T03:00:00+03:00",
        enforcedMetadata: { owner: "bob" },
      }),
    ).toEqual({ created_after: "2026-11-01T00:00:00.000Z", limit: 100, offset: 0 });
  });
  it.each([
    { status: "failed" },
    { assistant_id: "" },
    { thread_id: "" },
    { created_after: "yesterday" },
    { updated_before: "2026-02-30T00:00:00Z" },
    { limit: 0 },
    { limit: 1001 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 0.5 },
    { created_after: "2026-11-02T00:00:00Z", created_before: "2026-11-01T00:00:00Z" },
    { updated_after: "2026-11-02T00:00:00Z", updated_before: "2026-11-01T00:00:00Z" },
  ])("rejects malformed or inverted filters: %j", async (body) => {
    const runtime = createProtocolRuntime(createFixtureDeps());
    await expect(runtime.handlers.searchRuns!({ ...request, body })).rejects.toMatchObject({
      status: 400,
    });
  });
  it("accepts equal half-open boundaries as an empty window", async () => {
    const runtime = createProtocolRuntime(createFixtureDeps());
    expect(
      await runtime.handlers.searchRuns!({
        ...request,
        body: { created_after: "2026-11-01T00:00:00Z", created_before: "2026-11-01T00:00:00Z" },
      }),
    ).toMatchObject({ kind: "json", status: 200, body: [] });
  });
  it("returns 501 for legacy stores and services without search", async () => {
    const deps = createFixtureDeps();
    const { search: _search, ...runs } = deps.store.runs;
    const runtime = createProtocolRuntime({ ...deps, store: { ...deps.store, runs } });
    await expect(runtime.handlers.searchRuns!(request)).rejects.toMatchObject({ status: 501 });
    const handlers = createProtocolHandlers({
      ...runtime.service,
      runs: { ...runtime.service.runs, search: undefined },
    });
    await expect(handlers.searchRuns!(request)).rejects.toMatchObject({ status: 501 });
  });
});
