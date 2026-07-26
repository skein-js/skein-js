// The console logger for `skein dev`: implements the agent-protocol `Logger` interface with colored,
// level-prefixed output (`info:`/`warn:`/`error:`/`debug:`), a compact key=value rendering of
// structured meta, and a prominent block for a failed graph run. All coloring lives here;
// `@skein-js/agent-protocol` and `@skein-js/express` only ever emit plain strings/meta through the
// injected `Logger`, so they stay framework-agnostic. Color disables itself for non-TTY / `NO_COLOR`.

import { isRunFailureReport, type Logger, type RunFailureReport } from "@skein-js/agent-protocol";

import { codeFrameForStack } from "./code-frame.js";
import { bold, cyan, dim, green, red, yellow } from "./colors.js";
import { describeError } from "./describe-error.js";

/** Indent for the meta block and continuation lines — aligns under the level prefix. */
const INDENT = "       ";

/** Indent every line of a block, so multi-line output stays under the level prefix. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `${INDENT}${line}`)
    .join("\n");
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
    const pairs = Object.entries(meta as Record<string, unknown>).map(([key, value]) => {
      const rendered =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return `${dim(`${key}=`)}${rendered}`;
    });
    return pairs.length ? `\n${INDENT}${pairs.join("  ")}` : "";
  }
  return `\n${indent(dim(String(meta)))}`;
}

/** Width of the rules fencing the failure block. Fixed rather than derived from the terminal: dev
 *  output is often piped, and a stable width reads and diffs better than a reflowing one. */
const RULE_WIDTH = 66;
const TITLE = " GRAPH RUN FAILED ";

/** `──────── GRAPH RUN FAILED ────────`, and the plain closing rule. */
function titleRule(): string {
  const dashes = Math.max(0, RULE_WIDTH - TITLE.length);
  const left = "─".repeat(Math.floor(dashes / 2));
  return `${left}${TITLE}${"─".repeat(dashes - left.length)}`;
}

function labelled(label: string, value: string): string {
  return `${dim(label.padEnd(10))}${value}`;
}

/**
 * The failed-run block. Deliberately fenced by *text* rules and blank lines rather than color alone:
 * `colorEnabled` is false for every piped log, CI run, and test, and a crash needs to stand out from
 * the surrounding request lines precisely there. Degrades to the same layout in plain text.
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

  const sections = [rows.join("\n")];
  const frame = codeFrameForStack(report.error, sourceRoot);
  if (frame) sections.push(dim(frame));
  sections.push(dim(describeError(report.error)));

  return [
    "",
    indent(red(titleRule())),
    // A blank line between sections: identity, the offending source, then the trace.
    sections.map((section) => indent(section)).join(`\n${INDENT}\n`),
    indent(red("─".repeat(RULE_WIDTH))),
    "",
  ].join("\n");
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
