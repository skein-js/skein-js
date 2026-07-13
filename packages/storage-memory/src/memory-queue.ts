// Single-process implementations of the run queue + event bus, so `skein dev` needs nothing
// beyond Node. `@skein/redis` provides the cross-instance versions; the run engine talks only
// to the `@skein/core` interfaces, so it is unaware which one it has.

import type { QueuedRun, RunEventBus, RunFrame, RunQueue } from "@skein/core";

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
  /** Live subscriber count, so a fully-drained closed run can be evicted. */
  subscribers: number;
}

/**
 * In-memory fan-out of run frames. Each frame is buffered, so a subscriber that joins late (or
 * reconnects with an `afterSeq`) replays what it missed and then live-tails until the run
 * closes. Buffering also means publish never blocks on a slow consumer.
 */
export class MemoryRunEventBus implements RunEventBus {
  readonly #channels = new Map<string, Channel>();

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

  async publish(runId: string, frame: RunFrame): Promise<void> {
    const channel = this.#channel(runId);
    channel.frames.push(frame);
    this.#wake(channel);
  }

  async close(runId: string): Promise<void> {
    const channel = this.#channel(runId);
    channel.closed = true;
    this.#wake(channel);
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
      // Once a closed run's last subscriber detaches, drop the channel + its buffered frames.
      // (A never-subscribed background run keeps its frames for a later join; the run engine
      // applies retention there. We never evict in close(), so mid-run replay is preserved.)
      channel.subscribers -= 1;
      if (channel.closed && channel.subscribers === 0) this.#channels.delete(runId);
    }
  }
}
