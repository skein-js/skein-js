import {
  serializeWireJson,
  SkeinHttpError,
  type ThreadEvent,
  type ThreadEventBus,
  type ThreadEventInput,
} from "@skein-js/core";
import { Redis } from "ioredis";

import { closeConnection } from "./redis-connection.js";

// Sequence allocation and append are one operation, so competing publishers cannot reorder them.
const APPEND = `
if ARGV[3] ~= '' and tonumber(ARGV[3]) ~= tonumber(redis.call('GET', KEYS[4]) or '0') then return nil end
if redis.call('EXISTS', KEYS[3]) == 1 and ARGV[2] ~= 'created' then return nil end
if ARGV[2] == 'created' then redis.call('DEL', KEYS[3]) end
local seq = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], 'MAXLEN', '~', 10000, '*', 'seq', tostring(seq), 'entry', ARGV[1])
redis.call('EXPIRE', KEYS[1], 3600)
return seq
`;

/** Thread replay shared by API replicas and workers; blocking reads are independently cancellable. */
export class RedisThreadEventBus implements ThreadEventBus {
  readonly #commands: Redis;
  readonly #readers = new Set<Redis>();
  #disposed = false;

  constructor(url: string) {
    this.#commands = new Redis(url);
  }

  #keys(threadId: string): [string, string, string, string] {
    // Encode the tag so an application-supplied id cannot escape a Redis Cluster hash slot.
    const tag = encodeURIComponent(threadId).replaceAll("{", "%7B").replaceAll("}", "%7D");
    const prefix = `skein:thread-events:{${tag}}`;
    return [prefix, `${prefix}:seq`, `${prefix}:deleted`, `${prefix}:generation`];
  }

  async publish(
    threadId: string,
    entry: ThreadEventInput,
    generation?: number,
  ): Promise<ThreadEvent | undefined> {
    const encoded = serializeWireJson(entry);
    const sequence = await this.#commands.eval(
      APPEND,
      4,
      ...this.#keys(threadId),
      encoded,
      entry.kind === "state" && entry.operation === "created" ? "created" : "append",
      generation === undefined ? "" : String(generation),
    );
    return typeof sequence === "number"
      ? decodeEntry(["seq", String(sequence), "entry", encoded])
      : undefined;
  }

  async generation(threadId: string): Promise<number> {
    return Number((await this.#commands.get(this.#keys(threadId)[3])) ?? 0);
  }

  async latestSequence(threadId: string): Promise<number> {
    return Number((await this.#commands.get(this.#keys(threadId)[1])) ?? 0);
  }

  async replayCursor(threadId: string): Promise<number> {
    const [streamKey] = this.#keys(threadId);
    const first = await this.#commands.xrange(streamKey, "-", "+", "COUNT", 1);
    return first[0] ? decodeEntry(first[0][1]).seq - 1 : this.latestSequence(threadId);
  }

  subscribe(threadId: string, afterSeq?: number, signal?: AbortSignal): AsyncIterable<ThreadEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        const stopped = new AbortController();
        const combined = signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal;
        const iterator = this.#tail(threadId, afterSeq, combined)[Symbol.asyncIterator]();
        return {
          next: () => iterator.next(),
          return: async () => {
            stopped.abort();
            await iterator.return?.();
            return { done: true as const, value: undefined };
          },
        };
      },
    };
  }

  async *#tail(
    threadId: string,
    afterSeq?: number,
    signal?: AbortSignal,
  ): AsyncIterable<ThreadEvent> {
    const [streamKey, counterKey, deletedKey, generationKey] = this.#keys(threadId);
    const reader = this.#commands.duplicate();
    this.#readers.add(reader);
    const abort = () => reader.disconnect();
    signal?.addEventListener("abort", abort, { once: true });
    let lastId = "0-0";
    let cursor = afterSeq;
    try {
      if (signal?.aborted) return;
      const generation = Number((await reader.get(generationKey)) ?? 0);
      const highWater = Number((await reader.get(counterKey)) ?? 0);
      const first = await reader.xrange(streamKey, "-", "+", "COUNT", 1);
      const firstEntry = first[0] ? decodeEntry(first[0][1]) : undefined;
      if (
        cursor !== undefined &&
        (cursor > highWater || cursor < (firstEntry?.seq ?? highWater + 1) - 1)
      ) {
        throw cursorExpired();
      }
      cursor ??= Math.max(0, (firstEntry?.seq ?? highWater + 1) - 1);
      while (!signal?.aborted) {
        if (
          (await reader.exists(deletedKey)) ||
          Number((await reader.get(generationKey)) ?? 0) !== generation
        )
          return;
        const pages = await reader.xread("COUNT", 512, "BLOCK", 1000, "STREAMS", streamKey, lastId);
        if (!pages) continue;
        for (const [, entries] of pages) {
          for (const [id, fields] of entries) {
            lastId = id;
            if (Number((await reader.get(generationKey)) ?? 0) !== generation) return;
            const entry = decodeEntry(fields);
            if (entry.seq <= cursor) continue;
            if (entry.seq !== cursor + 1) throw cursorExpired();
            cursor = entry.seq;
            yield entry;
            if (signal?.aborted) return;
          }
        }
      }
    } catch (error) {
      if (!signal?.aborted && !this.#disposed) throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#readers.delete(reader);
      reader.disconnect();
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const [stream, , deleted, generation] = this.#keys(threadId);
    // The high-water mark survives payload erasure and reuse of a thread id.
    await this.#commands.multi().del(stream).set(deleted, "1").incr(generation).exec();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const reader of this.#readers) reader.disconnect();
    this.#readers.clear();
    await closeConnection(this.#commands);
  }
}

function decodeEntry(fields: string[]): ThreadEvent {
  const encoded = fields[fields.indexOf("entry") + 1];
  if (encoded === undefined) throw new Error("Malformed thread event in Redis.");
  const entry = {
    ...JSON.parse(encoded),
    seq: Number(fields[fields.indexOf("seq") + 1]),
  } as ThreadEvent;
  if (entry.kind === "protocol") {
    entry.event.seq = entry.seq;
    entry.event.event_id = String(entry.seq);
  }
  return entry;
}

function cursorExpired(): SkeinHttpError {
  return SkeinHttpError.conflict(
    "Thread event history expired; restore state and subscribe again.",
    {
      code: "thread_cursor_expired",
    },
  );
}
