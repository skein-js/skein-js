/**
 * Memory values that runtimes can report honestly. Missing values are unavailable, not zero.
 *
 * No heap *limit* here on purpose: no runtime reports one through this seam, and an optional field
 * nothing populates reads to a caller as "unavailable" when the truth is that
 * `node:v8`'s `getHeapStatistics()` answers on all three (see `resolve-runtime.ts`). A field that is
 * always undefined is how the heap-pressure monitor came to be silently disabled on Bun and Deno.
 */
export interface RuntimeMemorySnapshot {
  rssBytes?: number;
  heapUsedBytes?: number;
  nativeHeapBytes?: number;
}

export interface RuntimeSignalSubscription {
  dispose(): void;
}

/** The small platform seam used by runtime-neutral production launchers and diagnostics. */
export interface RuntimeCapabilities {
  name: "node" | "bun" | "deno";
  version: string;
  env: {
    get(name: string): string | undefined;
    set(name: string, value: string): void;
  };
  clock: {
    nowEpochMs(): number;
    nowMonotonicMs(): number;
  };
  memory: {
    read(): RuntimeMemorySnapshot;
  };
  signals: {
    on(signal: "SIGINT" | "SIGTERM", listener: () => void): RuntimeSignalSubscription;
  };
  exit(code: number): never;
}

interface ProcessLike {
  version: string;
  env: Record<string, string | undefined>;
  memoryUsage(): { rss: number; heapUsed: number };
  on(signal: string, listener: () => void): void;
  off(signal: string, listener: () => void): void;
  exit(code: number): never;
}

interface BunLike {
  version: string;
  env: Record<string, string | undefined>;
  memoryUsage?(): { rss?: number; heapUsed?: number; current?: number };
}

interface DenoLike {
  version: { deno: string };
  env: { get(name: string): string | undefined; set(name: string, value: string): void };
  memoryUsage(): { rss: number; heapUsed: number };
  addSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  exit(code: number): never;
}

type RuntimeGlobal = typeof globalThis & {
  process?: ProcessLike;
  Bun?: BunLike;
  Deno?: DenoLike;
};

/** Detect Node, Bun, or Deno without importing a runtime-specific module. */
export function detectRuntimeCapabilities(scope: RuntimeGlobal = globalThis): RuntimeCapabilities {
  const monotonic = (): number => scope.performance?.now() ?? Date.now();
  const commonClock = { nowEpochMs: Date.now, nowMonotonicMs: monotonic };

  if (scope.Bun) {
    const bun = scope.Bun;
    const process = scope.process;
    if (!process) throw new Error("Bun runtime does not expose process lifecycle compatibility.");
    return {
      name: "bun",
      version: bun.version,
      env: {
        get: (name) => bun.env[name],
        set: (name, value) => {
          bun.env[name] = value;
        },
      },
      clock: commonClock,
      memory: {
        read: () => {
          const native = bun.memoryUsage?.();
          const fallback = process.memoryUsage();
          return {
            rssBytes: native?.rss ?? fallback.rss,
            heapUsedBytes: native?.heapUsed ?? fallback.heapUsed,
            nativeHeapBytes: native?.current,
          };
        },
      },
      signals: {
        on: (signal, listener) => {
          process.on(signal, listener);
          return { dispose: () => process.off(signal, listener) };
        },
      },
      exit: (code) => process.exit(code),
    };
  }

  if (scope.Deno) {
    const deno = scope.Deno;
    return {
      name: "deno",
      version: deno.version.deno,
      env: deno.env,
      clock: commonClock,
      memory: {
        read: () => {
          const memory = deno.memoryUsage();
          return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
        },
      },
      signals: {
        on: (signal, listener) => {
          deno.addSignalListener(signal, listener);
          return { dispose: () => deno.removeSignalListener(signal, listener) };
        },
      },
      exit: (code) => deno.exit(code),
    };
  }

  const process = scope.process;
  if (!process)
    throw new Error("Unsupported JavaScript runtime: process, Bun, and Deno are absent.");
  return {
    name: "node",
    version: process.version.replace(/^v/, ""),
    env: {
      get: (name) => process.env[name],
      set: (name, value) => {
        process.env[name] = value;
      },
    },
    clock: commonClock,
    memory: {
      read: () => {
        const memory = process.memoryUsage();
        return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
      },
    },
    signals: {
      on: (signal, listener) => {
        process.on(signal, listener);
        return { dispose: () => process.off(signal, listener) };
      },
    },
    exit: (code) => process.exit(code),
  };
}
