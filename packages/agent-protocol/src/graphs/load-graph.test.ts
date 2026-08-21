import { isSkeinHttpError, SkeinHttpError } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import type { GraphResolver, GraphSchemas, ResolvedGraph } from "../deps.js";

import { loadGraphOrThrow } from "./load-graph.js";

/** A resolver whose `load` does whatever the test needs. */
function resolverThat(load: GraphResolver["load"]): GraphResolver {
  return {
    ids: ["agent"],
    load,
    schemas: async (): Promise<GraphSchemas> => ({}) as GraphSchemas,
  };
}

const graph = { invoke: () => undefined } as unknown as ResolvedGraph;

describe("loadGraphOrThrow", () => {
  it("returns the resolved graph unchanged when the load succeeds", async () => {
    const resolver = resolverThat(async () => graph);
    await expect(loadGraphOrThrow(resolver, "agent")).resolves.toBe(graph);
  });

  it("names the graph and the root cause, not the wrapper", async () => {
    // The exact shape `@skein-js/config` rejects with: a wrapper saying *where*, whose cause says
    // *what*. Reporting the wrapper is what left a caller reading "Failed to import graph module".
    const configError = new Error('Failed to import graph module "/app/src/agent-graph.ts".', {
      cause: new Error('GOOGLE_API_KEY is not set — the "agent" graph needs it.'),
    });
    const resolver = resolverThat(async () => {
      throw configError;
    });

    const thrown = await loadGraphOrThrow(resolver, "agent", true).catch((error: unknown) => error);

    expect(isSkeinHttpError(thrown)).toBe(true);
    const httpError = thrown as SkeinHttpError;
    expect(httpError.status).toBe(500);
    expect(httpError.code).toBe("graph_load_failed");
    expect(httpError.message).toBe(
      'Graph "agent" failed to load: GOOGLE_API_KEY is not set — the "agent" graph needs it.',
    );
    // The whole chain is still reachable for a logger.
    expect(httpError.cause).toBe(configError);
  });

  it("carries no stack into the message", async () => {
    const resolver = resolverThat(async () => {
      throw new Error("boom");
    });
    const thrown = (await loadGraphOrThrow(resolver, "agent", true).catch(
      (error: unknown) => error,
    )) as SkeinHttpError;
    expect(thrown.message).not.toContain("at ");
  });

  // The production default. A load failure's message is not ours: `Cannot find module
  // '/srv/app/dist/tools.js'` and `connect ECONNREFUSED 10.0.3.14:5432` are both ordinary ones, and
  // neither belongs on the wire. Same line `exposeErrorStacks` already draws for stacks.
  it("withholds the reason by default, keeping the chain for the log", async () => {
    const cause = new Error("Failed to import graph module.", {
      cause: new Error("connect ECONNREFUSED 10.0.3.14:5432"),
    });
    const resolver = resolverThat(async () => {
      throw cause;
    });

    const thrown = (await loadGraphOrThrow(resolver, "agent").catch(
      (error: unknown) => error,
    )) as SkeinHttpError;

    expect(thrown.message).toBe('Graph "agent" failed to load.');
    expect(thrown.message).not.toContain("10.0.3.14");
    expect(thrown.status).toBe(500);
    expect(thrown.code).toBe("graph_load_failed");
    // Withheld from the caller, never from the operator.
    expect(thrown.cause).toBe(cause);
  });

  it("passes a SkeinHttpError through, so an unknown id stays a 4xx", async () => {
    const notFound = SkeinHttpError.notFound('Unknown graph "nope".');
    const resolver = resolverThat(async () => {
      throw notFound;
    });
    await expect(loadGraphOrThrow(resolver, "nope")).rejects.toBe(notFound);
    await expect(loadGraphOrThrow(resolver, "nope", true)).rejects.toBe(notFound);
  });
});
