import type { Logger } from "@skein-js/agent-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { printBanner } from "./banner.js";

/** Collects the status lines; the decorative header goes to `console.log`, which we silence. */
function capturingLogger(): Logger & { infos: string[] } {
  const infos: string[] = [];
  return {
    infos,
    debug: () => {},
    info: (message) => infos.push(message),
    warn: () => {},
    error: () => {},
  };
}

function bannerLines(runConcurrency: number, authPath?: string): string[] {
  const logger = capturingLogger();
  vi.spyOn(console, "log").mockImplementation(() => {});
  printBanner(
    {
      host: "127.0.0.1",
      port: 2024,
      graphIds: ["agent"],
      runConcurrency,
      ...(authPath ? { authPath } : {}),
    },
    logger,
  );
  return logger.infos;
}

/** The decorative header lines, which go to `console.log` rather than the logger. */
function headerLines(): string[] {
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.join(" "));
  });
  printBanner({ host: "127.0.0.1", port: 2024, graphIds: ["agent"], runConcurrency: 1 }, logger());
  return printed;
}

function logger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

describe("printBanner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints 'Starting 1 worker' at a concurrency of 1", () => {
    expect(bannerLines(1)).toContain("Starting 1 worker");
  });

  it("says how many runs the single worker takes at once above 1", () => {
    expect(bannerLines(10)).toContain("Starting 1 worker, up to 10 concurrent runs");
  });

  it("still registers each graph, the auth path, and the address", () => {
    expect(bannerLines(4, "./src/auth.ts:auth")).toEqual([
      "Registering graph with id 'agent'",
      "Loading auth from ./src/auth.ts:auth",
      "Starting 1 worker, up to 4 concurrent runs",
      "Server running at http://127.0.0.1:2024",
    ]);
  });

  it("prints the served API URL", () => {
    expect(headerLines().join("\n")).toContain("http://127.0.0.1:2024");
  });

  // skein serves no OpenAPI page, so a `${base}/docs` URL in the banner would 404 on the first
  // thing a new user clicks. The Docs line must point at the real docs instead.
  it("never advertises a local /docs route the server does not serve", () => {
    const header = headerLines().join("\n");
    expect(header).not.toContain("http://127.0.0.1:2024/docs");
    expect(header).toContain("https://github.com/skein-js/skein-js/tree/main/docs");
  });
});
