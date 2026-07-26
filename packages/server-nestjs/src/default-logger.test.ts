// The behavior this whole seam exists for: a graph throws inside an embedded skein, and the host's
// own NestJS logger reports it — with nobody having configured anything.
//
// Before the adapter's `logger` option reached `ProtocolDeps`, `SkeinModule.forRoot({ deps })` ran the
// engine on a no-op logger, so a crashed graph was visible only to whoever happened to be reading the
// HTTP response. These drive a real Nest app over a real socket, because the failure has to survive
// the whole path — DI wiring, the run engine, the background worker — not just a unit boundary.

import "reflect-metadata";

import type { AddressInfo } from "node:net";

import {
  Logger as NestLoggerClass,
  Module,
  type INestApplication,
  type LoggerService,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { resolveProtocolRuntime } from "@skein-js/server-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEchoDeps } from "./__fixtures__/echo-server.js";
import { SkeinModule } from "./skein.module.js";
import { SKEIN_CORS } from "./tokens.js";

/** A `LoggerService` recording every line Nest is asked to write. */
function capturingLoggerService(): LoggerService & { lines: { level: string; text: string }[] } {
  const lines: { level: string; text: string }[] = [];
  const record =
    (level: string) =>
    (message: unknown): void => {
      lines.push({ level, text: String(message) });
    };
  return {
    lines,
    log: record("log"),
    error: record("error"),
    warn: record("warn"),
    debug: record("debug"),
  };
}

let running: INestApplication | undefined;

// `NestFactory.create({ logger: false })` and `app.useLogger()` both write `Logger.staticInstanceRef`
// — process-global state, not per-app. Snapshot and restore it, so a leftover capture array from one
// test can't silently become the logger every later test writes into. (Today Vitest's per-file
// isolation hides this; it stops hiding it the moment these suites share a worker.)
const NEST_LOGGER_GLOBAL = NestLoggerClass as unknown as { staticInstanceRef?: unknown };
let previousGlobalLogger: unknown;

beforeEach(() => {
  previousGlobalLogger = NEST_LOGGER_GLOBAL.staticInstanceRef;
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  NEST_LOGGER_GLOBAL.staticInstanceRef = previousGlobalLogger;
});

/**
 * Boot an embedded skein with the given module options and return the base URL plus the captured
 * Nest logger. Deliberately does NOT pass `logger` — the point is what happens by default.
 */
async function startEmbedded(
  options: Parameters<typeof SkeinModule.forRoot>[0],
): Promise<{ baseUrl: string; captured: ReturnType<typeof capturingLoggerService> }> {
  @Module({ imports: [SkeinModule.forRoot(options)] })
  class AppModule {}

  const app = await NestFactory.create(AppModule, { logger: false });
  const captured = capturingLoggerService();
  // What a host app does to install its own logger; also re-enables logging after `logger: false`.
  app.useLogger(captured);
  app.enableShutdownHooks();
  await app.listen(0, "127.0.0.1");
  running = app;

  const address = app.getHttpServer().address() as AddressInfo | null;
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, captured };
}

/** Run the always-throwing `boom` graph to completion and return the response status. */
async function runExplodingGraph(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/runs/wait`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assistant_id: "boom", input: { messages: [] } }),
  });
  // Drain, so the run has certainly settled before assertions run.
  await response.text();
  return response.status;
}

/**
 * The lines skein contributed about the failure. Filtered rather than asserting the log is empty:
 * Nest writes its own bootstrap line through the same `useLogger`, and that is not ours to suppress.
 */
function failureLines(captured: { lines: { level: string; text: string }[] }): string[] {
  return captured.lines.filter((line) => line.text.includes("graph exploded")).map((l) => l.text);
}

describe("SkeinModule — logging by default", () => {
  it("reports a failed graph run through the host's Nest logger, unconfigured", async () => {
    const { baseUrl, captured } = await startEmbedded({ deps: createEchoDeps() });
    await runExplodingGraph(baseUrl);

    const errors = captured.lines.filter((line) => line.level === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((line) => line.text).join("\n")).toContain("graph exploded");
  });

  it("stays silent when told to", async () => {
    const { baseUrl, captured } = await startEmbedded({ deps: createEchoDeps(), logger: false });
    await runExplodingGraph(baseUrl);
    expect(failureLines(captured)).toEqual([]);
  });

  it("writes to an explicit logger instead of Nest's", async () => {
    const explicit: { level: string; message: string }[] = [];
    const record =
      (level: string) =>
      (message: string): void => {
        explicit.push({ level, message });
      };
    const { baseUrl, captured } = await startEmbedded({
      deps: createEchoDeps(),
      logger: {
        debug: record("debug"),
        info: record("info"),
        warn: record("warn"),
        error: record("error"),
      },
    });
    await runExplodingGraph(baseUrl);

    expect(explicit.some((entry) => entry.level === "error")).toBe(true);
    expect(failureLines(captured)).toEqual([]);
  });

  it("keeps the legacy forResolvedRuntime(resolved, logger, cors) call shape working", async () => {
    // Dropping the middle parameter would not fail loudly for an untyped caller — `cors` would
    // silently receive the Logger, and CORS headers would go wrong rather than absent.
    const resolved = await resolveProtocolRuntime({ deps: createEchoDeps() });
    try {
      const legacy = SkeinModule.forResolvedRuntime(
        resolved,
        { debug() {}, info() {}, warn() {}, error() {} },
        true,
      );
      const modern = SkeinModule.forResolvedRuntime(resolved, true);
      // Both shapes must land `true` in the CORS slot, not a logger object.
      const corsOf = (module: { providers?: unknown[] }): unknown =>
        (module.providers ?? [])
          .map((provider) => provider as { provide?: symbol; useValue?: unknown })
          .find((provider) => provider.provide === SKEIN_CORS)?.useValue;
      expect(corsOf(legacy)).toBe(true);
      expect(corsOf(modern)).toBe(true);
    } finally {
      await resolved.runtime.worker.stop();
    }
  });

  it("still answers the request — logging is a side channel, not the response", async () => {
    const { baseUrl } = await startEmbedded({ deps: createEchoDeps() });
    // `/runs/wait` reports a failed run in its payload rather than as a transport error, so this is
    // a 200. The assertion is that the request is answered at all — the logging must not swallow or
    // stall the response path.
    expect(await runExplodingGraph(baseUrl)).toBe(200);
  });
});
