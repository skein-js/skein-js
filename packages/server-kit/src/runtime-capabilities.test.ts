import { describe, expect, it, vi } from "vitest";

import { detectRuntimeCapabilities } from "./runtime-capabilities.js";

const exit = (): never => {
  throw new Error("exit");
};

describe("detectRuntimeCapabilities", () => {
  it("reports Node memory without inventing a heap limit", () => {
    const on = vi.fn();
    const off = vi.fn();
    const capabilities = detectRuntimeCapabilities({
      process: {
        version: "v22.20.0",
        env: {},
        memoryUsage: () => ({ rss: 100, heapUsed: 40 }),
        on,
        off,
        exit,
      },
    } as never);

    expect(capabilities.name).toBe("node");
    expect(capabilities.version).toBe("22.20.0");
    expect(capabilities.memory.read()).toEqual({ rssBytes: 100, heapUsedBytes: 40 });
    const subscription = capabilities.signals.on("SIGTERM", () => {});
    subscription.dispose();
    expect(on).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
  });

  it("uses Bun's native heap reading while retaining process lifecycle support", () => {
    const capabilities = detectRuntimeCapabilities({
      Bun: {
        version: "1.3.14",
        env: {},
        memoryUsage: () => ({ rss: 90, heapUsed: 30, current: 12 }),
      },
      process: {
        version: "v24.0.0",
        env: {},
        memoryUsage: () => ({ rss: 100, heapUsed: 40 }),
        on: () => {},
        off: () => {},
        exit,
      },
    } as never);

    expect(capabilities.name).toBe("bun");
    expect(capabilities.memory.read()).toEqual({
      rssBytes: 90,
      heapUsedBytes: 30,
      nativeHeapBytes: 12,
    });
  });

  it("uses Deno's native environment, signals, and honest memory fields", () => {
    const values = new Map<string, string>();
    const capabilities = detectRuntimeCapabilities({
      Deno: {
        version: { deno: "2.9.4" },
        env: {
          get: (name: string) => values.get(name),
          set: (name: string, value: string) => values.set(name, value),
        },
        memoryUsage: () => ({ rss: 80, heapUsed: 20 }),
        addSignalListener: () => {},
        removeSignalListener: () => {},
        exit,
      },
    } as never);

    capabilities.env.set("PORT", "8123");
    expect(capabilities.name).toBe("deno");
    expect(capabilities.env.get("PORT")).toBe("8123");
    expect(capabilities.memory.read()).toEqual({ rssBytes: 80, heapUsedBytes: 20 });
  });
});
