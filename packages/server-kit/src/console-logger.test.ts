// The opt-in logger for Express/Next.js. The level filter is the part worth pinning: it must be able
// to quiet the steady-state per-run summaries without ever hiding a failure.

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleLogger } from "./console-logger.js";

/** Capture what reaches `console`, without letting it print into the test output. */
function captureConsole(): { lines: string[] } {
  const lines: string[] = [];
  const record =
    () =>
    (line: string): void => {
      lines.push(line);
    };
  vi.spyOn(console, "debug").mockImplementation(record());
  vi.spyOn(console, "log").mockImplementation(record());
  vi.spyOn(console, "warn").mockImplementation(record());
  vi.spyOn(console, "error").mockImplementation(record());
  return { lines };
}

describe("createConsoleLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("labels each line with the level and a prefix", () => {
    const captured = captureConsole();
    createConsoleLogger().warn("something odd");
    expect(captured.lines).toEqual(["skein warn: something odd"]);
  });

  it("honors a custom prefix", () => {
    const captured = captureConsole();
    createConsoleLogger({ prefix: "graphs" }).error("boom");
    expect(captured.lines).toEqual(["graphs error: boom"]);
  });

  it("drops debug by default but keeps info", () => {
    const captured = captureConsole();
    const logger = createConsoleLogger();
    logger.debug("noisy");
    logger.info("useful");
    expect(captured.lines).toEqual(["skein info: useful"]);
  });

  it("emits debug once the level asks for it", () => {
    const captured = captureConsole();
    createConsoleLogger({ level: "debug" }).debug("noisy");
    expect(captured.lines).toEqual(["skein debug: noisy"]);
  });

  it("still reports failures at the quietest level", () => {
    const captured = captureConsole();
    const logger = createConsoleLogger({ level: "error" });
    logger.info("run finished");
    logger.warn("webhook failed");
    logger.error("Graph run failed");
    expect(captured.lines).toEqual(["skein error: Graph run failed"]);
  });

  it("appends an error's stack and cause below the message", () => {
    const captured = captureConsole();
    createConsoleLogger().error("boom", new Error("outer", { cause: new Error("root cause") }));
    expect(captured.lines[0]).toContain("skein error: boom");
    expect(captured.lines[0]).toContain("root cause");
  });

  it("falls back to info on an unrecognized level rather than emitting everything", () => {
    const captured = captureConsole();
    // What an untyped caller reading `process.env.LOG_LEVEL` can produce. Failing open here would
    // turn an attempt to quiet the logs into the noisiest possible setting.
    const logger = createConsoleLogger({ level: "verbose" as never });
    logger.debug("noisy");
    logger.info("useful");
    expect(captured.lines).toEqual(["skein info: useful"]);
  });

  it("routes each level to its own console method", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createConsoleLogger({ level: "debug" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(debug).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
