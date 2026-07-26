// Turn a `Logger` call's `meta` argument into plain text. Every logger that writes *lines* rather
// than structured records needs this — `createConsoleLogger` here, and the NestJS bridge, whose
// target takes a message string. The Fastify bridge deliberately does NOT use it: pino is
// object-first, so handing it a pre-flattened string would throw away the structure that makes the
// record queryable.
//
// The engine's `meta` is one of three things in practice: a `RunFailureReport` (a failed run), an
// `Error` (webhook/rollback/telemetry failures), or a flat record (the background-run summary). Each
// gets the rendering that keeps the part a reader actually needs.

import { isRunFailureReport, type RunFailureReport } from "@skein-js/agent-protocol";

import { describeError } from "./describe-error.js";

/**
 * The `run=… thread=… assistant=… node=…` row identifying a failed run. Exported so the framework
 * bridges, which place the stack in their own logger's dedicated slot rather than appending it to
 * the message, still render identity identically — adding a field is then one edit, not three.
 */
export function runFailureIdentity(report: RunFailureReport): string {
  return [
    `run=${report.runId}`,
    `thread=${report.threadId}`,
    `assistant=${report.assistantId}`,
    // Omitted entirely when LangGraph named no node — no `unknown` placeholder, no guess.
    ...(report.failingNodes.length > 0 ? [`node=${report.failingNodes.join(",")}`] : []),
  ].join(" ");
}

/** `String()` that never throws — a null-prototype object has no `toPrimitive` to convert through. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** `JSON.stringify` that never throws — `meta` is `unknown` and may hold cycles or a throwing getter. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? safeString(value);
  } catch {
    return safeString(value);
  }
}

/**
 * A flat record as `key=value key=value`, nesting stringified. Mirrors the CLI dev logger's block.
 *
 * Reading the entries is itself guarded: `Object.entries` *invokes getters*, so a single hostile or
 * lazily-throwing property would otherwise take down the whole log line — on the failure path, where
 * losing the line loses the only account of what went wrong.
 */
function renderRecord(meta: object): string {
  let entries: [string, unknown][];
  try {
    entries = Object.entries(meta as Record<string, unknown>);
  } catch {
    return safeString(meta);
  }
  return entries
    .map(([key, value]) => {
      const rendered =
        typeof value === "object" && value !== null ? safeStringify(value) : safeString(value);
      return `${key}=${rendered}`;
    })
    .join(" ");
}

/**
 * Render structured log meta as plain text. Returns `""` when there is nothing to add, so callers can
 * append unconditionally.
 *
 * A `RunFailureReport` renders as its identity row plus the error's stack and `cause` chain — the
 * failure's *whole* story, since this is the one surface guaranteed to receive it (the wire gets only
 * what is safe to hand a caller).
 */
export function formatLogMeta(meta: unknown): string {
  if (meta === undefined || meta === null) return "";
  if (isRunFailureReport(meta)) return `${runFailureIdentity(meta)}\n${describeError(meta.error)}`;
  if (meta instanceof Error) return describeError(meta);
  if (typeof meta === "object") return renderRecord(meta);
  return safeString(meta);
}
