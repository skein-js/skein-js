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
});
