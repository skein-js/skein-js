import type { RunFrame } from "@skein-js/core";
import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import { RedisRunEventBus } from "./redis-run-event-bus.js";

// These assert on command counts, not on timing or memory: integers, so there is nothing to flake.
// The `createClient` seam exists for the shared-connection fan-out and doubles as the test seam, so
// the wire-level behaviour is checkable without a container. The integration suite next door covers
// what a fake cannot — real replay ordering, MAXLEN trimming, and reconnect resubscribe.

const frame = (seq: number): RunFrame => ({ seq, event: "values", data: { seq } });

/** Records every command issued, including the ones batched into a pipeline. */
function fakeRedis(options: { deferSubscribe?: boolean } = {}) {
  const commands: string[][] = [];
  /** Held SUBSCRIBE resolvers, so a test can assert what happens while one is outstanding. */
  const pendingSubscribes: Array<() => void> = [];
  /** Channels the shared connection is subscribed to — the fake's half of the routing contract. */
  const subscribed = new Set<string>();
  const record = (...args: unknown[]): void => {
    commands.push(args.map(String));
  };

  const clients: FakeClient[] = [];
  const channelHandlers: Array<(channel: string, payload: string) => void> = [];

  interface FakeClient {
    pipeline(): FakePipeline;
    xrange(...args: unknown[]): Promise<Array<[string, string[]]>>;
    exists(...args: unknown[]): Promise<number>;
    subscribe(channel: string): Promise<number>;
    unsubscribe(channel: string): Promise<number>;
    on(event: string, listener: (...args: never[]) => void): FakeClient;
    off(): FakeClient;
    once(): FakeClient;
    quit(): Promise<string>;
    disconnect(): void;
    status: string;
  }

  interface FakePipeline {
    xadd(...args: unknown[]): FakePipeline;
    expire(...args: unknown[]): FakePipeline;
    publish(...args: unknown[]): FakePipeline;
    set(...args: unknown[]): FakePipeline;
    exec(): Promise<unknown[]>;
  }

  const makeClient = (): FakeClient => {
    const pipeline: FakePipeline = {
      xadd: (...args) => (record("xadd", ...args), pipeline),
      expire: (...args) => (record("expire", ...args), pipeline),
      publish: (...args) => (record("publish", ...args), pipeline),
      set: (...args) => (record("set", ...args), pipeline),
      exec: async () => {
        record("exec");
        return [];
      },
    };

    const client: FakeClient = {
      pipeline: () => pipeline,
      xrange: async (...args) => {
        record("xrange", ...args);
        return [];
      },
      exists: async (...args) => {
        record("exists", ...args);
        return 0;
      },
      subscribe: async (channel) => {
        record("subscribe", channel);
        if (options.deferSubscribe) {
          await new Promise<void>((resolve) => pendingSubscribes.push(resolve));
        }
        subscribed.add(channel);
        return 1;
      },
      unsubscribe: async (channel) => {
        record("unsubscribe", channel);
        subscribed.delete(channel);
        return 0;
      },
      on: (event, listener) => {
        if (event === "message") {
          channelHandlers.push(listener as unknown as (c: string, p: string) => void);
        }
        return client;
      },
      off: () => client,
      once: () => client,
      quit: async () => "OK",
      disconnect: () => undefined,
      status: "ready",
    };
    clients.push(client);
    return client;
  };

  return {
    commands,
    clients,
    /**
     * Deliver a pub/sub message as the real connection's `message` handler would — only for a channel
     * the connection is actually subscribed to, so the bus's own channel→mailbox routing is what
     * decides who sees it.
     */
    deliver: (channel: string, message: unknown) => {
      if (!subscribed.has(channel)) return;
      for (const handler of channelHandlers) handler(channel, JSON.stringify(message));
    },
    /** Let every outstanding SUBSCRIBE resolve. */
    settleSubscribes: () => {
      while (pendingSubscribes.length > 0) pendingSubscribes.shift()?.();
    },
    createClient: (() => makeClient() as unknown as Redis) as never,
    countOf: (name: string) => commands.filter((entry) => entry[0] === name).length,
  };
}

describe("RedisRunEventBus.publish", () => {
  it("issues one pipelined round trip per frame instead of three sequential commands", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    await bus.publish("r", frame(2));

    // XADD + PUBLISH batched into a single exec. Previously this was three awaited round trips,
    // inline in the graph's own loop, so a token stream paid three per token.
    expect(redis.countOf("exec")).toBe(1);
    expect(redis.countOf("xadd")).toBe(1);
    expect(redis.countOf("publish")).toBe(1);
  });

  it("refreshes the stream TTL inside the same pipeline, so it costs no extra round trip", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    for (let seq = 1; seq <= 300; seq += 1) await bus.publish("r", frame(seq));

    // Every frame refreshes it, but there is still one exec per frame. Refreshing only every N frames
    // would let a slow run outlive its own TTL, after which the next XADD recreates the key with no
    // expiry at all and the stream leaks in Redis forever.
    expect(redis.countOf("expire")).toBe(300);
    expect(redis.countOf("exec")).toBe(300);
  });

  it("bounds the stream with approximate MAXLEN trimming", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", {
      createClient: redis.createClient,
      streamMaxLen: 1234,
    });

    await bus.publish("r", frame(1));

    const xadd = redis.commands.find((entry) => entry[0] === "xadd");
    // `~` is what makes trimming near-free: Redis trims whole nodes rather than walking the stream.
    expect(xadd?.slice(0, 5)).toEqual(["xadd", "skein:runs:stream:r", "MAXLEN", "~", "1234"]);
  });

  it("leaves the stream untrimmed when MAXLEN is disabled", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", {
      createClient: redis.createClient,
      streamMaxLen: 0,
    });

    await bus.publish("r", frame(1));

    const xadd = redis.commands.find((entry) => entry[0] === "xadd");
    expect(xadd?.[2]).not.toBe("MAXLEN");
  });

  it("serializes each frame once, not once per destination", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    await bus.publish("r", frame(7));

    const xadd = redis.commands.find((entry) => entry[0] === "xadd");
    const publish = redis.commands.find((entry) => entry[0] === "publish");
    const encoded = JSON.stringify(frame(7));
    expect(xadd?.at(-1)).toBe(encoded);
    // The published payload embeds the identical string rather than re-stringifying the frame.
    expect(publish?.at(-1)).toBe(`{"type":"frame","frame":${encoded}}`);
  });
});

describe("RedisRunEventBus.subscribe", () => {
  /**
   * Start a subscription and let it attach and finish its (empty) replay, leaving it live-tailing.
   *
   * The first `next()` is what runs the generator body at all — an async generator does nothing until
   * pulled — so it must be called, and must not be awaited, since nothing will be published.
   */
  async function attach(iterable: AsyncIterable<RunFrame>): Promise<{ stop: () => void }> {
    const iterator = iterable[Symbol.asyncIterator]();
    const pending = iterator.next();
    pending.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { stop: () => void iterator.return?.(undefined) };
  }

  it("multiplexes every subscriber over one connection", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    const readers = await Promise.all(
      Array.from({ length: 200 }, (_unused, index) => attach(bus.subscribe(`run-${index}`))),
    );

    // One command connection plus one shared pub/sub connection. Previously this was 1 + 200:
    // a socket, a handshake and an ioredis command queue per in-flight SSE stream.
    expect(redis.clients).toHaveLength(2);
    expect(redis.countOf("subscribe")).toBe(200); // one per channel, all on the same connection
    for (const reader of readers) reader.stop();
  });

  it("subscribes once for a channel however many readers join it", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    const first = await attach(bus.subscribe("r"));
    const second = await attach(bus.subscribe("r"));
    const third = await attach(bus.subscribe("r"));

    expect(redis.countOf("subscribe")).toBe(1);
    first.stop();
    second.stop();
    third.stop();
  });

  it("fans one delivered message out to every reader on the channel", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    const first = bus.subscribe("r")[Symbol.asyncIterator]();
    const second = bus.subscribe("r")[Symbol.asyncIterator]();
    const firstFrame = first.next();
    const secondFrame = second.next();
    // Let both attach and finish their (empty) replay before anything is delivered.
    await new Promise((resolve) => setTimeout(resolve, 0));

    redis.deliver("skein:runs:chan:r", { type: "frame", frame: frame(1) });

    expect((await firstFrame).value).toMatchObject({ seq: 1 });
    expect((await secondFrame).value).toMatchObject({ seq: 1 });
    void first.return?.(undefined);
    void second.return?.(undefined);
  });

  it("makes every reader wait for the channel's subscription, not just the first", async () => {
    // The regression this guards is silent and only hits the *second* subscriber to a run. Sharing one
    // subscription tempts an early return for later readers, but SUBSCRIBE costs a round trip: a
    // reader that skips the wait starts live-tailing before its subscription exists, misses whatever
    // is published in that window, and then has those frames filtered out of the close sweep by
    // `seq > lastSeq`. Asserted by making SUBSCRIBE take a turn to resolve and checking that a
    // second attach has not proceeded until it does.
    const redis = fakeRedis({ deferSubscribe: true });
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    const first = bus.subscribe("r")[Symbol.asyncIterator]();
    const second = bus.subscribe("r")[Symbol.asyncIterator]();
    void first.next().catch(() => undefined);
    void second.next().catch(() => undefined);
    await Promise.resolve();

    // Neither may have reached its replay while SUBSCRIBE is outstanding.
    expect(redis.countOf("xrange")).toBe(0);

    redis.settleSubscribes();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Both proceeded, and only one SUBSCRIBE was issued for the shared channel.
    expect(redis.countOf("xrange")).toBe(2);
    expect(redis.countOf("subscribe")).toBe(1);
    void first.return?.(undefined);
    void second.return?.(undefined);
  });

  it("delivers a channel's messages only to that channel's readers", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    const mine = bus.subscribe("mine")[Symbol.asyncIterator]();
    const other = bus.subscribe("other")[Symbol.asyncIterator]();
    const minePending = mine.next();
    let otherReceived: unknown;
    void other.next().then((next) => {
      otherReceived = next.value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    redis.deliver("skein:runs:chan:mine", { type: "frame", frame: frame(1) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await minePending).value).toMatchObject({ seq: 1 });
    expect(otherReceived).toBeUndefined(); // a crossed channel→mailbox mapping would leak here
    void mine.return?.(undefined);
    void other.return?.(undefined);
  });

  it("pages the replay instead of reading the whole stream at once", async () => {
    const redis = fakeRedis();
    const bus = new RedisRunEventBus("redis://x", { createClient: redis.createClient });

    const reader = await attach(bus.subscribe("r"));

    const xrange = redis.commands.find((entry) => entry[0] === "xrange");
    // `COUNT` present, so a 10k-frame run is never materialised — nor parsed — in one array.
    expect(xrange).toContain("COUNT");
    expect(xrange?.[3]).toBe("+");
    reader.stop();
  });
});
