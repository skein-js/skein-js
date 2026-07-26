// The structured `meta` the engine attaches to the always-on "a graph run failed" log line.
//
// The `Logger` interface is deliberately tiny — `error(message, meta?)` — and this package must stay
// framework-agnostic: it knows nothing about consoles, colors, or terminals. But a console logger
// (the CLI's) wants to render a graph failure far more prominently than a one-line message allows,
// and it needs the run's identity plus the original `Error` to do it.
//
// So the engine emits plain data with a discriminant, and a logger that recognizes the discriminant
// can render whatever it likes. A logger that doesn't simply sees an object and formats it however
// it formats objects — nothing breaks.

import type { RunError } from "@skein-js/core";

/** Discriminant, so a logger can recognize a run failure without guessing at structure. */
export const RUN_FAILURE_REPORT_KIND = "skein.run-failure";

/** Everything a logger needs to report a failed graph run. Attached as the `meta` of `logger.error`. */
export interface RunFailureReport {
  readonly kind: typeof RUN_FAILURE_REPORT_KIND;
  readonly runId: string;
  readonly threadId: string;
  readonly assistantId: string;
  /**
   * The node(s) LangGraph was in when it threw. Empty when it could not be identified — see
   * `describeFailingNodes`; a renderer should omit the field rather than print a placeholder.
   */
  readonly failingNodes: readonly string[];
  /**
   * The thrown value as an `Error`, so a renderer can reach its stack and `cause` chain. A non-Error
   * throw is wrapped, so this is always a real `Error`.
   */
  readonly error: Error;
  /** The JSON-safe payload also published on the `error` frame and persisted on the run row. */
  readonly wireError: RunError;
}

/** Narrow a logger's `meta` to a {@link RunFailureReport}. */
export function isRunFailureReport(meta: unknown): meta is RunFailureReport {
  return (
    typeof meta === "object" &&
    meta !== null &&
    (meta as { kind?: unknown }).kind === RUN_FAILURE_REPORT_KIND
  );
}

/** Wrap a thrown value as an `Error`, so a report always carries one. */
export function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}
