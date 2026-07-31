// `withThreadExecution` — the seam that turns per-thread execution serialization from a per-process
// mutex into a cross-instance claim.

import type { ThreadExecutionGate } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { ThreadLocks, withThreadExecution } from "./thread-locks.js";

/** A gate recording acquire/release order, so the ordering assertions read off one log. */
function recordingGate(log: string[]): ThreadExecutionGate {
  return {
    acquire: async (threadId) => {
      log.push(`acquire:${threadId}`);
      return {
        release: async () => {
          log.push(`release:${threadId}`);
        },
      };
    },
  };
}

describe("withThreadExecution", () => {
  it("runs the task without a gate, using the in-process lock alone", async () => {
    const locks = new ThreadLocks();
    await expect(withThreadExecution(locks, undefined, "t-1", async () => "done")).resolves.toBe(
      "done",
    );
  });

  it("claims the thread before the task and releases it after", async () => {
    const log: string[] = [];
    await withThreadExecution(new ThreadLocks(), recordingGate(log), "t-1", async () => {
      log.push("task");
    });

    expect(log).toEqual(["acquire:t-1", "task", "release:t-1"]);
  });

  it("releases the claim even when the task throws", async () => {
    // Otherwise one failed run leaves its thread claimed for the lifetime of the process — and with a
    // session-lock implementation, until the connection dies.
    const log: string[] = [];
    await expect(
      withThreadExecution(new ThreadLocks(), recordingGate(log), "t-1", () =>
        Promise.reject(new Error("graph exploded")),
      ),
    ).rejects.toThrow("graph exploded");

    expect(log).toEqual(["acquire:t-1", "release:t-1"]);
  });

  it("fails the run rather than proceeding unguarded when the claim cannot be taken", async () => {
    // Proceeding is the unsafe direction: it would let two instances write one thread's checkpoints,
    // which is the corruption the gate exists to prevent.
    const task = vi.fn(async () => "should not run");
    const failing: ThreadExecutionGate = {
      acquire: () => Promise.reject(new Error("postgres is unreachable")),
    };

    await expect(withThreadExecution(new ThreadLocks(), failing, "t-1", task)).rejects.toThrow(
      /could not claim thread "t-1"/,
    );
    expect(task).not.toHaveBeenCalled();
  });

  it("takes one claim per queued run, serialized by the local lock first", async () => {
    // The local mutex is layered under the gate on purpose: acquiring a cross-instance claim is a round
    // trip, and this ordering means two runs on one thread cannot both be waiting on the backend.
    const log: string[] = [];
    const locks = new ThreadLocks();
    const gate = recordingGate(log);

    await Promise.all([
      withThreadExecution(locks, gate, "t-1", async () => {
        log.push("first");
      }),
      withThreadExecution(locks, gate, "t-1", async () => {
        log.push("second");
      }),
    ]);

    // Strictly sequential: never two acquires before a release.
    expect(log).toEqual([
      "acquire:t-1",
      "first",
      "release:t-1",
      "acquire:t-1",
      "second",
      "release:t-1",
    ]);
  });

  it("does not serialize distinct threads against each other", async () => {
    const log: string[] = [];
    const locks = new ThreadLocks();
    const gate = recordingGate(log);
    let releaseFirst: (() => void) | undefined;

    const first = withThreadExecution(locks, gate, "t-1", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    // A different thread proceeds while t-1 is still held.
    await withThreadExecution(locks, gate, "t-2", async () => {
      log.push("t-2 ran while t-1 held");
    });
    releaseFirst?.();
    await first;

    expect(log).toContain("t-2 ran while t-1 held");
    expect(log.indexOf("t-2 ran while t-1 held")).toBeLessThan(log.indexOf("release:t-1"));
  });
});
