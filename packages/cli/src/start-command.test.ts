import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as runtime from "@skein-js/runtime";
import type * as serverKitModule from "@skein-js/server-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStart, type StartCommandOptions } from "./start-command.js";

vi.mock("@skein-js/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof runtime>()),
  buildRuntime: vi.fn(),
}));

vi.mock("@skein-js/server-kit", async (importOriginal) => {
  const serverKit = await importOriginal<typeof serverKitModule>();
  return {
    ...serverKit,
    detectRuntimeCapabilities: () => ({
      ...serverKit.detectRuntimeCapabilities(),
      signals: { on: () => ({ dispose: () => {} }) },
    }),
  };
});

let root: string;
let artifactDir: string;
let errorMessages: string[];
let previousExitCode: typeof process.exitCode;

function startOptions(config: string): StartCommandOptions {
  return { config, port: 8123, host: "127.0.0.1", store: "postgres", queue: "redis" };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "skein-start-artifact-"));
  artifactDir = path.join(root, ".skein", "build");
  mkdirSync(artifactDir, { recursive: true });
  const config = JSON.stringify({ graphs: { agent: "./not-imported.js:graph" } });
  writeFileSync(path.join(root, "langgraph.json"), config);
  writeFileSync(path.join(artifactDir, "langgraph.json"), config);
  writeFileSync(path.join(artifactDir, "schemas.json"), '{"agent":{}}');
  errorMessages = [];
  vi.spyOn(console, "error").mockImplementation((message: unknown) => {
    errorMessages.push(String(message));
  });
  vi.stubEnv("SKEIN_RUN_CONCURRENCY", "10");
  vi.stubEnv("SKEIN_SHUTDOWN_GRACE_MS", "5000");
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("runStart artifact selection", () => {
  it("reports the build hint and exits before constructing a runtime", async () => {
    await runStart(startOptions(path.join(root, "langgraph.json")));

    expect(process.exitCode).toBe(1);
    expect(errorMessages.join("\n")).toContain("skein start -c");
    expect(errorMessages.join("\n")).toContain(
      path.relative(process.cwd(), path.join(artifactDir, "langgraph.json")),
    );
    expect(runtime.buildRuntime).not.toHaveBeenCalled();
  });

  it.each(["missing", "invalid"])(
    "preserves the earlier error for a %s selected config",
    async (failure) => {
      const configPath = path.join(root, "langgraph.json");
      if (failure === "missing") rmSync(configPath);
      else writeFileSync(configPath, "invalid JSON");

      await runStart(startOptions(configPath));

      expect(process.exitCode).toBe(1);
      expect(errorMessages.join("\n")).toContain("SkeinConfigError");
      expect(errorMessages.join("\n")).not.toContain("skein start -c");
      expect(runtime.buildRuntime).not.toHaveBeenCalled();
    },
  );

  it("passes the explicitly selected artifact and its schemas to runtime construction", async () => {
    const configPath = path.join(artifactDir, "langgraph.json");
    vi.mocked(runtime.buildRuntime).mockRejectedValueOnce(
      new Error("runtime construction reached"),
    );

    await runStart(startOptions(configPath));

    expect(runtime.buildRuntime).toHaveBeenCalledOnce();
    expect(runtime.buildRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ configPath, schemas: { agent: {} } }),
    );
    expect(errorMessages.join("\n")).toContain("runtime construction reached");
    expect(errorMessages.join("\n")).not.toContain("skein start -c");
  });

  it("preserves concurrency validation before checking for missing schemas", async () => {
    vi.stubEnv("SKEIN_RUN_CONCURRENCY", "invalid");

    await runStart(startOptions(path.join(root, "langgraph.json")));

    expect(process.exitCode).toBe(1);
    expect(errorMessages.join("\n")).toContain("SKEIN_RUN_CONCURRENCY");
    expect(errorMessages.join("\n")).not.toContain("skein start -c");
    expect(runtime.buildRuntime).not.toHaveBeenCalled();
  });
});
