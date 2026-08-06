// Redis-backed run event bus: fans a run's stream frames across instances so a client connected
// to instance B can join a run executing on instance A. Each run's frames go to a Redis Stream
// (durable replay for late joiners / reconnects) *and* a pub/sub channel (live-tail). Subscribers
// SUBSCRIBE before replaying the stream, then dedupe by `seq`, so no frame slips through the gap
// between the snapshot and the live feed (see docs/streaming.md).

import type { RunEventBus, RunFrame } from "@skein-js/core";
import { Redis, type RedisOptions } from "ioredis";

import { closeConnection } from "./redis-connection.js";

/** How ioredis clients are created. Injected so fan-out can be tested without a server. */
export type RedisClientFactory = (url: string, options?: RedisOptions) => Redis;

/** Options for {@link RedisRunEventBus} — key namespacing and stream/close-marker retention windows. */
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
   * Backstop interval (ms) for a live-tailing subscriber re-checking whether its run has closed.
   *
   * Not the primary mechanism: `close()` publishes a terminal message on the run's channel, a
   * subscriber attaches before it snapshots the stream, and the close marker also lives *in* the
   * stream — so a normal close is observed immediately, and a run that closed before the subscriber
   * arrived is caught by the one eager check it makes before live-tailing. What remains is a `PUBLISH`
   * lost to a pub/sub connection drop, which the `ready` handler also pokes. This interval only bounds
   * the stall if all of that fails. Default 30000ms, jittered ±50%.
   */
  closedCheckIntervalMs?: number;
  /**
   * Approximate cap on a run's stream, in frames. Bounds what one run costs in Redis, which the TTL
   * alone does not: a chatty graph can produce a very large stream well inside an hour. Default
   * 10000; `0` disables trimming and keeps the pre-existing TTL-only behaviour.
   */
  streamMaxLen?: number;
  /**
   * Frames a single subscriber may have queued from pub/sub before it is considered too far behind
   * and its stream is ended. Default 512.
   */
  subscriberBufferFrames?: number;
  /** How ioredis clients are created. Defaults to `new Redis(url, options)`. */
  createClient?: RedisClientFactory;
}

const DEFAULT_STREAM_TTL_SECONDS = 3600;
const DEFAULT_CLOSED_MARKER_TTL_SECONDS = 86_400;
/**
 * 30s, not 1s.
 *
 * At 1s every *idle* subscriber armed a timer and issued an `EXISTS` every second — on `#commands`, the
 * same connection `publish` pipelines through, so 500 idle streams put 500 commands/s of head-of-line
 * contention in front of the frame path. It cost frame latency, not just CPU.
 *
 * What made that interval look necessary was the belief that a close could be missed in the window
 * between subscribing and snapshotting the stream. It cannot: `#attach` awaits `SUBSCRIBE` *before*
 * `#replayFrom` reads, and `close()` pipelines the stream's `XADD` before the `SET` of the marker — so a
 * close either arrives live or is already in the replay. The genuinely uncovered case is a `PUBLISH`
 * lost while the shared pub/sub connection reconnects, and that is what the `ready` poke and this
 * backstop are for.
 */
const DEFAULT_CLOSED_CHECK_INTERVAL_MS = 30_000;
/**
 * Jitter applied to each wait, as a fraction of the interval (±50%).
 *
 * Without it, subscribers that attached in one burst — which is what a fan-out of SSE clients is — stay
 * in phase and fire their checks together, turning a steady trickle of `EXISTS` into a periodic
 * thundering herd on the connection that also carries every `publish`.
 */
const CLOSED_CHECK_JITTER = 0.5;
const DEFAULT_STREAM_MAX_LEN = 10_000;
const DEFAULT_SUBSCRIBER_BUFFER_FRAMES = 512;
/**
 * Frames read per `XRANGE` page during replay. Large enough that an ordinary run replays in one or
 * two round trips, small enough that a 10k-frame stream is never materialised whole.
 */
const REPLAY_PAGE_SIZE = 500;
const FRAME_FIELD = "f";
const CLOSE_FIELD = "close";
/** Resolved by the periodic wake-up that races the live-tail so a closed-but-quiet run completes. */
const CHECK_TICK = Symbol("check-tick");

/** A pub/sub message: either the next frame or the run's terminal marker. */
type ChannelMessage = { type: "frame"; frame: RunFrame } | { type: "close" };

/**
 * An `XRANGE` start that resumes strictly after `lastId`.
 *
 * `-` means "nothing has been read yet" and must be passed through: Redis rejects `(-` outright with
 * "Invalid stream ID", which is how a resume on an empty stream — a run whose frames have expired —
 * would otherwise fail.
 */
function exclusiveFrom(lastId: string): string {
  return lastId === "-" ? "-" : `(${lastId}`;
}

/**
 * Surface the first failure in a pipeline's results.
 *
 * `pipeline.exec()` resolves with `[error, result]` per command instead of rejecting, so discarding
 * its return value would swallow a failed XADD — a frame silently not persisted — where the previous
 * sequentially-awaited version would have thrown. Pipelining must not cost error visibility.
 */
function throwFirstPipelineError(results: Array<[Error | null, unknown]> | null): void {
  for (const [error] of results ?? []) {
    if (error) throw error;
  }
}

/**
 * An async mailbox feeding one subscriber's live-tail loop from the shared pub/sub handler.
 *
 * Bounded. `push` is called synchronously from ioredis's `message` event, which cannot be paused, so
 * a subscriber slower than the publisher accumulates frames here with nothing to stop it — one
 * stalled SSE client would otherwise hold the whole run's output in memory. On overflow the mailbox
 * gives up rather than growing: the subscriber ends its stream and the client reconnects with
 * `Last-Event-ID`, replaying from the durable stream, which is exactly what that stream is for.
 */
class MessageMailbox {
  readonly #buffer: ChannelMessage[] = [];
  readonly #capacity: number;
  #overflowed = false;
  #wake?: () => void;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  /** True once this mailbox has dropped a message; its subscriber must stop. */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  push(message: ChannelMessage): void {
    if (this.#buffer.length >= this.#capacity) {
      this.#overflowed = true;
      // Wake the reader so it observes the overflow promptly rather than at the next tick.
      this.#wake?.();
      this.#wake = undefined;
      return;
    }
    this.#buffer.push(message);
    this.#wake?.();
    this.#wake = undefined;
  }

  /** The next message if one is already queued, without awaiting — the common case under load. */
  takeBuffered(): ChannelMessage | undefined {
    return this.#buffer.shift();
  }

  /**
   * Wake the reader without delivering a message, so it re-runs its close check now.
   *
   * Used when the shared pub/sub connection reconnects: a `PUBLISH` issued while it was down reached
   * nobody and will never be re-sent, so every subscriber on it has to re-examine whether its run
   * finished. Without this the only recovery is the backstop interval, which is what lets that interval
   * be 30s instead of 1s.
   */
  poke(): void {
    this.#wake?.();
    this.#wake = undefined;
  }

  /** Resolves once at least one message has arrived (or the mailbox overflowed). */
  waitForMessage(): Promise<void> {
    if (this.#buffer.length > 0 || this.#overflowed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
  }
}

/** Redis `RunEventBus` with cross-instance fan-out. Owns its connections; call {@link dispose}. */
export class RedisRunEventBus implements RunEventBus {
  readonly #commands: Redis;
  readonly #url: string;
  readonly #createClient: RedisClientFactory;
  readonly #prefix: string;
  readonly #streamTtlSeconds: number;
  readonly #closedMarkerTtlSeconds: number;
  readonly #closedCheckIntervalMs: number;
  readonly #streamMaxLen: number;
  readonly #subscriberBufferFrames: number;

  /**
   * One pub/sub connection for the whole bus, with the mailboxes listening on each channel.
   *
   * Previously every `subscribe()` opened its own connection, so an instance serving N concurrent SSE
   * streams held N Redis sockets — 500 streams, 500 handshakes and 500 ioredis command queues. Redis
   * multiplexes any number of channels over one connection, so this is a `SUBSCRIBE` per run instead.
   */
  #pubsub?: Redis;
  #disposed = false;
  readonly #mailboxesByChannel = new Map<string, Set<MessageMailbox>>();
  /** In-flight or settled SUBSCRIBE per channel, so every reader can await the same one. */
  readonly #subscriptions = new Map<string, Promise<unknown>>();

  constructor(url: string, options: RedisRunEventBusOptions = {}) {
    this.#url = url;
    this.#createClient = options.createClient ?? ((target, opts) => new Redis(target, opts ?? {}));
    // Lazy: constructing a bus must not open a socket. A bus that is built and then disposed without
    // ever being used — a failed `embedPostgresGraphs` assembly, a process that exits early — then
    // has no handshake to orphan. See `closeConnection`.
    this.#commands = this.#createClient(url, { lazyConnect: true });
    this.#prefix = options.keyPrefix ?? "skein";
    this.#streamTtlSeconds = options.streamTtlSeconds ?? DEFAULT_STREAM_TTL_SECONDS;
    this.#closedMarkerTtlSeconds =
      options.closedMarkerTtlSeconds ?? DEFAULT_CLOSED_MARKER_TTL_SECONDS;
    this.#closedCheckIntervalMs = options.closedCheckIntervalMs ?? DEFAULT_CLOSED_CHECK_INTERVAL_MS;
    this.#streamMaxLen = options.streamMaxLen ?? DEFAULT_STREAM_MAX_LEN;
    this.#subscriberBufferFrames =
      options.subscriberBufferFrames ?? DEFAULT_SUBSCRIBER_BUFFER_FRAMES;
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

  /**
   * The backstop interval with ±{@link CLOSED_CHECK_JITTER} applied, so subscribers that attached
   * together do not check together. Floored at 1ms: a test configuring a very small interval must still
   * get a real timer rather than a `setTimeout(0)` busy loop.
   */
  #nextClosedCheckDelayMs(): number {
    const spread = this.#closedCheckIntervalMs * CLOSED_CHECK_JITTER;
    return Math.max(
      1,
      Math.round(this.#closedCheckIntervalMs - spread + Math.random() * spread * 2),
    );
  }

  /**
   * Publish a frame: one pipelined round trip instead of three sequential ones.
   *
   * This sits inside the graph's own iteration — the run engine awaits it per chunk — so at token
   * granularity the old three-await version cost three round trips per token, with the graph unable
   * to advance until all three landed. `XADD` and `PUBLISH` are pipelined together and the frame is
   * serialized once for both.
   */
  async publish(runId: string, frame: RunFrame): Promise<void> {
    const streamKey = this.#streamKey(runId);
    const encoded = JSON.stringify(frame);
    const pipeline = this.#commands.pipeline();

    if (this.#streamMaxLen > 0) {
      // Approximate trimming (`~`): Redis trims on whole-node boundaries, which is near-free, where
      // exact trimming walks the stream on every append.
      pipeline.xadd(streamKey, "MAXLEN", "~", this.#streamMaxLen, "*", FRAME_FIELD, encoded);
    } else {
      pipeline.xadd(streamKey, "*", FRAME_FIELD, encoded);
    }
    // Refreshed on every frame, not periodically. Once XADD and PUBLISH are pipelined, one more
    // command in the same batch costs no extra round trip — and the round trips were the whole
    // problem. Refreshing every N frames instead would leave a slow run (a frame every half-minute,
    // say) to outlive its own TTL, at which point the next XADD recreates the key with no expiry at
    // all and the stream leaks in Redis permanently.
    pipeline.expire(streamKey, this.#streamTtlSeconds);
    // Concatenated rather than re-stringified: `JSON.stringify` always returns well-formed JSON, so
    // embedding it in a value position is safe and saves encoding the frame a second time.
    pipeline.publish(this.#channelKey(runId), `{"type":"frame","frame":${encoded}}`);

    throwFirstPipelineError(await pipeline.exec());
  }

  async close(runId: string): Promise<void> {
    const streamKey = this.#streamKey(runId);
    const pipeline = this.#commands.pipeline();
    // The terminal marker lives in the stream too, so a late joiner replaying the stream also completes.
    pipeline.xadd(streamKey, "*", CLOSE_FIELD, "1");
    // Always refreshed here, whatever the frame count did: this is the point the retention window
    // needs to start from.
    pipeline.expire(streamKey, this.#streamTtlSeconds);
    // A durable "closed" marker that outlives the frame stream, so a subscriber joining after the
    // stream has expired still learns the run finished instead of live-tailing forever.
    pipeline.set(this.#closedKey(runId), "1", "EX", this.#closedMarkerTtlSeconds);
    pipeline.publish(this.#channelKey(runId), '{"type":"close"}');
    throwFirstPipelineError(await pipeline.exec());
  }

  /** The shared pub/sub connection, opened on first use. */
  #pubsubConnection(): Redis {
    if (this.#disposed) {
      throw new Error("RedisRunEventBus was disposed; cannot open a new subscription.");
    }
    if (this.#pubsub) return this.#pubsub;
    const connection = this.#createClient(this.#url);
    connection.on("message", (channel: string, payload: string) => {
      const mailboxes = this.#mailboxesByChannel.get(channel);
      if (!mailboxes || mailboxes.size === 0) return;
      // Parsed once for every subscriber on the channel rather than once each.
      const message = JSON.parse(payload) as ChannelMessage;
      for (const mailbox of mailboxes) mailbox.push(message);
    });
    // A `PUBLISH` issued while this connection was down reached nobody, and pub/sub has no redelivery —
    // so on every reconnect (ioredis re-`SUBSCRIBE`s automatically, but the gap's messages are gone)
    // wake every subscriber to re-run its close check immediately. Without this the only recovery is the
    // backstop interval, and it is what makes a 30s backstop acceptable instead of a 1s poll.
    connection.on("ready", () => {
      for (const mailboxes of this.#mailboxesByChannel.values()) {
        for (const mailbox of mailboxes) mailbox.poke();
      }
    });
    this.#pubsub = connection;
    return connection;
  }

  /**
   * Attach a mailbox to a channel and wait until the channel is actually subscribed.
   *
   * **Every** reader awaits, not only the first. The subscription is shared, so it is tempting to
   * return early for later readers — but SUBSCRIBE takes a round trip, and a reader that skips the
   * wait replays the stream and starts live-tailing while its own subscription is still in flight.
   * Frames published in that window are appended to the stream but their PUBLISH never reaches this
   * connection, and a later live frame advances `lastSeq` past them, so the close sweep's
   * `seq > lastSeq` filter discards them for good: silent frame loss for the second and subsequent
   * subscribers to a run. Memoizing the promise keeps one SUBSCRIBE per channel while still giving
   * every reader the guarantee the pre-existing per-connection code got for free.
   */
  async #attach(channelKey: string, mailbox: MessageMailbox): Promise<void> {
    const connection = this.#pubsubConnection();
    let mailboxes = this.#mailboxesByChannel.get(channelKey);
    if (!mailboxes) {
      mailboxes = new Set();
      this.#mailboxesByChannel.set(channelKey, mailboxes);
    }
    mailboxes.add(mailbox);

    let subscribed = this.#subscriptions.get(channelKey);
    if (!subscribed) {
      subscribed = connection.subscribe(channelKey);
      // Hold a handler from the moment it is created: if a caller is finalized before SUBSCRIBE
      // resolves (an SSE client that went away), teardown closes the connection and ioredis flushes
      // every in-flight command with "Connection is closed." — with nothing left to catch it, that
      // escapes as an unhandled rejection.
      subscribed.catch(() => undefined);
      this.#subscriptions.set(channelKey, subscribed);
    }
    await subscribed;
  }

  /** Detach a mailbox, unsubscribing once the last reader of a channel is gone. */
  async #detach(channelKey: string, mailbox: MessageMailbox): Promise<void> {
    const mailboxes = this.#mailboxesByChannel.get(channelKey);
    if (!mailboxes) return;
    mailboxes.delete(mailbox);
    if (mailboxes.size > 0) return;
    this.#mailboxesByChannel.delete(channelKey);
    this.#subscriptions.delete(channelKey);
    // Swallowed: a subscriber going away must never surface as an error to the caller, and the
    // connection may already be closing.
    await this.#pubsub?.unsubscribe(channelKey).catch(() => undefined);
  }

  /**
   * Read a run's stream from `startId`, a page at a time, yielding frames newer than `afterSeq`.
   *
   * Paged rather than `XRANGE - +`: that reads and parses every frame of the run into one array, and
   * it was done twice — once on join and again on the close check — so a 10k-frame run paid 20k
   * `JSON.parse` calls and two full copies just to discover, usually, nothing new.
   */
  async *#replayFrom(
    runId: string,
    startId: string,
    afterSeq: number,
    outcome: { lastSeq: number; lastId: string; sawClose: boolean },
  ): AsyncGenerator<RunFrame> {
    let cursor = startId;
    for (;;) {
      const page = await this.#commands.xrange(
        this.#streamKey(runId),
        cursor,
        "+",
        "COUNT",
        REPLAY_PAGE_SIZE,
      );
      if (page.length === 0) return;

      for (const [id, fields] of page) {
        outcome.lastId = id;
        if (fields[0] === CLOSE_FIELD) {
          outcome.sawClose = true;
          return;
        }
        const frame = JSON.parse(fields[1] as string) as RunFrame;
        if (frame.seq > outcome.lastSeq) {
          outcome.lastSeq = frame.seq;
          yield frame;
        }
      }

      if (page.length < REPLAY_PAGE_SIZE) return;
      cursor = exclusiveFrom(outcome.lastId);
    }
  }

  async *subscribe(runId: string, afterSeq = 0): AsyncIterable<RunFrame> {
    const mailbox = new MessageMailbox(this.#subscriberBufferFrames);
    const channelKey = this.#channelKey(runId);
    const outcome = { lastSeq: afterSeq, lastId: "-", sawClose: false };

    try {
      // Subscribe *before* the stream snapshot so any frame published concurrently is captured live
      // (and deduped against the snapshot by seq) rather than lost in the gap.
      await this.#attach(channelKey, mailbox);

      yield* this.#replayFrom(runId, "-", afterSeq, outcome);
      if (outcome.sawClose) return; // run already finished; replay is complete

      // One eager check before live-tailing, which settles the "already finished" case *deterministically*
      // rather than leaving it to a timer.
      //
      // The reasoning is worth keeping, because it is what justifies the 30s backstop below. Reaching
      // here means the replay saw no close entry. If the marker nevertheless exists, then `close()`'s
      // `SET` landed — and since it pipelines the stream `XADD` *before* that `SET`, the `XADD` landed
      // too. So the entry was written and is no longer in the stream: the stream expired. That is a
      // terminal state we can conclude right now, in one round trip, instead of discovering it a second
      // (or thirty) later.
      if ((await this.#commands.exists(this.#closedKey(runId))) === 1) {
        yield* this.#replayFrom(runId, exclusiveFrom(outcome.lastId), afterSeq, outcome);
        return;
      }

      // Live-tail. A message already queued is taken without arming anything; only an idle wait arms the
      // backstop check, which now covers just one case — a terminal `PUBLISH` lost while the shared
      // pub/sub connection was reconnecting (the `ready` handler pokes every mailbox for the same
      // reason, so this is the second line of defence, not the first).
      for (;;) {
        const buffered = mailbox.takeBuffered();
        if (buffered) {
          if (buffered.type === "close") return;
          if (buffered.frame.seq > outcome.lastSeq) {
            outcome.lastSeq = buffered.frame.seq;
            yield buffered.frame;
          }
          continue;
        }

        if (mailbox.overflowed) {
          // Too far behind to keep up. Ending the stream lets the client reconnect with
          // `Last-Event-ID` and replay from the durable stream, rather than this mailbox growing
          // without bound behind a reader that cannot drain it.
          return;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = new Promise<typeof CHECK_TICK>((resolve) => {
          timer = setTimeout(() => resolve(CHECK_TICK), this.#nextClosedCheckDelayMs());
        });
        const result = await Promise.race([mailbox.waitForMessage(), tick]);
        if (timer) clearTimeout(timer);
        if (result !== CHECK_TICK) continue; // a message landed; take it on the next pass

        if ((await this.#commands.exists(this.#closedKey(runId))) !== 1) continue; // still running

        // Closed and quiet: sweep anything appended since our last read, then finish. Resumed from
        // the last stream id rather than from `-`, so this is a short read and not a second full one.
        yield* this.#replayFrom(runId, exclusiveFrom(outcome.lastId), afterSeq, outcome);
        return;
      }
    } finally {
      await this.#detach(channelKey, mailbox);
    }
  }

  /** Release the bus's connections. (`close(runId)` ends one run; this ends the whole bus.) */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#mailboxesByChannel.clear();
    this.#subscriptions.clear();
    const pubsub = this.#pubsub;
    this.#pubsub = undefined;
    await Promise.all([
      closeConnection(this.#commands),
      pubsub ? closeConnection(pubsub) : Promise.resolve(),
    ]);
  }
}
