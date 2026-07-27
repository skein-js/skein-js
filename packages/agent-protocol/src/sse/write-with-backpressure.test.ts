import { describe, expect, it } from "vitest";

import { writeWithBackpressure, type BackpressuredWritable } from "./write-with-backpressure.js";

/**
 * A writable that accepts `capacity` bytes and then reports back-pressure until `drain()` is called.
 * Asserting against this — rather than a real socket — is what makes the contract testable without
 * timing, sockets, or garbage collection.
 *
 * `once` genuinely fires once and then removes itself, matching Node's `onceWrapper`. A fake whose
 * `once` is really `on` would let a listener-leak bug pass, since the helper relies on `off()` finding
 * a wrapper installed by `once()`.
 */
function fakeWritable(capacity: number) {
  const listeners = new Map<string, Set<() => void>>();
  let buffered = 0;

  const emit = (event: string): void => {
    const forEvent = listeners.get(event);
    if (!forEvent) return;
    // Copy before iterating: a `once` listener removes itself, and `settle` removes the other two.
    for (const listener of [...forEvent]) {
      forEvent.delete(listener);
      listener();
    }
  };

  const res = {
    destroyed: false,
    writableEnded: false,
    write(chunk: string) {
      buffered += chunk.length;
      return buffered < capacity;
    },
    once(event: string, listener: () => void) {
      const forEvent = listeners.get(event) ?? new Set<() => void>();
      forEvent.add(listener);
      listeners.set(event, forEvent);
      return res;
    },
    off(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener);
      return res;
    },
    buffered: () => buffered,
    /** Total registered listeners — the direct leak check. */
    listenerCount: () =>
      [...listeners.values()].reduce((total, forEvent) => total + forEvent.size, 0),
    drain() {
      buffered = 0;
      emit("drain");
    },
    close: () => emit("close"),
    error: () => emit("error"),
  };
  return res satisfies BackpressuredWritable;
}

describe("writeWithBackpressure", () => {
  it("returns undefined while the stream has capacity, so the fast path allocates nothing", () => {
    const res = fakeWritable(100);

    expect(writeWithBackpressure(res, "a".repeat(10))).toBeUndefined();
    expect(writeWithBackpressure(res, "a".repeat(10))).toBeUndefined();
  });

  it("returns a pending promise once the stream is full", async () => {
    const res = fakeWritable(10);

    const pending = writeWithBackpressure(res, "a".repeat(20));
    expect(pending).toBeInstanceOf(Promise);

    let settled = false;
    void pending?.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    res.drain();
    await pending;
    expect(settled).toBe(true);
  });

  it("settles on close, so a client that vanishes mid-buffer cannot hang the write loop", async () => {
    const res = fakeWritable(10);
    const pending = writeWithBackpressure(res, "a".repeat(20));

    res.close();
    await expect(pending).resolves.toBeUndefined();
  });

  it("settles on error as well", async () => {
    const res = fakeWritable(10);
    const pending = writeWithBackpressure(res, "a".repeat(20));

    res.error();
    await expect(pending).resolves.toBeUndefined();
  });

  // The regression these two guard is worse than the bug the helper fixes. A destroyed response
  // returns `false` from `write()` and then emits nothing ever again — `close` has already fired,
  // `error` is suppressed once destroyed, `drain` never comes. Waiting parks the caller's loop for
  // good, so its `finally` never runs, the frame generator is never returned, and the run's bus
  // subscription is pinned for the life of the process.
  it("never waits on a destroyed stream", () => {
    const res = fakeWritable(10);
    res.destroyed = true;

    expect(writeWithBackpressure(res, "a".repeat(20))).toBeUndefined();
    expect(res.listenerCount()).toBe(0);
  });

  it("never waits on a stream that has already ended", () => {
    const res = fakeWritable(10);
    res.writableEnded = true;

    expect(writeWithBackpressure(res, "a".repeat(20))).toBeUndefined();
    expect(res.listenerCount()).toBe(0);
  });

  it("leaves no listeners behind, whichever event settles the wait", async () => {
    const res = fakeWritable(10);

    for (const settleWith of ["drain", "close", "error"] as const) {
      const pending = writeWithBackpressure(res, "a".repeat(20));
      expect(res.listenerCount()).toBe(3);
      res[settleWith]();
      await pending;
      // Asserting zero directly. An earlier version of this test inferred the absence of leaks from
      // the promise's behaviour, which cannot work: a stale `settle` closes over an already-resolved
      // promise, so resolving it again is a no-op that no later assertion can observe.
      expect(res.listenerCount()).toBe(0);
    }
  });
});

describe("the SSE write loop", () => {
  /**
   * The loop every adapter runs, including the `clientDisconnected` flag and the `finally` — the two
   * parts that decide whether the disconnect path is safe. Reducing it further would test a loop no
   * adapter actually runs.
   */
  async function pipe(
    events: AsyncIterableIterator<string>,
    res: ReturnType<typeof fakeWritable>,
  ): Promise<{ finallyRan: boolean; iteratorReturned: boolean }> {
    const outcome = { finallyRan: false, iteratorReturned: false };
    let clientDisconnected = false;
    const releaseOnClientClose = (): void => {
      clientDisconnected = true;
      void Promise.resolve(events.return?.(undefined));
    };
    res.once("close", releaseOnClientClose);

    try {
      for (;;) {
        const next = await events.next();
        if (next.done || clientDisconnected) break;
        const pending = writeWithBackpressure(res, next.value);
        if (pending) await pending;
      }
    } finally {
      outcome.finallyRan = true;
      res.off("close", releaseOnClientClose);
    }
    outcome.iteratorReturned = true;
    return outcome;
  }

  /**
   * A frame source that records how many times it was pulled, and whether it was finalized.
   *
   * Capped rather than endless: an endless source makes an unpaced loop spin forever, so a regression
   * would hang the suite instead of failing it. The cap is far above any expected pull count.
   */
  function countingFrames(frame: string, limit = 10_000) {
    const state = { pulls: 0, finalized: false };
    const iterator: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next() {
        if (state.pulls >= limit) return Promise.resolve({ done: true, value: undefined });
        state.pulls += 1;
        return Promise.resolve({ done: false, value: frame });
      },
      return() {
        state.finalized = true;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    return { iterator, state };
  }

  /**
   * Let the event loop run `ticks` times. Generous on purpose: the assertion has to hold no matter
   * how long the loop is given, since the failure being guarded against pulls *more* frames the
   * longer it runs.
   */
  const flushMicrotasks = async (ticks = 100): Promise<void> => {
    for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
  };

  it("stops pulling frames while the client is behind", async () => {
    // The heart of it. Without backpressure this loop races ahead of the client and queues every
    // frame the graph produces — one pull per microtask, without limit. Pinning the count at exactly
    // one across a hundred ticks is what makes the fix provable rather than plausible.
    const res = fakeWritable(10);
    const { iterator, state } = countingFrames("a".repeat(20));

    const piped = pipe(iterator, res);
    await flushMicrotasks();

    expect(state.pulls).toBe(1);

    // One drain releases exactly one more frame, then it blocks again.
    res.drain();
    await flushMicrotasks();
    expect(state.pulls).toBe(2);

    res.close();
    await piped;
  });

  it("tears down when the client disconnects while the loop is blocked on backpressure", async () => {
    // The disconnect path, exercised at the point it is hardest: suspended mid-write rather than
    // between frames. Everything downstream depends on the `finally` running here — it is what
    // returns the frame generator and releases the run's bus subscription.
    const res = fakeWritable(10);
    const { iterator, state } = countingFrames("a".repeat(20));

    const piped = pipe(iterator, res);
    await flushMicrotasks();
    expect(state.pulls).toBe(1);

    res.close();

    const outcome = await piped;
    expect(outcome.finallyRan).toBe(true);
    expect(outcome.iteratorReturned).toBe(true);
    expect(state.finalized).toBe(true);
    expect(res.listenerCount()).toBe(0);
  });

  it("drains a finite stream without pausing when the client keeps up", async () => {
    const res = fakeWritable(1_000_000);
    const { iterator, state } = countingFrames("frame\n\n", 5);

    const outcome = await pipe(iterator, res);

    expect(state.pulls).toBe(5);
    expect(res.buffered()).toBe(5 * "frame\n\n".length);
    expect(outcome.finallyRan).toBe(true);
  });
});
