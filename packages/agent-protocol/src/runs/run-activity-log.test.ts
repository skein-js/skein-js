// The engine emits per-run activity logs only when `logRunActivity` is on, through the injected
// logger. Uses the deterministic `echo` fixture graph (no tool calls), so this pins the lifecycle
// logging + the flag gate; tool-call/interrupt extraction is unit-tested in run-log.test.ts.

import type { Logger } from "@skein-js/agent-protocol";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolServiceFromContext } from "../service.js";

/** A logger that records every info/error line for assertions. */
function capturingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    debug: (message) => lines.push(message),
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

async function runEcho(deps = createFixtureDeps()) {
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  await service.runs.createWait({ assistant_id: "echo", input: { value: "hi" } });
}

describe("run activity logging", () => {
  it("logs start and finish when logRunActivity is enabled", async () => {
    const logger = capturingLogger();
    await runEcho(createFixtureDeps({ logger, logRunActivity: true }));

    expect(logger.lines.some((line) => /^run .* started/.test(line))).toBe(true);
    expect(logger.lines.some((line) => /^run .* success in \d+ms \(\d+ frames\)$/.test(line))).toBe(
      true,
    );
  });

  it("stays silent when logRunActivity is off", async () => {
    const logger = capturingLogger();
    await runEcho(createFixtureDeps({ logger }));
    expect(logger.lines.filter((line) => line.startsWith("run "))).toEqual([]);
  });
});
