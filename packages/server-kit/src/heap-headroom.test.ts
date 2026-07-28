// Asserted against injected numbers rather than the real process: a test that read this process's own
// heap limit would assert whatever the machine running it happens to have, which is no assertion at all.

import { describe, expect, it } from "vitest";

import {
  checkHeapHeadroom,
  describeHeapHeadroom,
  readContainerMemoryLimit,
} from "./heap-headroom.js";

const MB = 1048576;

/** A reader that serves `files` and reports everything else as absent. */
function fakeFiles(files: Record<string, string>) {
  return (path: string): string | undefined => files[path];
}

describe("readContainerMemoryLimit", () => {
  it("reads the cgroup v2 limit", () => {
    expect(
      readContainerMemoryLimit(fakeFiles({ "/sys/fs/cgroup/memory.max": "536870912\n" })),
    ).toBe(536870912);
  });

  it("falls back to cgroup v1", () => {
    expect(
      readContainerMemoryLimit(
        fakeFiles({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456" }),
      ),
    ).toBe(268435456);
  });

  it("prefers v2 when both are present", () => {
    expect(
      readContainerMemoryLimit(
        fakeFiles({
          "/sys/fs/cgroup/memory.max": "536870912",
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "268435456",
        }),
      ),
    ).toBe(536870912);
  });

  it("treats cgroup v2's `max` as no limit", () => {
    expect(
      readContainerMemoryLimit(fakeFiles({ "/sys/fs/cgroup/memory.max": "max\n" })),
    ).toBeUndefined();
  });

  // v1 writes a page-size-dependent sentinel rather than anything meaningful. Read literally it is
  // ~8 exabytes, which would make every comparison below trivially pass.
  it("treats cgroup v1's unlimited sentinel as no limit", () => {
    expect(
      readContainerMemoryLimit(
        fakeFiles({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712" }),
      ),
    ).toBeUndefined();
  });

  it("is undefined off a container, and on garbage", () => {
    expect(readContainerMemoryLimit(fakeFiles({}))).toBeUndefined();
    expect(
      readContainerMemoryLimit(fakeFiles({ "/sys/fs/cgroup/memory.max": "nonsense" })),
    ).toBeUndefined();
    expect(
      readContainerMemoryLimit(fakeFiles({ "/sys/fs/cgroup/memory.max": "0" })),
    ).toBeUndefined();
  });
});

describe("describeHeapHeadroom", () => {
  // The band this exists for: Node's automatic sizing bottoms out around 259MB, so a 256Mi container
  // gets a heap ceiling slightly *larger* than the container itself.
  it("warns when V8's ceiling exceeds the container's limit", () => {
    const { warning } = describeHeapHeadroom(259 * MB, 256 * MB);

    expect(warning).toContain("259MB");
    expect(warning).toContain("256MB");
    expect(warning).toContain("--max-old-space-size=153");
  });

  // Otherwise the advice is a loop: `heap_size_limit` sits a few MB above `--max-old-space-size`, so a
  // suggestion at exactly the warning threshold still trips it. Verified across the whole band in which
  // the warning can fire.
  it("suggests a value that actually silences the warning", () => {
    for (const containerMb of [128, 192, 256, 320, 344]) {
      const warning = describeHeapHeadroom(259 * MB, containerMb * MB).warning;
      const suggested = Number(/--max-old-space-size=(\d+)/.exec(warning ?? "")?.[1]);
      // `heap_size_limit` runs a few MB above the old-space setting (semi-space + code space).
      const resultingHeapMb = suggested + 4;

      expect(describeHeapHeadroom(resultingHeapMb * MB, containerMb * MB).warning).toBeUndefined();
    }
  });

  // Keeping the image's own flag matters: NODE_OPTIONS replaces rather than appends, so advice that
  // named only the heap flag would silently cost the operator their TypeScript stack traces.
  it("tells the operator to keep --enable-source-maps", () => {
    expect(describeHeapHeadroom(259 * MB, 256 * MB).warning).toContain("--enable-source-maps");
  });

  it("warns as soon as the ceiling passes three quarters of the limit", () => {
    expect(describeHeapHeadroom(385 * MB, 512 * MB).warning).toBeDefined();
    expect(describeHeapHeadroom(384 * MB, 512 * MB).warning).toBeUndefined();
  });

  it("stays quiet when the heap is sized well within the container", () => {
    expect(describeHeapHeadroom(256 * MB, 1024 * MB).warning).toBeUndefined();
  });

  // Node's own sizing is fine from roughly 345Mi up — measured on node:22-slim, `heap_size_limit` is
  // about half the cgroup limit there. Warning in that band would be noise on every correct deployment.
  it("stays quiet where Node's automatic sizing already fits", () => {
    expect(describeHeapHeadroom(259 * MB, 512 * MB).warning).toBeUndefined();
    expect(describeHeapHeadroom(524 * MB, 1024 * MB).warning).toBeUndefined();
    expect(describeHeapHeadroom(1048 * MB, 2048 * MB).warning).toBeUndefined();
  });

  // Otherwise every `skein dev` on a laptop would warn: V8's ceiling is always a large fraction of a
  // developer's RAM, and there is no container limit for it to be wrong about.
  it("stays quiet when there is no container limit to compare against", () => {
    expect(describeHeapHeadroom(4096 * MB, undefined).warning).toBeUndefined();
  });

  it("reports both numbers even when it does not warn", () => {
    const reading = describeHeapHeadroom(256 * MB, 1024 * MB);

    expect(reading.heapLimitBytes).toBe(256 * MB);
    expect(reading.containerLimitBytes).toBe(1024 * MB);
  });
});

describe("checkHeapHeadroom", () => {
  it("combines the two readings", () => {
    const reading = checkHeapHeadroom({
      heapStatistics: () => ({ heap_size_limit: 2048 * MB }),
      readFile: fakeFiles({ "/sys/fs/cgroup/memory.max": String(512 * MB) }),
    });

    expect(reading.containerLimitBytes).toBe(512 * MB);
    expect(reading.warning).toBeDefined();
  });

  it("reads the real process when nothing is injected, without throwing off a container", () => {
    const reading = checkHeapHeadroom({ readFile: () => undefined });

    expect(reading.heapLimitBytes).toBeGreaterThan(0);
    expect(reading.warning).toBeUndefined();
  });
});
