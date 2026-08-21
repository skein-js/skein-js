// The console logger for `skein dev`: implements the agent-protocol `Logger` interface with colored,
// level-prefixed output (`info:`/`warn:`/`error:`/`debug:`), a compact key=value rendering of
// structured meta, and a prominent block for each of the two ways a graph fails — one that crashed
// mid-run, and one that could not be loaded at all. All coloring lives here;
// `@skein-js/agent-protocol` and `@skein-js/express` only ever emit plain strings/meta through the
// injected `Logger`, so they stay framework-agnostic. Color disables itself for non-TTY / `NO_COLOR`.

import { isRunFailureReport, type Logger, type RunFailureReport } from "@skein-js/agent-protocol";
import { describeError } from "@skein-js/server-kit";

import { codeFrameForStack } from "./code-frame.js";
import { bold, cyan, dim, green, red, yellow } from "./colors.js";
import { fencedBlock, indent, INDENT, labelled } from "./failure-block.js";
import { graphLoadFailureBlock, isGraphLoadFailureReport } from "./graph-load-failure.js";

/** `String()` that never throws — a null-prototype object has no `toPrimitive` to convert through. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** `JSON.stringify` that never throws — meta is `unknown` and may hold cycles or hostile getters. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? safeString(value);
  } catch {
    return safeString(value);
  }
}

/** Render structured meta under the message line: an `Error` as its stack + cause chain, an object
 * as a compact `key=value` block, anything else stringified. Returns "" when there's nothing. */
function metaBlock(meta: unknown): string {
  if (meta === undefined || meta === null) return "";
  if (meta instanceof Error) {
    // Prefer the stack (it includes the message) and follow the `cause` chain, so a wrapped error
    // (e.g. a config error whose `cause` is the real import failure) doesn't lose its origin.
    return `\n${indent(dim(describeError(meta)))}`;
  }
  if (typeof meta === "object") {
    // Reading the entries is guarded because `Object.entries` *invokes getters*, and rendering is
    // guarded because a cyclic value defeats `JSON.stringify` — either would throw out of a logger
    // that is, by then, reporting a crash. Kept local rather than delegated to server-kit's
    // `formatLogMeta`: this block is colored and two-space-aligned, and matching that exactly is
    // more coupling than the shared line is worth.
    let entries: [string, unknown][];
    try {
      entries = Object.entries(meta as Record<string, unknown>);
    } catch {
      return `\n${indent(dim(safeString(meta)))}`;
    }
    const pairs = entries.map(([key, value]) => {
      const rendered =
        typeof value === "object" && value !== null ? safeStringify(value) : safeString(value);
      return `${dim(`${key}=`)}${rendered}`;
    });
    return pairs.length ? `\n${INDENT}${pairs.join("  ")}` : "";
  }
  return `\n${indent(dim(String(meta)))}`;
}

/**
 * The failed-run block: identity, the offending source, then the trace — one section per blank line.
 * Its chrome (rules, indent, label column) is `failure-block.ts`, shared with the failed-*load*
 * block so the two ways a graph fails look like siblings.
 */
function runFailureBlock(report: RunFailureReport, sourceRoot: string): string {
  const rows = [
    labelled("run", report.runId),
    labelled("assistant", report.assistantId),
    labelled("thread", report.threadId),
  ];
  // Omitted entirely when LangGraph gave us nothing — no `unknown` placeholder, no guess.
  if (report.failingNodes.length > 0) {
    rows.push(labelled("node", report.failingNodes.join(", ")));
  }

  const frame = codeFrameForStack(report.error, sourceRoot);
  return fencedBlock("GRAPH RUN FAILED", [
    rows.join("\n"),
    frame ? dim(frame) : "",
    dim(describeError(report.error)),
  ]);
}

/** Colorize the request-log arrows the Express request logger emits: `<-- …` dim, `--> … <status>`
 * colored by status class (2xx green, 3xx cyan, 4xx yellow, 5xx red). Other messages pass through. */
function paintHttp(message: string): string {
  if (message.startsWith("<-- ")) return dim(message);
  if (message.startsWith("--> ")) {
    const status = Number(message.match(/ (\d{3}) \d+ms$/)?.[1]);
    if (status >= 500) return red(message);
    if (status >= 400) return yellow(message);
    if (status >= 300) return cyan(message);
    return green(message);
  }
  return message;
}

/** Assemble a full log line: colored `level:` prefix, message, and any meta block. */
function line(prefix: string, message: string, sourceRoot: string, meta?: unknown): string {
  if (isRunFailureReport(meta)) {
    return `${prefix} ${bold(message)}\n${runFailureBlock(meta, sourceRoot)}`;
  }
  if (isGraphLoadFailureReport(meta)) {
    return `${prefix} ${bold(message)}\n${graphLoadFailureBlock(meta, sourceRoot)}`;
  }
  return `${prefix} ${paintHttp(message)}${metaBlock(meta)}`;
}

export interface DevLoggerOptions {
  /**
   * Root directory the failed-run code frame may read source from. A code frame is only ever useful
   * for the user's own source, and bounding it keeps an attacker-influenced error message from
   * steering a file read (see code-frame.ts). Defaults to the working directory; the CLI passes the
   * project — or, under `skein dev`, the workspace — root.
   */
  sourceRoot?: string;
}

/**
 * A colored, level-prefixed console logger for the skein CLI, implementing the agent-protocol
 * `Logger`. Structured meta (the background-run summary) renders as an indented key=value block, and
 * a failed graph run gets a fenced block with a code frame pointing at the line that threw.
 */
export function createDevLogger(options: DevLoggerOptions = {}): Logger {
  const sourceRoot = options.sourceRoot ?? process.cwd();
  return {
    debug: (message, meta) => console.debug(line(dim("debug:"), message, sourceRoot, meta)),
    info: (message, meta) => console.log(line(green("info:"), message, sourceRoot, meta)),
    warn: (message, meta) => console.warn(line(yellow("warn:"), message, sourceRoot, meta)),
    error: (message, meta) => console.error(line(red("error:"), message, sourceRoot, meta)),
  };
}
