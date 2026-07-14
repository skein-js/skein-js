// Redis-backed run event bus: fans a run's stream frames across instances so a client connected
// to instance B can join a run executing on instance A. Each run's frames go to a Redis Stream
// (durable replay for late joiners / reconnects) *and* a pub/sub channel (live-tail). Subscribers
// SUBSCRIBE before replaying the stream, then dedupe by `seq`, so no frame slips through the gap
// between the snapshot and the live feed (see docs/streaming.md).

import type { RunEventBus, RunFrame } from "@skein-js/core";
import { Redis } from "ioredis";

export interface RedisRunEventBusOptions {
  /** Namespaces every key so multiple apps can share one Redis. Default `"skein"`. */
  keyPrefix?: string;
  /** How long a run's frame stream is retained for late-join replay (seconds). Default 3600. */
  streamTtlSeconds?: number;
  /**
   * How long a run's "closed" marker is retained (seconds). It outlives the frame stream so a
   * subscriber joining after the stream has expired still learns the run finished (and completes)
   * instead of live-tailing forever. Default 86400 (24h).
   */
  closedMarkerTtlSeconds?: number;
  /**
   * How often a live-tailing subscriber re-checks whether the run has closed, in case the terminal
   * pub/sub message was missed (e.g. it joined after the run closed). Default 1000ms.
   */
  closedCheckIntervalMs?: number;
}

const DEFAULT_STREAM_TTL_SECONDS = 3600;
const DEFAULT_CLOSED_MARKER_TTL_SECONDS = 86_400;
const DEFAULT_CLOSED_CHECK_INTERVAL_MS = 1000;
const FRAME_FIELD = "f";
const CLOSE_FIELD = "close";
/** Resolved by the periodic wake-up that races the live-tail so a closed-but-quiet run completes. */
const CHECK_TICK = Symbol("check-tick");

/** A pub/sub message: either the next frame or the run's terminal marker. */
type ChannelMessage = { type: "frame"; frame: RunFrame } | { type: "close" };

/** A one-slot async mailbox feeding the live-tail loop from the pub/sub `message` handler. */
class MessageMailbox {
  readonly #buffer: ChannelMessage[] = [];
  #wake?: () => void;

  push(message: ChannelMessage): void {
    this.#buffer.push(message);
    this.#wake?.();
    this.#wake = undefined;
  }

  async next(): Promise<ChannelMessage> {
    const ready = this.#buffer.shift();
    if (ready) return ready;
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    // A push resolved us; exactly one message is now buffered.
    return this.#buffer.shift() as ChannelMessage;
  }
}

/** Redis `RunEventBus` with cross-instance fan-out. Owns its command connection; call {@link close}. */
export class RedisRunEventBus implements RunEventBus {
  readonly #commands: Redis;
  readonly #url: string;
  readonly #prefix: string;
  readonly #streamTtlSeconds: number;
  readonly #closedMarkerTtlSeconds: number;
  readonly #closedCheckIntervalMs: number;

  constructor(url: string, options: RedisRunEventBusOptions = {}) {
    this.#url = url;
    this.#commands = new Redis(url);
    this.#prefix = options.keyPrefix ?? "skein";
    this.#streamTtlSeconds = options.streamTtlSeconds ?? DEFAULT_STREAM_TTL_SECONDS;
    this.#closedMarkerTtlSeconds =
      options.closedMarkerTtlSeconds ?? DEFAULT_CLOSED_MARKER_TTL_SECONDS;
    this.#closedCheckIntervalMs = options.closedCheckIntervalMs ?? DEFAULT_CLOSED_CHECK_INTERVAL_MS;
  }

  #streamKey(runId: string): string {
    return `${this.#prefix}:runs:stream:${runId}`;
  }

  #channelKey(runId: string): string {
    return `${this.#prefix}:runs:chan:${runId}`;
  }

  #closedKey(runId: string): string {
    return `${this.#prefix}:runs:closed:${runId}`;
  }

  async publish(runId: string, frame: RunFrame): Promise<void> {
    const streamKey = this.#streamKey(runId);
    await this.#commands.xadd(streamKey, "*", FRAME_FIELD, JSON.stringify(frame));
    await this.#commands.expire(streamKey, this.#streamTtlSeconds);
    await this.#commands.publish(this.#channelKey(runId), JSON.stringify({ type: "frame", frame }));
  }

  async close(runId: string): Promise<void> {
    const streamKey = this.#streamKey(runId);
    // The terminal marker lives in the stream too, so a late joiner replaying the stream also completes.
    await this.#commands.xadd(streamKey, "*", CLOSE_FIELD, "1");
    await this.#commands.expire(streamKey, this.#streamTtlSeconds);
    // A durable "closed" marker that outlives the frame stream, so a subscriber joining after the
    // stream has expired still learns the run finished instead of live-tailing forever.
    await this.#commands.set(this.#closedKey(runId), "1", "EX", this.#closedMarkerTtlSeconds);
    await this.#commands.publish(this.#channelKey(runId), JSON.stringify({ type: "close" }));
  }

  async *subscribe(runId: string, afterSeq = 0): AsyncIterable<RunFrame> {
    const mailbox = new MessageMailbox();
    const subscriber = new Redis(this.#url);
    const channelKey = this.#channelKey(runId);
    subscriber.on("message", (_channel: string, payload: string) => {
      mailbox.push(JSON.parse(payload) as ChannelMessage);
    });

    let lastSeq = afterSeq;
    try {
      // Subscribe *before* the stream snapshot so any frame published concurrently is captured live
      // (and deduped against the snapshot by seq) rather than lost in the gap.
      await subscriber.subscribe(channelKey);

      // Replay the stream for anything already published (past frames for a late joiner / reconnect).
      const entries = await this.#commands.xrange(this.#streamKey(runId), "-", "+");
      for (const [, fields] of entries) {
        if (fields[0] === CLOSE_FIELD) return; // run already finished; replay is complete
        const frame = JSON.parse(fields[1] as string) as RunFrame;
        if (frame.seq > lastSeq) {
          lastSeq = frame.seq;
          yield frame;
        }
      }

      // Live-tail. Race each wait against a periodic tick: if no message arrives and the run has
      // since closed (its terminal message was missed, or its stream already expired), drain any
      // final frames and finish — rather than blocking forever. `pending` is held across ticks so
      // only one mailbox waiter is ever outstanding.
      let pending = mailbox.next();
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<typeof CHECK_TICK>((resolve) => {
          timer = setTimeout(() => resolve(CHECK_TICK), this.#closedCheckIntervalMs);
        });
        const result = await Promise.race([pending, tick]);
        if (timer) clearTimeout(timer);

        if (result === CHECK_TICK) {
          if ((await this.#commands.exists(this.#closedKey(runId))) === 1) {
            // Belt and suspenders: yield any frame added after our snapshot that we never saw live.
            const stragglers = await this.#commands.xrange(this.#streamKey(runId), "-", "+");
            for (const [, fields] of stragglers) {
              if (fields[0] === CLOSE_FIELD) continue;
              const frame = JSON.parse(fields[1] as string) as RunFrame;
              if (frame.seq > lastSeq) {
                lastSeq = frame.seq;
                yield frame;
              }
            }
            return;
          }
          continue; // still active — keep waiting on the same `pending`
        }

        pending = mailbox.next(); // consumed a message; arm the next wait
        if (result.type === "close") return;
        if (result.frame.seq > lastSeq) {
          lastSeq = result.frame.seq;
          yield result.frame;
        }
      }
    } finally {
      subscriber.disconnect();
    }
  }

  /** Release the command connection. (`close(runId)` ends one run; this ends the whole bus.) */
  async dispose(): Promise<void> {
    await this.#commands.quit();
  }
}
