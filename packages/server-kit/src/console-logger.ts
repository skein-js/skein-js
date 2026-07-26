// `createConsoleLogger` — the opt-in `Logger` for adapters whose framework owns no logger of its own
// (Express, Next.js). Plain, uncolored, `console.*` output.
//
// Deliberately plain: the colored, code-framed failure block belongs to `skein dev`
// (packages/cli/src/dev-logger.ts), which knows the project's source root and can safely read from
// it. A library writing into someone else's stdout should be legible and boring.

import type { Logger } from "@skein-js/agent-protocol";

import { formatLogMeta } from "./log-meta.js";

/** Levels in ascending severity — the order `level` filters against. */
const LEVELS = ["debug", "info", "warn", "error"] as const;

export type ConsoleLogLevel = (typeof LEVELS)[number];

export interface ConsoleLoggerOptions {
  /**
   * Quietest level to emit; anything below it is dropped. Defaults to `"info"`, which covers failed
   * runs, webhook/rollback problems, and the one-line background-run summaries, while leaving
   * `debug` off. `"warn"` suppresses the per-run summaries but never hides a failure.
   */
  level?: ConsoleLogLevel;
  /** Prefix on every line, identifying the output as skein's. Defaults to `"skein"`. */
  prefix?: string;
}

/**
 * A plain console `Logger`. Pass it as an adapter's `logger` to see what skein reports — failed
 * runs (with the stack and `cause` chain), webhook delivery failures, and background-run summaries:
 *
 * ```ts
 * createExpressServer({ config: "./langgraph.json", logger: createConsoleLogger() });
 * ```
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const prefix = options.prefix ?? "skein";
  // Fall back rather than trust `indexOf`: an unrecognized level (a `LOG_LEVEL` env var read by an
  // untyped caller, say) would otherwise yield -1 — a threshold *below* debug, turning an attempt to
  // quiet the logs into the noisiest possible setting.
  const configured = LEVELS.indexOf(options.level ?? "info");
  const threshold = configured === -1 ? LEVELS.indexOf("info") : configured;

  function emit(
    level: ConsoleLogLevel,
    write: (line: string) => void,
  ): (message: string, meta?: unknown) => void {
    // Ranked once per level, not on every call — `level` is fixed for this closure.
    const rank = LEVELS.indexOf(level);
    if (rank < threshold) return () => {};
    return (message, meta) => {
      const rendered = formatLogMeta(meta);
      write(`${prefix} ${level}: ${message}${rendered ? `\n${rendered}` : ""}`);
    };
  }

  return {
    // Bound to `console` rather than passed by reference so a host that swaps `console.log` later
    // (test harnesses do) is still honored at call time.
    debug: emit("debug", (line) => console.debug(line)),
    info: emit("info", (line) => console.log(line)),
    warn: emit("warn", (line) => console.warn(line)),
    error: emit("error", (line) => console.error(line)),
  };
}
