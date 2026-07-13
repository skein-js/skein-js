// Single-process implementations of the run queue + event bus, so `skein dev` needs nothing
// beyond Node. `@skein-js/redis` provides the cross-instance versions; the run engine talks only
// to the `@skein-js/core` interfaces, so it is unaware which one it has.

import type { QueuedRun, RunEventBus, RunFrame, RunQueue } from "@skein-js/core";

/** In-memory FIFO of background runs awaiting a worker. */
export class MemoryRunQueue implements RunQueue {
  readonly #items: QueuedRun[] = [];

  async enqueue(run: QueuedRun): Promise<void> {
    this.#items.push({ ...run });
  }

  async dequeue(): Promise<QueuedRun | null> {
    return this.#items.shift() ?? null;
  }
}

interface Channel {
  frames: RunFrame[];
  closed: boolean;
  /** Resolvers woken whenever a frame is published or the run is closed. */
  waiters: Array<() => void>;
  /** Live subscriber count, so a channel with active readers is never evicted. */
  subscribers: number;
}

/** How many finished (closed) runs' frame buffers to retain for late-join replay, by default. */
const DEFAULT_MAX_RETAINED_RUNS = 1000;

/**
 * In-memory fan-out of run frames. Each frame is buffered, so a subscriber that joins late (or
 * reconnects with an `afterSeq`) replays what it missed and then live-tails until the run
 * closes. Buffering also means publish never blocks on a slow consumer.
 *
 * A closed run's frame buffer is retained for late-join replay, but only for the most recent
 * `maxRetainedRuns` closed runs (LRU). Beyond that the buffer is dropped and the channel is kept as
 * a lightweight *closed tombstone* — so a long-lived process can't grow its frame memory without
 * bound, yet a late join to an evicted run still completes at once (empty) instead of hanging.
 * Active (unclosed) runs and runs with live subscribers keep their frames. `@skein-js/redis` bounds
 * this with a real TTL in production.
 */
export class MemoryRunEventBus implements RunEventBus {
  readonly #channels = new Map<string, Channel>();
  /** Closed runs in close order (oldest first), for LRU eviction of retained buffers. */
  readonly #closedOrder: string[] = [];
  readonly #maxRetainedRuns: number;

  constructor(options: { maxRetainedRuns?: number } = {}) {
    this.#maxRetainedRuns = options.maxRetainedRuns ?? DEFAULT_MAX_RETAINED_RUNS;
  }

  #channel(runId: string): Channel {
    let channel = this.#channels.get(runId);
    if (!channel) {
      channel = { frames: [], closed: false, waiters: [], subscribers: 0 };
      this.#channels.set(runId, channel);
    }
    return channel;
  }

  #wake(channel: Channel): void {
    const waiters = channel.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  // Free the frame buffers of the oldest retained closed runs beyond the cap, leaving a closed
  // tombstone so a late join replays nothing and completes at once (rather than hanging on a
  // recreated open channel). A channel with live subscribers is mid-replay: keep its frames and
  // re-queue it so it's reconsidered after the reader detaches.
  #evictClosedBeyondCap(): void {
    let scanned = 0;
    while (this.#closedOrder.length > this.#maxRetainedRuns && scanned < this.#closedOrder.length) {
      scanned += 1;
      const runId = this.#closedOrder.shift();
      if (runId === undefined) break;
      const channel = this.#channels.get(runId);
      if (!channel) continue;
      if (channel.subscribers > 0) {
        this.#closedOrder.push(runId);
        continue;
      }
      channel.frames = []; // drop the heavy buffer; the closed tombstone stays for hang-free joins
    }
  }

  async publish(runId: string, frame: RunFrame): Promise<void> {
    const channel = this.#channel(runId);
    channel.frames.push(frame);
    this.#wake(channel);
  }

  async close(runId: string): Promise<void> {
    const channel = this.#channel(runId);
    channel.closed = true;
    this.#wake(channel);
    this.#closedOrder.push(runId);
    this.#evictClosedBeyondCap();
  }

  async *subscribe(runId: string, afterSeq = 0): AsyncIterable<RunFrame> {
    const channel = this.#channel(runId);
    channel.subscribers += 1;
    try {
      let index = 0;
      for (;;) {
        while (index < channel.frames.length) {
          const frame = channel.frames[index];
          index += 1;
          if (frame && frame.seq > afterSeq) yield frame;
        }
        if (channel.closed) return;
        await new Promise<void>((resolve) => channel.waiters.push(resolve));
      }
    } finally {
      channel.subscribers -= 1;
    }
  }
}
