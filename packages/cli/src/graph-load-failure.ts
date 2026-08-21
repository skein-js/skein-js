// A graph that could not be loaded at all — the sibling of `RunFailureReport`, which covers a graph
// that loaded and then crashed.
//
// This is the failure a fresh project hits first, and almost always for one reason: the graph builds
// a model client at module scope and the API key is not set. Before this it was reported as
// `Failed to warm graph "agent"` plus two full stacks, logged *above* the banner (so the banner
// scrolled it away) and then again on every request that touched the graph. The variable name was in
// there, fifteen lines down, under `caused by:`.
//
// So: one fenced block, the root cause's own sentence as the headline, and a code frame on the line
// that threw. The chain is still printed underneath — a wrapped error's *location* ("failed to
// import .../agent-graph.ts") is worth keeping — but stripped of its frames once the frame above has
// already pointed at the line.

import path from "node:path";

import type { GraphResolver, Logger } from "@skein-js/agent-protocol";
import { rootCause, rootCauseMessage } from "@skein-js/core";
import { describeError } from "@skein-js/server-kit";

import { codeFrameForStack, userFrameForStack } from "./code-frame.js";
import { bold, dim } from "./colors.js";
import { fencedBlock, labelled } from "./failure-block.js";

/** Discriminant, so a logger recognizes a load failure without guessing at structure. Mirrors
 *  `RUN_FAILURE_REPORT_KIND`, which is the same arrangement for the other kind of graph failure. */
export const GRAPH_LOAD_FAILURE_REPORT_KIND = "skein.graph-load-failure";

/**
 * Structured meta for a graph that failed to load, passed to the logger so the dev logger can render
 * a block while a JSON logger can serialize the fields. Unlike `RunFailureReport` this one stays in
 * the CLI: the CLI is the only thing that produces it.
 */
export interface GraphLoadFailureReport {
  readonly kind: typeof GRAPH_LOAD_FAILURE_REPORT_KIND;
  /** The graph id from `langgraph.json` that could not be loaded. */
  readonly graphId: string;
  /** Whatever the resolver rejected with — typically a `SkeinConfigError` wrapping the real cause. */
  readonly error: unknown;
}

/** Narrow a logger's `meta` to a {@link GraphLoadFailureReport}. */
export function isGraphLoadFailureReport(meta: unknown): meta is GraphLoadFailureReport {
  return (
    typeof meta === "object" &&
    meta !== null &&
    (meta as { kind?: unknown }).kind === GRAPH_LOAD_FAILURE_REPORT_KIND
  );
}

/**
 * `describeError` with the stack frames dropped — every line except `    at …`.
 *
 * Used when a code frame was produced, which is the case that made the old report unreadable: the
 * frame already points at the exact line, so the twenty-five frames underneath it are noise. What is
 * still worth keeping is the chain's *shape* — `SkeinConfigError: Failed to import graph module
 * "…/agent-graph.ts"` says where, and that is one line. Without a frame the stack is the only
 * navigation aid there is, so it stays.
 */
function withoutStackFrames(described: string): string {
  return described
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n");
}

/**
 * The fenced block for a failed graph load: the graph and the source line, a code frame, the root
 * cause's message, then the `cause` chain.
 *
 * `sourceRoot` bounds which files may be read for the frame (see code-frame.ts). The `source` row is
 * emitted only when a frame was actually produced, which is also what proves the file sits inside
 * that root — an error message is frequently attacker-influenced, and neither the excerpt nor the
 * path should escape the project.
 */
export function graphLoadFailureBlock(report: GraphLoadFailureReport, sourceRoot: string): string {
  // The frame belongs to the *root* cause, not the wrapper: a `SkeinConfigError`'s own stack is
  // nothing but skein frames, so `findUserFrame` would come back empty and the one thing worth
  // pointing at — the line in the user's graph — would be lost.
  const root = rootCause(report.error);
  const frame = root instanceof Error ? codeFrameForStack(root, sourceRoot) : undefined;
  const location = root instanceof Error ? userFrameForStack(root) : undefined;

  const rows = [labelled("graph", report.graphId)];
  if (frame && location) {
    rows.push(labelled("source", `${path.relative(sourceRoot, location.file)}:${location.line}`));
  }

  const described = describeError(report.error);
  return fencedBlock("GRAPH FAILED TO LOAD", [
    rows.join("\n"),
    frame ? dim(frame) : "",
    bold(rootCauseMessage(report.error)),
    dim(frame ? withoutStackFrames(described) : described),
  ]);
}

/**
 * Import every declared graph, reporting each failure as a {@link GraphLoadFailureReport} and
 * carrying on.
 *
 * This is the eager load `SkeinRuntimeCommonOptions.warm` performs, moved into the CLI so it happens
 * *after* the banner is printed. Under `warm` it ran during `createExpressServer`, which put the one
 * message that mattered above thirty lines of banner. One bad graph never takes the server down —
 * the others still serve, which is the whole point of a scaffold shipping a keyless `echo` alongside
 * a model-backed `agent`.
 */
export async function loadGraphsAndReportFailures(
  graphs: GraphResolver,
  logger: Logger,
): Promise<void> {
  await Promise.all(
    graphs.ids.map(async (graphId) => {
      try {
        await graphs.load(graphId);
      } catch (error) {
        logger.error(`graph "${graphId}" failed to load`, {
          kind: GRAPH_LOAD_FAILURE_REPORT_KIND,
          graphId,
          error,
        });
      }
    }),
  );
}
