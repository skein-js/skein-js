// Single-process implementations of the run queue + event bus, so `skein dev` needs nothing
// beyond Node. `@skein-js/redis` provides the cross-instance versions; the run engine talks only
// to the `@skein-js/core` interfaces, so it is unaware which one it has.

import type {
  QueuedRun,
  RunConsumer,
  RunConsumerOptions,
  RunEventBus,
  RunFrame,
  RunProcessor,
  RunQueue,
} from "@skein-js/core";

/**
 * In-memory FIFO of background runs, drained by a single-process consumer — all `skein dev` needs.
 * `@skein-js/redis` (BullMQ) provides the durable, cross-instance version; the run worker talks
 * only to the `RunQueue` interface, so it is unaware which one it has.
 */
export class MemoryRunQueue implements RunQueue {
  readonly #items: QueuedRun[] = [];
  /** Resolvers of consumers parked waiting for the next run. */
  readonly #waiters: Array<() => void> = [];
  /**
   * Ids currently *executing* — pulled off {@link #items} but not yet settled.
   *
   * Tracked so {@link enqueue} can dedupe against a run in flight, not just one still waiting.
   * BullMQ's `jobId` covers a job for its whole lifetime (it is removed on completion), and the two
   * drivers are held to one conformance suite, so this driver has to span the same window: without
   * it, re-enqueueing a run the consumer had already picked up would execute it a second time,
   * concurrently with the first.
   */
  readonly #active = new Set<string>();

  async enqueue(run: QueuedRun): Promise<void> {
    // Idempotent on `run_id`, matching the Redis driver's `jobId`: a run already queued or executing
    // is not queued again. That is what lets the cron scheduler's outbox sweep re-enqueue a run it
    // cannot prove reached the queue — BullMQ dedupes on the durable driver, and this does here.
    //
    // A linear scan over the waiting list, deliberately: it holds only runs not yet picked up, and a
    // lookup index would be a second structure to keep in step with `shift`.
    if (this.#active.has(run.run_id)) return;
    if (this.#items.some((queued) => queued.run_id === run.run_id)) return;
    this.#items.push({ ...run });
    this.#waiters.shift()?.(); // wake one parked consumer, if any
  }

  consume(process: RunProcessor, options: RunConsumerOptions = {}): RunConsumer {
    return new MemoryRunConsumer(
      this.#items,
      this.#waiters,
      this.#active,
      process,
      options.concurrency ?? 1,
    );
  }
}

/** Drains a {@link MemoryRunQueue}: pulls runs (parking when empty) and runs up to `concurrency`. */
class MemoryRunConsumer implements RunConsumer {
  #running = true;
  readonly #inFlight = new Set<Promise<void>>();
  readonly #loop: Promise<void>;

  constructor(
    private readonly items: QueuedRun[],
    private readonly waiters: Array<() => void>,
    private readonly active: Set<string>,
    private readonly process: RunProcessor,
    private readonly concurrency: number,
  ) {
    this.#loop = this.#run();
  }

  async #run(): Promise<void> {
    while (this.#running) {
      if (this.#inFlight.size >= this.concurrency) {
        await Promise.race(this.#inFlight);
        continue;
      }
      const next = this.items.shift();
      if (!next) {
        if (!this.#running) break;
        await new Promise<void>((resolve) => this.waiters.push(resolve)); // park until enqueue/close
        continue;
      }
      // Marked active *before* the processor starts and released only once it settles, so the whole
      // in-flight window is covered by `enqueue`'s dedupe — see `MemoryRunQueue.#active`.
      this.active.add(next.run_id);
      const task = this.process(next)
        .catch(() => undefined) // a failed run is the engine's concern; keep draining
        .finally(() => {
          this.active.delete(next.run_id);
          this.#inFlight.delete(task);
        });
      this.#inFlight.add(task);
    }
  }

  async close(force = false): Promise<void> {
    this.#running = false;
    for (const wake of this.waiters.splice(0)) wake(); // unpark the loop so it can exit
    // force: return at once, abandoning in-flight runs (the loop exits on its own once they settle).
    // Awaiting the loop would block on its `Promise.race(this.#inFlight)`, which is exactly what
    // force is meant to skip.
    if (force) return;
    await this.#loop;
    await Promise.all(this.#inFlight);
  }
}

interface Channel {
  frames: RunFrame[];
  closed: boolean;
  /** Resolvers woken whenever a frame is published or the run is closed. */
  waiters: Array<() => void>;
  /** Live subscriber count, so a channel with active readers is never evicted. */
  subscribers: number;
  /**
   * Live read positions, one per subscriber, as indexes into `frames`.
   *
   * Trimming does not consult these to decide *whether* to drop — the cap is hard. It updates them, so
   * that an index taken before a trim still points at the same frame afterwards. A subscriber
   * suspended in `yield` cannot fix its own index, and one left stale would either re-read frames or
   * skip them.
   */
  readers: Set<{ cursor: number }>;
}

/**
 * Closed runs whose frames are kept for late-join replay, by default.
 *
 * Was 1000, which made the memory bus hold a thousand runs' worth of frames — every token of every
 * one of them. Fifty is enough for the reconnect case this exists to serve (a client rejoining a run
 * that just finished) at a fraction of the cost.
 */
export const DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS = 50;

/**
 * Frames a single run's buffer holds before the oldest are dropped, by default.
 *
 * Previously unbounded, which is the more serious of the two: a subscriber reading at client speed
 * (which is what SSE backpressure makes it do) leaves everything it has not read buffered here, so a
 * slow client on a chatty graph pinned the entire run. Frames hold live references to LangGraph
 * chunks, so under `values` mode that is every intermediate copy of the graph's whole state.
 *
 * Deliberately well above what an ordinary run produces: this is the point at which a client that has
 * stopped keeping up begins losing frames, not a level to sit at.
 *
 * Note this is *not* the same rule the Redis driver uses. `RedisRunEventBus` trims its stream by
 * approximate length (`SKEIN_REDIS_STREAM_MAXLEN`) alongside a one-hour key TTL, and — the difference
 * that matters — those frames live outside this process. A far-behind subscriber there overflows its own
 * in-process mailbox and can replay from the durable stream; here the eviction *is* the loss, because
 * this buffer is also the replay log. See docs/performance.md.
 */
export const DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN = 10_000;

/**
 * How long a finished run id is remembered after its frames are gone, so a late join learns the run
 * ended instead of live-tailing forever.
 *
 * 24 hours, deliberately matching `RedisRunEventBus`'s `closedMarkerTtlSeconds`. The two drivers
 * implement one contract and a client must not get a different answer depending on which is
 * configured. Time-based rather than a count: a count bounds the map but makes "does a join complete?"
 * depend on how busy the process has been since, which is not something an operator can reason about.
 */
const DEFAULT_FINISHED_ID_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Hard size backstop on the remembered-id map, independent of the TTL.
 *
 * The TTL bounds it in time; on a busy process 24 hours of run ids is still a lot of them. 100,000
 * ids is a few MB — cheap next to the frame buffers this map replaced — while making the worst case a
 * number rather than a function of throughput.
 */
const MAX_FINISHED_RUN_IDS = 100_000;

/** Tuning for {@link MemoryRunEventBus}. All bound how much a long-lived process can accumulate. */
export interface MemoryRunEventBusOptions {
  /** Closed runs whose frames stay available for late-join replay (LRU). */
  maxRetainedRuns?: number;
  /** Frames one run buffers before the oldest are dropped. */
  maxFramesPerRun?: number;
  /** How long a finished run id is remembered once its frames are gone. Default 24h. */
  finishedIdTtlMs?: number;
  /** Clock, injected so the TTL sweep is testable without waiting a day. Defaults to `Date.now`. */
  now?: () => number;
}

function requirePositiveInteger(optionName: string, value: number): number {
  // Validated in the constructor, not only in `resolveMemoryBusLimits`: this class is public and is
  // constructed directly through `overrides`, where nothing else would check it.
  //
  // Integer, not merely positive. A fractional cap corrupts the stream rather than merely misbehaving:
  // `splice(0, 1.5)` removes one frame while `cursor -= 1.5` shifts by one and a half, so the cursor
  // lands between elements. `frames[2.5]` is `undefined`, which the read loop skips silently — the
  // exact silent hole this design exists to prevent — and the half-step also re-yields a frame the
  // subscriber has already seen.
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(
      `MemoryRunEventBus ${optionName} must be a positive integer (got ${value}).`,
    );
  }
  return value;
}

/**
 * In-memory fan-out of run frames. Each frame is buffered, so a subscriber that joins late (or
 * reconnects with an `afterSeq`) replays what it missed and then live-tails until the run closes.
 * Buffering also means publish never blocks on a slow consumer.
 *
 * **This is not only a dev driver.** `embedPostgresGraphs` falls back to it whenever no Redis URL is
 * configured — a common first production deploy — so the bounds below apply to real traffic. (`skein
 * start` no longer reaches it: the production entrypoint requires Redis. `skein dev` and the embedded
 * path are where it runs now.) The two drivers do not behave identically under a far-behind subscriber;
 * see {@link DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN}.
 *
 * Three things are bounded, in decreasing order of how much they cost:
 *
 * 1. **Frames per run** (`maxFramesPerRun`). Beyond the cap the oldest are dropped. A subscriber that
 *    had not read them ends its stream rather than skipping silently: a gap in `values` mode is a
 *    corrupt client state, whereas an ended stream is something `Last-Event-ID` reconnect handles.
 * 2. **Retained closed runs** (`maxRetainedRuns`). Past the window a closed run's channel is deleted
 *    outright, not blanked.
 * 3. **Remembered ids.** A deleted channel leaves the run id behind for `finishedIdTtlMs` (24h,
 *    matching `RedisRunEventBus`'s closed marker), so a late join to a finished run completes at once
 *    instead of waiting on a freshly created open channel. Past the TTL a join waits. Swept lazily on
 *    close and capped at {@link MAX_FINISHED_RUN_IDS}, so an idle process may answer such a join for
 *    longer than the TTL — later than promised, never earlier.
 */
export class MemoryRunEventBus implements RunEventBus {
  readonly #channels = new Map<string, Channel>();
  /** Closed runs in close order (oldest first), for LRU eviction. A Set, so a double close is one entry. */
  readonly #closedOrder = new Set<string>();
  /** Ids whose channels are gone but which finished recently: run id → when it closed. */
  readonly #finishedRunIds = new Map<string, number>();
  readonly #maxRetainedRuns: number;
  readonly #maxFramesPerRun: number;
  readonly #finishedIdTtlMs: number;
  readonly #now: () => number;

  constructor(options: MemoryRunEventBusOptions = {}) {
    this.#maxRetainedRuns = requirePositiveInteger(
      "maxRetainedRuns",
      options.maxRetainedRuns ?? DEFAULT_MEMORY_BUS_MAX_RETAINED_RUNS,
    );
    this.#maxFramesPerRun = requirePositiveInteger(
      "maxFramesPerRun",
      options.maxFramesPerRun ?? DEFAULT_MEMORY_BUS_MAX_FRAMES_PER_RUN,
    );
    this.#finishedIdTtlMs = requirePositiveInteger(
      "finishedIdTtlMs",
      options.finishedIdTtlMs ?? DEFAULT_FINISHED_ID_TTL_MS,
    );
    this.#now = options.now ?? Date.now;
  }

  /** Channels currently tracked — live runs plus retained closed ones. Diagnostics and tests. */
  get trackedChannelCount(): number {
    return this.#channels.size;
  }

  /** Frames buffered across every channel. The number that must stay bounded under load. */
  get bufferedFrameCount(): number {
    let total = 0;
    for (const channel of this.#channels.values()) total += channel.frames.length;
    return total;
  }

  #channel(runId: string): Channel {
    let channel = this.#channels.get(runId);
    if (!channel) {
      channel = {
        frames: [],
        closed: false,
        waiters: [],
        subscribers: 0,
        readers: new Set(),
      };
      this.#channels.set(runId, channel);
    }
    return channel;
  }

  #wake(channel: Channel): void {
    const waiters = channel.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** Forget a channel entirely, keeping only the knowledge that the run finished, and when. */
  #release(runId: string): void {
    this.#channels.delete(runId);
    this.#closedOrder.delete(runId);
    // Re-inserted so the map stays in expiry order even if a run id is released twice.
    this.#finishedRunIds.delete(runId);
    this.#finishedRunIds.set(runId, this.#now());
    this.#sweepFinishedIds();
  }

  /**
   * Drop remembered ids past their TTL. Swept here rather than on a timer: a `Map` iterates in
   * insertion order and ids are inserted in close order, so the expired ones are always a prefix and
   * the loop stops at the first live entry — O(expired), not O(size).
   */
  #sweepFinishedIds(): void {
    const cutoff = this.#now() - this.#finishedIdTtlMs;
    for (const [runId, closedAt] of this.#finishedRunIds) {
      // Size backstop first: the TTL bounds this map in time but not in size, and a busy process can
      // close far more runs within 24h than it should hold ids for. Dropping the oldest costs only
      // that run's ability to answer a late `join` immediately — the same thing that happens once its
      // TTL expires — whereas an unbounded map is the growth this whole change exists to remove.
      if (this.#finishedRunIds.size > MAX_FINISHED_RUN_IDS) {
        this.#finishedRunIds.delete(runId);
        continue;
      }
      if (closedAt >= cutoff) return;
      this.#finishedRunIds.delete(runId);
    }
  }

  /**
   * Delete the oldest retained closed channels beyond the cap.
   *
   * A channel with live subscribers is mid-replay: leave it, and let the last subscriber's teardown
   * release it. Skipping rather than re-queueing keeps this a single ordered pass.
   */
  #evictClosedBeyondCap(): void {
    for (const runId of this.#closedOrder) {
      if (this.#closedOrder.size <= this.#maxRetainedRuns) return;
      if ((this.#channels.get(runId)?.subscribers ?? 0) > 0) continue;
      this.#release(runId);
    }
  }

  async publish(runId: string, frame: RunFrame): Promise<void> {
    const channel = this.#channel(runId);
    channel.frames.push(frame);
    this.#trim(channel);
    this.#wake(channel);
  }

  /**
   * Keep a channel's buffer within `maxFramesPerRun`.
   *
   * `maxFramesPerRun` is a hard maximum, not a target: whatever an operator sets is what one run can
   * actually cost. Past it the oldest frames go even if a subscriber has not read them, which ends
   * that subscriber's stream.
   *
   * Frames a reader has already consumed are deliberately **not** dropped early. It would free memory
   * sooner, but a run's buffer is also its replay log: `GET /runs/{id}/stream` on a finished run, and
   * a second client joining one in progress, both read frames the first client consumed long ago.
   * Trimming behind the reader would quietly empty that log.
   */
  #trim(channel: Channel): void {
    const overCap = channel.frames.length - this.#maxFramesPerRun;
    if (overCap <= 0) return;

    channel.frames.splice(0, overCap);
    // Every reader's index shifts by what was removed, applied *here* rather than lazily when each
    // generator next resumes. A reader suspended in `yield` would otherwise be left holding an index
    // into an array that has moved underneath it. A negative result means frames this reader had not
    // reached are gone; its generator detects that when it wakes and ends the stream.
    for (const reader of channel.readers) reader.cursor -= overCap;
  }

  async close(runId: string): Promise<void> {
    const channel = this.#channel(runId);
    channel.closed = true;
    this.#wake(channel);
    this.#closedOrder.add(runId);
    // A run that produced nothing has nothing to replay, so it need not occupy a retention slot.
    // Anything with frames stays until the LRU window pushes it out: `GET /runs/{id}/stream` on a
    // finished run is a supported call, and releasing eagerly once the last subscriber detached
    // would break it for exactly the common case — a client that streamed the run to completion.
    if (channel.frames.length === 0 && channel.subscribers === 0) this.#release(runId);
    else this.#evictClosedBeyondCap();
  }

  async *subscribe(runId: string, afterSeq = 0): AsyncIterable<RunFrame> {
    // A run whose channel is gone but which is known to have finished: nothing left to replay, and
    // waiting would hang. Checked before `#channel`, which would otherwise create an open channel.
    if (!this.#channels.has(runId) && this.#finishedRunIds.has(runId)) return;

    const channel = this.#channel(runId);
    channel.subscribers += 1;
    // Published so `#trim` can see how far this subscriber has got and avoid dropping frames it still
    // needs. A shared object rather than a returned value because trimming happens in `publish`,
    // concurrently with this generator being suspended.
    const position = { cursor: 0 };
    channel.readers.add(position);
    try {
      for (;;) {
        // `#trim` keeps this index current, so it is always a valid position in the live array. A
        // negative value is the one thing it cannot fix: frames this subscriber had not read were
        // dropped, which happens only when it stalled past the hard ceiling. Ending the stream lets
        // the client reconnect from its last id; reading on would hand it a silent hole in the
        // sequence, which under `values` mode is a corrupt view of the graph's state.
        if (position.cursor < 0) return;
        if (position.cursor < channel.frames.length) {
          const frame = channel.frames[position.cursor];
          position.cursor += 1;
          if (frame && frame.seq > afterSeq) yield frame;
          continue;
        }
        if (channel.closed) return;
        await new Promise<void>((resolve) => channel.waiters.push(resolve));
      }
    } finally {
      channel.subscribers -= 1;
      // Dropped first: a departed reader must stop holding frames back, or one abandoned subscription
      // would keep a run's whole output pinned for the rest of its life.
      channel.readers.delete(position);
      if (channel.subscribers === 0) {
        if (channel.frames.length === 0) {
          // No frames means nothing a later `join` could replay, so this channel carries no
          // information whether or not it closed. That covers the doomed-subscriber case: `subscribe`
          // has to create a channel to wait on for a run id the bus has not seen — one executing on
          // another instance, or finished past its TTL — and leaving those behind would grow the map
          // on exactly the path this bounding work exists to close.
          if (channel.closed) this.#release(runId);
          else this.#channels.delete(runId);
        } else if (channel.closed) {
          // Deliberately does *not* release a closed channel that still holds frames. Detaching from
          // a finished run is the normal end of every stream, and dropping its frames then would make
          // a subsequent `join` replay nothing — the retention window exists precisely to serve that
          // call. Eviction is the LRU's job; this only re-runs it, since a channel skipped earlier
          // for having a live reader may now be free to go.
          this.#evictClosedBeyondCap();
        }
      }
    }
  }
}
