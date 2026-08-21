// Assertions are on plain text: tests run non-TTY, so `colorEnabled` is false and no ANSI codes are
// emitted. That is the mode this block most has to be legible in — it is also every piped log and
// CI run.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GraphResolver, GraphSchemas, Logger, ResolvedGraph } from "@skein-js/agent-protocol";
import { describe, expect, it } from "vitest";

import {
  GRAPH_LOAD_FAILURE_REPORT_KIND,
  graphLoadFailureBlock,
  isGraphLoadFailureReport,
  loadGraphsAndReportFailures,
  type GraphLoadFailureReport,
} from "./graph-load-failure.js";

function report(error: unknown, graphId = "agent"): GraphLoadFailureReport {
  return { kind: GRAPH_LOAD_FAILURE_REPORT_KIND, graphId, error };
}

/** A logger that records `(message, meta)` pairs. */
function recordingLogger() {
  const errors: { message: string; meta: unknown }[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, meta?: unknown) => errors.push({ message, meta }),
  } satisfies Logger;
  return { logger, errors };
}

function resolverOver(graphs: Record<string, () => Promise<ResolvedGraph>>): GraphResolver {
  return {
    ids: Object.keys(graphs),
    load: async (graphId) => {
      const load = graphs[graphId];
      if (!load) throw new Error(`unknown graph "${graphId}"`);
      return load();
    },
    schemas: async (): Promise<GraphSchemas> => ({}) as GraphSchemas,
  };
}

describe("isGraphLoadFailureReport", () => {
  it("recognizes a report by its discriminant, not its shape", () => {
    expect(isGraphLoadFailureReport(report(new Error("boom")))).toBe(true);
    // An ordinary meta object that happens to carry the same fields is not a report.
    expect(isGraphLoadFailureReport({ graphId: "agent", error: new Error("boom") })).toBe(false);
    expect(isGraphLoadFailureReport(new Error("boom"))).toBe(false);
    expect(isGraphLoadFailureReport(null)).toBe(false);
  });
});

describe("graphLoadFailureBlock", () => {
  it("leads with the root cause, not the wrapper that says where", () => {
    // The exact shape `@skein-js/config` rejects with.
    const rendered = graphLoadFailureBlock(
      report(
        new Error('Failed to import graph module "/app/src/agent-graph.ts".', {
          cause: new Error('GOOGLE_API_KEY is not set — the "agent" graph needs it.'),
        }),
      ),
      process.cwd(),
    );

    expect(rendered).toContain("GRAPH FAILED TO LOAD");
    expect(rendered).toContain("graph     agent");
    expect(rendered).toContain('GOOGLE_API_KEY is not set — the "agent" graph needs it.');
    // The chain is still there underneath — the wrapper's "where" is worth keeping.
    expect(rendered).toContain("Failed to import graph module");
  });

  it("draws a code frame on the line the root cause threw, and names it", () => {
    // A real file inside the source root, so the frame can be read. The root cause's stack has to
    // point at it — the wrapper's stack is all skein frames, which is the bug this guards.
    const root = mkdtempSync(path.join(tmpdir(), "skein-frame-"));
    const file = path.join(root, "agent-graph.ts");
    writeFileSync(
      file,
      ["const before = 1;", "throw new Error('no key');", "const after = 2;"].join("\n"),
    );

    const cause = new Error("no key");
    cause.stack = `Error: no key\n    at ${file}:2:7`;
    const wrapper = new Error("Failed to import graph module.", { cause });
    wrapper.stack =
      "Error: Failed to import graph module.\n    at loadGraph (/skein/config.js:42:11)";

    const rendered = graphLoadFailureBlock(report(wrapper), root);

    expect(rendered).toContain("source    agent-graph.ts:2");
    expect(rendered).toContain("> 2 | throw new Error('no key');");
  });

  it("drops the stack once the code frame has pointed at the line", () => {
    const root = mkdtempSync(path.join(tmpdir(), "skein-frame-"));
    const file = path.join(root, "agent-graph.ts");
    writeFileSync(file, "throw new Error('no key');\n");

    const cause = new Error("no key");
    cause.stack = `Error: no key\n    at ${file}:1:7`;
    const rendered = graphLoadFailureBlock(
      report(new Error("Failed to import graph module.", { cause })),
      root,
    );

    // The chain's shape survives; its twenty-five frames do not.
    expect(rendered).toContain("Failed to import graph module.");
    expect(rendered).toContain("caused by: Error: no key");
    expect(rendered).not.toMatch(/^\s+at\s/m);
  });

  it("keeps the stack when there is no frame, since it is the only navigation left", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at somewhere (/opt/app/dist/bundle.js:9:1)";
    const rendered = graphLoadFailureBlock(report(error), "/nowhere-at-all");
    expect(rendered).toContain("at somewhere (/opt/app/dist/bundle.js:9:1)");
  });

  it("omits the source row when no frame could be read", () => {
    const rendered = graphLoadFailureBlock(report(new Error("boom")), "/nowhere-at-all");
    expect(rendered).toContain("graph     agent");
    expect(rendered).not.toContain("source");
  });

  it("renders a non-Error throw without blowing up", () => {
    expect(graphLoadFailureBlock(report("boom"), process.cwd())).toContain("boom");
  });
});

describe("loadGraphsAndReportFailures", () => {
  it("reports each failure and lets the healthy graphs through", async () => {
    const graph = {} as ResolvedGraph;
    const { logger, errors } = recordingLogger();

    await loadGraphsAndReportFailures(
      resolverOver({
        echo: async () => graph,
        agent: () => Promise.reject(new Error("GOOGLE_API_KEY is not set")),
      }),
      logger,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('graph "agent" failed to load');
    expect(isGraphLoadFailureReport(errors[0]?.meta)).toBe(true);
  });

  it("resolves rather than rejecting, so a bad graph never takes the server down", async () => {
    const { logger, errors } = recordingLogger();
    await expect(
      loadGraphsAndReportFailures(
        resolverOver({
          one: () => Promise.reject(new Error("a")),
          two: () => Promise.reject(new Error("b")),
        }),
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(errors).toHaveLength(2);
  });
});
