// The console logger for `skein dev`: implements the agent-protocol `Logger` interface with colored,
// level-prefixed output (`info:`/`warn:`/`error:`/`debug:`) and a compact key=value rendering of
// structured meta — the background-run lifecycle summary the worker emits. All coloring lives here;
// `@skein-js/agent-protocol` and `@skein-js/express` only ever emit plain strings/meta through the
// injected `Logger`, so they stay framework-agnostic. Color disables itself for non-TTY / `NO_COLOR`.

import type { Logger } from "@skein-js/agent-protocol";

import { cyan, dim, green, red, yellow } from "./colors.js";

/** Indent for the meta block and continuation lines — aligns under the level prefix. */
const INDENT = "       ";

/** An error's stack (falling back to its message), with any `cause` chain appended. */
function describeError(error: Error): string {
  const head = error.stack ?? `${error.name}: ${error.message}`;
  if (error.cause === undefined) return head;
  const cause = error.cause instanceof Error ? describeError(error.cause) : String(error.cause);
  return `${head}\ncaused by: ${cause}`;
}

/** Render structured meta under the message line: an `Error` as its stack + cause chain, an object
 * as a compact `key=value` block, anything else stringified. Returns "" when there's nothing. */
function metaBlock(meta: unknown): string {
  if (meta === undefined || meta === null) return "";
  if (meta instanceof Error) {
    // Prefer the stack (it includes the message) and follow the `cause` chain, so a wrapped error
    // (e.g. a config error whose `cause` is the real import failure) doesn't lose its origin. Each
    // line is indented under the level prefix.
    const trace = describeError(meta);
    return `\n${INDENT}${dim(trace.replace(/\n/g, `\n${INDENT}`))}`;
  }
  if (typeof meta === "object") {
    const pairs = Object.entries(meta as Record<string, unknown>).map(([key, value]) => {
      const rendered =
        typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return `${dim(`${key}=`)}${rendered}`;
    });
    return pairs.length ? `\n${INDENT}${pairs.join("  ")}` : "";
  }
  return `\n${INDENT}${dim(String(meta))}`;
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
function line(prefix: string, message: string, meta?: unknown): string {
  return `${prefix} ${paintHttp(message)}${metaBlock(meta)}`;
}

/**
 * A colored, level-prefixed console logger for `skein dev`, implementing the agent-protocol
 * `Logger`. Structured meta (the background-run summary) renders as an indented key=value block.
 */
export function createDevLogger(): Logger {
  return {
    debug: (message, meta) => console.debug(line(dim("debug:"), message, meta)),
    info: (message, meta) => console.log(line(green("info:"), message, meta)),
    warn: (message, meta) => console.warn(line(yellow("warn:"), message, meta)),
    error: (message, meta) => console.error(line(red("error:"), message, meta)),
  };
}
