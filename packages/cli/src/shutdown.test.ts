import { DEFAULT_SHUTDOWN_GRACE_MS } from "@skein-js/server-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createShutdownHandler, FORCE_EXIT_BUFFER_MS, forceExitDelayMs } from "./shutdown.js";

describe("forceExitDelayMs", () => {
  // This inequality is the fix. Firing the force-exit at the same instant the worker's drain window
  // closes kills the process during the abort step that settles stragglers to a terminal status,
  // leaving runs stuck `running` in the store.
  it.each([0, 100, DEFAULT_SHUTDOWN_GRACE_MS, 30_000])(
    "waits strictly longer than a %sms drain window",
    (graceMs) => {
      expect(forceExitDelayMs(graceMs)).toBeGreaterThan(graceMs);
      expect(forceExitDelayMs(graceMs)).toBe(graceMs + FORCE_EXIT_BUFFER_MS);
    },
  );

  it("keeps the default total inside the ~10s window Cloud Run and `docker stop` allow", () => {
    expect(forceExitDelayMs()).toBe(DEFAULT_SHUTDOWN_GRACE_MS + FORCE_EXIT_BUFFER_MS);
    expect(forceExitDelayMs()).toBeLessThan(10_000);
  });
});

describe("createShutdownHandler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("exits as soon as close() settles, without waiting out the timer", async () => {
    const exit = vi.fn();
    createShutdownHandler({ forceExitMs: 8000, close: () => Promise.resolve(), exit })();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("forces exit only after the full delay when close() never settles", async () => {
    const exit = vi.fn();
    const graceMs = DEFAULT_SHUTDOWN_GRACE_MS;
    createShutdownHandler({
      forceExitMs: forceExitDelayMs(graceMs),
      close: () => new Promise(() => {}),
      exit,
    })();

    // The moment the worker's drain window closes, it starts aborting stragglers — the process must
    // still be alive for that to finish.
    await vi.advanceTimersByTimeAsync(graceMs);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FORCE_EXIT_BUFFER_MS);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 when close() rejects, instead of crashing on an unhandled rejection", async () => {
    // Teardown is best-effort. An unhandled rejection here would exit non-zero, which a platform
    // records as a container crash on every such stop — and `exit(0)` would never be reached.
    const exit = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    createShutdownHandler({
      forceExitMs: 8000,
      close: () => Promise.reject(new Error("redis already gone")),
      exit,
    })();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("redis already gone"));
    consoleError.mockRestore();
  });

  it("runs close() even when the pre-shutdown hook throws", async () => {
    // The hook is caller-supplied; a throw there must not skip the drain, which is the only thing
    // that settles in-flight runs.
    const exit = vi.fn();
    const close = vi.fn(() => Promise.resolve());
    createShutdownHandler({
      forceExitMs: 8000,
      onShutdownStart: () => {
        throw new Error("state flush failed");
      },
      close,
      exit,
    })();
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores a second signal instead of starting a second teardown", async () => {
    const close = vi.fn(() => Promise.resolve());
    const onShutdownStart = vi.fn();
    const shutdown = createShutdownHandler({
      forceExitMs: 8000,
      close,
      onShutdownStart,
      exit: vi.fn(),
    });
    shutdown();
    shutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onShutdownStart).toHaveBeenCalledTimes(1);
  });

  it("runs onShutdownStart before close, so a final state flush can't be raced", () => {
    const order: string[] = [];
    createShutdownHandler({
      forceExitMs: 8000,
      onShutdownStart: () => order.push("flush"),
      close: () => {
        order.push("close");
        return Promise.resolve();
      },
      exit: vi.fn(),
    })();
    expect(order).toEqual(["flush", "close"]);
  });
});
