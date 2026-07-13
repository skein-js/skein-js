// The in-memory SkeinStore: plain Maps, zero external services — what `skein dev` runs on and
// what the shared conformance suite is first proven against. It holds only Agent Protocol
// *resources* (assistants/threads/runs/store items); graph checkpoints are LangGraph's, via a
// MemorySaver, not this. Every read/write deep-clones at the boundary (like a real serializing
// driver), so callers can neither mutate stored rows through a returned object nor corrupt the
// store by mutating an input they still hold.

import { randomUUID } from "node:crypto";

import {
  isTerminalRunStatus,
  SkeinHttpError,
  type Assistant,
  type AssistantCreate,
  type AssistantRepo,
  type Item,
  type Run,
  type RunCreate,
  type RunRepo,
  type RunStatus,
  type SearchItem,
  type SkeinStore,
  type StoreRepo,
  type StoreSearchQuery,
  type Thread,
  type ThreadCreate,
  type ThreadRepo,
  type ThreadUpdate,
} from "@skein/core";

const nowIso = (): string => new Date().toISOString();

/** Deep copy at the persistence boundary — mirrors what a serializing driver (Postgres) does. */
const clone = <T>(value: T): T => structuredClone(value);

/** Read one row by id, deep-cloned so the caller can't mutate what's stored. */
function readOne<T>(map: Map<string, T>, id: string): T | null {
  const found = map.get(id);
  return found ? clone(found) : null;
}

/** Read every row, each deep-cloned. */
function readAll<T>(map: Map<string, T>): T[] {
  return [...map.values()].map((row) => clone(row));
}

/** Store a row (deep-cloned in, so later caller mutation can't reach it) and return a fresh copy. */
function write<T>(map: Map<string, T>, id: string, row: T): T {
  const stored = clone(row);
  map.set(id, stored);
  return clone(stored);
}

/** True if `namespace` starts with every segment of `prefix` (empty/absent prefix matches all). */
function hasPrefix(namespace: string[], prefix?: string[]): boolean {
  if (!prefix || prefix.length === 0) return true;
  if (prefix.length > namespace.length) return false;
  return prefix.every((segment, i) => namespace[i] === segment);
}

/** Serialize a (namespace, key) pair to a collision-free Map key. */
function itemKey(namespace: string[], key: string): string {
  return JSON.stringify([namespace, key]);
}

/** In-process SkeinStore for development and tests. */
export class MemorySkeinStore implements SkeinStore {
  readonly #assistants = new Map<string, Assistant>();
  readonly #threads = new Map<string, Thread>();
  readonly #runs = new Map<string, Run>();
  readonly #items = new Map<string, Item>();

  readonly assistants: AssistantRepo = {
    list: async () => readAll(this.#assistants),
    get: async (assistantId) => readOne(this.#assistants, assistantId),
    create: async (input: AssistantCreate) => {
      const at = nowIso();
      const assistant: Assistant = {
        assistant_id: input.assistant_id ?? randomUUID(),
        graph_id: input.graph_id,
        config: input.config ?? {},
        context: input.context ?? {},
        created_at: at,
        updated_at: at,
        metadata: input.metadata ?? {},
        version: 1,
        name: input.name ?? input.graph_id,
        description: input.description,
      };
      return write(this.#assistants, assistant.assistant_id, assistant);
    },
    delete: async (assistantId) => {
      this.#assistants.delete(assistantId);
    },
  };

  readonly threads: ThreadRepo = {
    list: async () => readAll(this.#threads),
    get: async (threadId) => readOne(this.#threads, threadId),
    create: async (input?: ThreadCreate) => {
      const at = nowIso();
      const thread: Thread = {
        thread_id: input?.thread_id ?? randomUUID(),
        created_at: at,
        updated_at: at,
        state_updated_at: at,
        metadata: input?.metadata ?? {},
        status: input?.status ?? "idle",
        values: {} as Record<string, unknown>,
        interrupts: {},
      };
      return write(this.#threads, thread.thread_id, thread);
    },
    update: async (threadId, patch: ThreadUpdate) => {
      const existing = this.#threads.get(threadId);
      if (!existing) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
      const at = nowIso();
      const updated: Thread = {
        ...existing,
        metadata: patch.metadata ?? existing.metadata,
        status: patch.status ?? existing.status,
        values: patch.values ?? existing.values,
        updated_at: at,
        state_updated_at: patch.values !== undefined ? at : existing.state_updated_at,
      };
      return write(this.#threads, threadId, updated);
    },
    delete: async (threadId) => {
      this.#threads.delete(threadId);
      // Cascade: a deleted thread's runs go with it.
      for (const [runId, run] of this.#runs) {
        if (run.thread_id === threadId) this.#runs.delete(runId);
      }
    },
  };

  readonly runs: RunRepo = {
    get: async (runId) => readOne(this.#runs, runId),
    listByThread: async (threadId) =>
      readAll(this.#runs).filter((run) => run.thread_id === threadId),
    create: async (input: RunCreate) => {
      const at = nowIso();
      const run: Run = {
        run_id: input.run_id ?? randomUUID(),
        thread_id: input.thread_id,
        assistant_id: input.assistant_id,
        created_at: at,
        updated_at: at,
        status: input.status ?? "pending",
        metadata: input.metadata ?? {},
        multitask_strategy: input.multitask_strategy ?? null,
      };
      return write(this.#runs, run.run_id, run);
    },
    setStatus: async (runId, status: RunStatus) => {
      const existing = this.#runs.get(runId);
      if (!existing) throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
      return write(this.#runs, runId, { ...existing, status, updated_at: nowIso() });
    },
    delete: async (runId) => {
      this.#runs.delete(runId);
    },
    hasActiveRun: async (threadId) => {
      for (const run of this.#runs.values()) {
        if (run.thread_id === threadId && !isTerminalRunStatus(run.status)) return true;
      }
      return false;
    },
  };

  readonly store: StoreRepo = {
    get: async (namespace, key) => {
      const found = this.#items.get(itemKey(namespace, key));
      return found ? clone(found) : null;
    },
    put: async (namespace, key, value) => {
      const id = itemKey(namespace, key);
      const at = nowIso();
      const existing = this.#items.get(id);
      const item: Item = {
        namespace: [...namespace],
        key,
        value,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
      const stored = clone(item);
      this.#items.set(id, stored);
      return clone(stored);
    },
    delete: async (namespace, key) => {
      this.#items.delete(itemKey(namespace, key));
    },
    search: async (query: StoreSearchQuery) => {
      const needle = query.query?.toLowerCase();
      const matches: SearchItem[] = [...this.#items.values()]
        .filter((item) => hasPrefix(item.namespace, query.prefix))
        .filter((item) =>
          needle ? JSON.stringify(item.value).toLowerCase().includes(needle) : true,
        )
        .map((item) => {
          const result: SearchItem = clone(item);
          // Naive relevance: any query is an exact-substring hit, so score 1 (pgvector does the
          // real semantic ranking in the Postgres driver).
          if (needle) result.score = 1;
          return result;
        });

      const offset = query.offset ?? 0;
      return matches.slice(offset, query.limit === undefined ? undefined : offset + query.limit);
    },
    listNamespaces: async (prefix) => {
      // Key by JSON.stringify (not join) so distinct namespaces whose segments contain the
      // separator can't collide.
      const seen = new Map<string, string[]>();
      for (const item of this.#items.values()) {
        if (hasPrefix(item.namespace, prefix)) {
          seen.set(JSON.stringify(item.namespace), item.namespace);
        }
      }
      return [...seen.values()].map((namespace) => [...namespace]);
    },
  };
}
