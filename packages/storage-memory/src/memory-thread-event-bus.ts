import {
  serializeWireJson,
  SkeinHttpError,
  type ThreadEvent,
  type ThreadEventBus,
  type ThreadEventInput,
} from "@skein-js/core";

interface ThreadHistory {
  seq: number;
  generation: number;
  entries: ThreadEvent[];
  readers: Set<() => void>;
  deleted: boolean;
}

/** Bounded payload replay; high-water marks live until the runtime is released. */
export class MemoryThreadEventBus implements ThreadEventBus {
  readonly #threads = new Map<string, ThreadHistory>();
  /** Histories holding payloads, least recently published first — the eviction order. */
  readonly #retained = new Set<ThreadHistory>();

  #history(threadId: string): ThreadHistory {
    let history = this.#threads.get(threadId);
    if (!history) {
      history = { seq: 0, generation: 0, entries: [], readers: new Set(), deleted: false };
      this.#threads.set(threadId, history);
    }
    return history;
  }

  async publish(
    threadId: string,
    input: ThreadEventInput,
    generation?: number,
  ): Promise<ThreadEvent | undefined> {
    const history = this.#history(threadId);
    if (generation !== undefined && generation !== history.generation) return undefined;
    const created = input.kind === "state" && input.operation === "created";
    if (history.deleted && !created) return undefined;
    const seq = history.seq + 1;
    // Serialization must succeed before allocating a sequence or reopening a deleted incarnation.
    const entry = JSON.parse(serializeWireJson({ ...input, seq })) as ThreadEvent;
    history.seq = seq;
    if (created) history.deleted = false;
    if (entry.kind === "protocol") {
      entry.event.seq = seq;
      entry.event.event_id = String(seq);
    }
    history.entries.push(entry);
    if (history.entries.length > 10_000) history.entries.shift();
    // Keep at most 50 payload histories. Eviction retains the cursor and active reader registrations.
    this.#retained.delete(history);
    this.#retained.add(history);
    if (this.#retained.size > 50) {
      const [oldest] = this.#retained;
      this.#retained.delete(oldest!);
      oldest!.entries = [];
      for (const wake of oldest!.readers) wake();
    }
    for (const wake of history.readers) wake();
    return structuredClone(entry);
  }

  async generation(threadId: string): Promise<number> {
    return this.#history(threadId).generation;
  }

  async latestSequence(threadId: string): Promise<number> {
    return this.#history(threadId).seq;
  }

  async replayCursor(threadId: string): Promise<number> {
    const history = this.#history(threadId);
    return (history.entries[0]?.seq ?? history.seq + 1) - 1;
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
    const history = this.#history(threadId);
    const generation = history.generation;
    let cursor = afterSeq ?? Math.max(0, (history.entries[0]?.seq ?? history.seq + 1) - 1);
    const checkCursor = () => {
      const first = history.entries[0]?.seq ?? history.seq + 1;
      if (cursor > history.seq || cursor < first - 1) {
        throw SkeinHttpError.conflict(
          "Thread event history expired; restore state and subscribe again.",
          {
            code: "thread_cursor_expired",
          },
        );
      }
    };
    checkCursor();
    while (!signal?.aborted && !history.deleted && history.generation === generation) {
      checkCursor();
      const page = history.entries.filter((entry) => entry.seq > cursor).slice(0, 512);
      if (page.length) {
        for (const entry of page) {
          if (signal?.aborted || history.deleted || history.generation !== generation) return;
          cursor = entry.seq;
          yield structuredClone(entry);
        }
        continue;
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          history.readers.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        history.readers.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
        if (signal?.aborted || history.deleted || history.seq > cursor) wake();
      });
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const history = this.#history(threadId);
    history.deleted = true;
    history.generation++;
    history.entries = [];
    this.#retained.delete(history);
    for (const wake of history.readers) wake();
  }
}
