// A boot-time check that V8's heap ceiling actually fits the container it is running in.
//
// Node *is* cgroup-aware (since v12 it sizes the heap from `uv_get_constrained_memory()`), so the usual
// telling of this — "V8 sizes from the host, so a small container gets a multi-gigabyte heap" — is not
// true of any runtime skein ships on. Measured on `node:22-slim`, `heap_size_limit` tracks about half
// the cgroup limit: 512Mi → 259MB, 1Gi → 524MB, 2Gi → 1048MB.
//
// What is true is that the sizing has a **floor**. Below roughly 345Mi the ceiling stops shrinking and
// sits at ~259MB regardless: 256Mi → 259MB (101% of the container), 128Mi → 259MB (202%). That band is
// not exotic — it is the default on Cloud Run and a common Kubernetes request — and in it V8 will not
// feel the pressure that triggers a full GC before the kernel OOM-kills the process. That failure
// surfaces as a restart with no stack, no log line, and nothing in the application's own metrics, which
// is the most confusing way for a memory problem to present.
//
// So this warns only in the band where it is real, and stays silent from ~345Mi up.
//
// Boot-time only, and advisory: it reports a mis-sizing that is already true before any traffic
// arrives. Watching usage as it changes would be a separate, ongoing monitor.

import { readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";

/** Fraction of the container's limit above which V8's heap ceiling is worth warning about. */
const HEAP_LIMIT_WARN_FRACTION = 0.75;

/**
 * Fraction used for the suggested `--max-old-space-size`, deliberately *below*
 * {@link HEAP_LIMIT_WARN_FRACTION}.
 *
 * `heap_size_limit` is the old space plus the other spaces V8 reserves (semi-space, code), which runs a
 * few MB above whatever `--max-old-space-size` is set to. Suggesting the threshold value exactly would
 * therefore produce a heap that is still marginally over it: the operator does what the warning said,
 * redeploys, and gets the identical warning. The gap absorbs that.
 */
const HEAP_LIMIT_SUGGEST_FRACTION = 0.6;

/** cgroup v2 first, then v1 — checked in that order, as a modern kernel exposes v2. */
const MEMORY_LIMIT_FILES = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
] as const;

/** Reads a file, or returns undefined when it is absent/unreadable. Injectable for tests. */
export type FileReader = (path: string) => string | undefined;

const readFileIfPresent: FileReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * The container's memory limit in bytes, or `undefined` when there isn't one to read — not
 * containerized, a cgroup namespace that doesn't expose it, or an explicitly unlimited container.
 *
 * cgroup v2 writes the literal `max` when unbounded; v1 writes a huge sentinel (commonly
 * `9223372036854771712`) rather than anything meaningful, so a value at or above the exabyte mark is
 * treated as "no limit" too.
 */
export function readContainerMemoryLimit(
  readFile: FileReader = readFileIfPresent,
): number | undefined {
  for (const path of MEMORY_LIMIT_FILES) {
    const raw = readFile(path)?.trim();
    if (raw === undefined || raw === "" || raw === "max") continue;
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    // v1's "unlimited" sentinel is page-size-dependent, so bound it rather than matching it exactly.
    if (bytes >= Number.MAX_SAFE_INTEGER) continue;
    return bytes;
  }
  return undefined;
}

export interface HeapHeadroom {
  /** V8's own ceiling for the old space, in bytes. */
  heapLimitBytes: number;
  /** The container's limit, when one could be read. */
  containerLimitBytes: number | undefined;
  /** A warning to log, or `undefined` when the sizing is fine (or unknowable). */
  warning: string | undefined;
}

/** Bytes as a rounded MB string, for a log line a human reads once. */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1048576)}MB`;
}

/**
 * Compare V8's heap ceiling against the container's memory limit.
 *
 * Warns when the ceiling exceeds {@link HEAP_LIMIT_WARN_FRACTION} of the limit: at that point V8 is
 * willing to grow into memory the container does not have, and the process dies by OOM kill rather than
 * by a heap-out-of-memory error it could report. The remedy is `--max-old-space-size`, which is why the
 * warning names it with a computed value rather than telling the operator to go and read something.
 *
 * Silent when no container limit is readable: guessing on a bare host would warn on every dev machine.
 */
export function describeHeapHeadroom(
  heapLimitBytes: number,
  containerLimitBytes: number | undefined,
): HeapHeadroom {
  if (
    containerLimitBytes === undefined ||
    heapLimitBytes <= containerLimitBytes * HEAP_LIMIT_WARN_FRACTION
  ) {
    return { heapLimitBytes, containerLimitBytes, warning: undefined };
  }
  // Leaves room for everything that is not the old space: V8's other spaces, Buffers, the
  // Postgres/Redis clients' sockets, and the runtime itself.
  const suggestedMb = Math.floor((containerLimitBytes * HEAP_LIMIT_SUGGEST_FRACTION) / 1048576);
  return {
    heapLimitBytes,
    containerLimitBytes,
    warning:
      `V8's heap limit (${megabytes(heapLimitBytes)}) is close to or above this container's memory ` +
      `limit (${megabytes(containerLimitBytes)}). Node's automatic sizing has a floor of about 259MB, ` +
      `so below roughly 345Mi it stops adapting — V8 may not run a full GC before the kernel ` +
      `OOM-kills the process, which looks like an unexplained restart rather than a memory error. ` +
      `Lower it explicitly with ` +
      `NODE_OPTIONS="--enable-source-maps --max-old-space-size=${suggestedMb}", or give the container ` +
      `more memory. Keep --enable-source-maps: NODE_OPTIONS replaces the image's value rather than ` +
      `adding to it, so setting it without that flag silently loses TypeScript stack traces.`,
  };
}

/**
 * Read both limits and report the mis-sizing, if any. Call once at boot.
 *
 * `heapStatistics` and `readFile` are injected so this is testable without a container and without
 * mutating the real process's heap.
 */
export function checkHeapHeadroom(
  options: {
    heapStatistics?: () => { heap_size_limit: number };
    readFile?: FileReader;
  } = {},
): HeapHeadroom {
  const heapLimit = (options.heapStatistics ?? getHeapStatistics)().heap_size_limit;
  return describeHeapHeadroom(heapLimit, readContainerMemoryLimit(options.readFile));
}
