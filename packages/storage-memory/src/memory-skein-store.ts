// The in-memory SkeinStore: plain Maps, zero external services — what `skein dev` runs on and
// what the shared conformance suite is first proven against. It holds only Agent Protocol
// *resources* (assistants/threads/runs/store items); graph checkpoints are LangGraph's, via a
// MemorySaver, not this. Every read/write deep-clones at the boundary (like a real serializing
// driver), so callers can neither mutate stored rows through a returned object nor corrupt the
// store by mutating an input they still hold.

import { randomUUID } from "node:crypto";

import {
  DEFAULT_MAX_PAGE_SIZE,
  requireValidMaxPageSize,
  isMetadataSubset,
  isTerminalRunStatus,
  SkeinHttpError,
  type Assistant,
  type AssistantCreate,
  type AssistantRepo,
  type AssistantSearchQuery,
  type AssistantUpdate,
  type AssistantVersion,
  type AssistantVersionsQuery,
  type Cron,
  type CronAuth,
  type CronClaim,
  type CronCreate,
  type CronRepo,
  type CronSearchQuery,
  type CronUpdate,
  type Item,
  type Run,
  type RunCreate,
  type RunError,
  type RunKwargs,
  type RunRepo,
  type RunStatus,
  type SearchItem,
  type SkeinStore,
  type SkeinStoreSnapshot,
  type StorePutOptions,
  type StoreRepo,
  type StoreSearchQuery,
  type StoreTtlConfig,
  type ThreadTtlConfig,
  type Thread,
  type ThreadCreate,
  type ThreadRepo,
  type ThreadSearchQuery,
  type ThreadUpdate,
} from "@skein-js/core";

const nowIso = (): string => new Date().toISOString();

/** Deep copy at the persistence boundary — mirrors what a serializing driver (Postgres) does. */
const clone = <T>(value: T): T => structuredClone(value);

/**
 * Project an assistant row onto an immutable {@link AssistantVersion} snapshot (the wire shape, sans
 * `updated_at`). `createdAt` overrides when this version came into being — defaulting to the
 * assistant's own `created_at`, which is correct for the version-1 snapshot minted at create time.
 */
function toVersion(assistant: Assistant, createdAt?: string): AssistantVersion {
  return {
    assistant_id: assistant.assistant_id,
    graph_id: assistant.graph_id,
    config: assistant.config,
    context: assistant.context,
    created_at: createdAt ?? assistant.created_at,
    metadata: assistant.metadata,
    version: assistant.version,
    name: assistant.name,
    description: assistant.description,
  };
}

/** Read one row by id, deep-cloned so the caller can't mutate what's stored. */
function readOne<T>(map: Map<string, T>, id: string): T | null {
  const found = map.get(id);
  return found ? clone(found) : null;
}

/**
 * A page of already-filtered/sorted rows, deep-cloned on the way out.
 *
 * The clone is what makes the driver behave like a real database (see the isolation cases in the
 * conformance suite), and it is the expensive part — a thread row carries the thread's whole mirrored
 * graph state. So filter and sort over the *stored* references and clone only the rows that leave.
 * Cloning the table first and slicing afterwards is the cost the page bound exists to avoid.
 */
function clonePage<T>(rows: readonly T[], offset: number, limit: number): T[] {
  return rows.slice(offset, offset + limit).map((row) => clone(row));
}

/**
 * Sort ascending by `created_at`, breaking ties on the row's id — the ordering the Postgres driver's
 * `list` uses. The tiebreaker matters once a page bound truncates: `created_at` alone ties at
 * millisecond resolution, and a restored snapshot carries its original timestamps.
 */
function sortByCreatedAtThenId<T extends { created_at: string }>(
  rows: T[],
  idOf: (row: T) => string,
): T[] {
  return rows.sort((a, b) =>
    a.created_at === b.created_at
      ? idOf(a).localeCompare(idOf(b))
      : a.created_at.localeCompare(b.created_at),
  );
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

/** Serialize an (assistant_id, version) pair to a collision-free Map key for the versions store. */
function versionKey(assistantId: string, version: number): string {
  return JSON.stringify([assistantId, version]);
}

/** In-process SkeinStore for development and tests. */
export class MemorySkeinStore implements SkeinStore {
  readonly #assistants = new Map<string, Assistant>();
  // Immutable version snapshots, keyed by `versionKey(assistant_id, version)`. The live #assistants
  // row always mirrors the currently-active version; this map is the append-only history.
  readonly #assistantVersions = new Map<string, AssistantVersion>();
  readonly #threads = new Map<string, Thread>();
  readonly #runs = new Map<string, Run>();
  // The opaque execution payload lives beside the run row (it is not part of the wire `Run`).
  readonly #runKwargs = new Map<string, RunKwargs>();
  readonly #crons = new Map<string, Cron>();
  // The principal a cron's fired runs execute as — beside the row, never on the wire (see `CronAuth`).
  readonly #cronAuth = new Map<string, CronAuth>();
  // The compare-and-swap claim token, keyed by cron_id. Beside the row rather than on it because it
  // is scheduler bookkeeping, not wire state — the Postgres driver keeps it as a column for the same
  // reason `runs.kwargs` is a column rather than part of the wire `Run`.
  readonly #cronSeq = new Map<string, number>();
  readonly #items = new Map<string, Item>();
  // Item expiry lives beside the item (never on the wire `Item`), keyed the same way as #items:
  // `expiresAt` is epoch-ms (null = never expires), `ttlMinutes` is what a refresh-on-read extends by.
  readonly #itemExpiry = new Map<string, { expiresAt: number | null; ttlMinutes: number | null }>();
  readonly #ttl?: StoreTtlConfig;

  /**
   * Thread expiry, epoch-ms, for threads that have one. Kept beside the row rather than on it — the
   * wire `Thread` has no expiry field, and inventing one would diverge from the SDK's shape.
   */
  readonly #threadExpiry = new Map<string, number>();
  readonly #threadTtl?: ThreadTtlConfig;

  readonly #maxPageSize: number;

  constructor(options?: {
    ttl?: StoreTtlConfig;
    threadTtl?: ThreadTtlConfig;
    maxPageSize?: number;
  }) {
    this.#ttl = options?.ttl;
    this.#threadTtl = options?.threadTtl;
    this.#maxPageSize = requireValidMaxPageSize(options?.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE);
  }

  /**
   * Record (or clear) a thread's expiry. `null` pins the thread; `undefined` falls back to the
   * configured default, so a create that says nothing still expires under a configured TTL.
   */
  #setThreadExpiry(threadId: string, ttlMinutes: number | null | undefined): void {
    const minutes = ttlMinutes === undefined ? this.#threadTtl?.defaultTtl : ttlMinutes;
    if (minutes === null || minutes === undefined) {
      this.#threadExpiry.delete(threadId);
      return;
    }
    this.#threadExpiry.set(threadId, Date.now() + minutes * 60_000);
  }

  /** The bound this driver applies to an unbounded read — see `SkeinStore.maxPageSize`. */
  get maxPageSize(): number {
    return this.#maxPageSize;
  }

  /**
   * Rows here do not survive the process — see `SkeinStore.durable`. `skein dev` snapshots them to
   * `.skein/` on a timer, which covers a restart but is not durability: it is best-effort, lossy up
   * to the last autosave, and off entirely under `--no-persist`.
   */
  get durable(): boolean {
    return false;
  }

  /**
   * The effective page size for a search: the caller's limit, bounded by `maxPageSize`.
   *
   * An absent limit means the first page, not everything — matching the Postgres driver, which the
   * shared conformance suite holds both to. Unbounded was the old behaviour on both.
   */
  #pageLimit(limit: number | undefined): number {
    return Math.min(limit ?? this.#maxPageSize, this.#maxPageSize);
  }

  /** Record (or clear) an item's expiry from a resolved per-item TTL in minutes. */
  #setExpiry(id: string, ttlMinutes: number | null): void {
    if (ttlMinutes === null || ttlMinutes === undefined) {
      this.#itemExpiry.delete(id);
      return;
    }
    this.#itemExpiry.set(id, { expiresAt: Date.now() + ttlMinutes * 60_000, ttlMinutes });
  }

  /** True if the item has expired and should read as absent. */
  #isExpired(id: string): boolean {
    const entry = this.#itemExpiry.get(id);
    return entry?.expiresAt != null && entry.expiresAt <= Date.now();
  }

  /**
   * Extend a live item's expiry on read when TTL is configured and `refresh_on_read` isn't disabled
   * (it defaults on). With no configured TTL we never refresh, matching the Postgres driver.
   */
  #maybeRefresh(id: string): void {
    if (this.#ttl === undefined || this.#ttl.refreshOnRead === false) return;
    const entry = this.#itemExpiry.get(id);
    if (entry?.ttlMinutes != null) {
      this.#itemExpiry.set(id, { ...entry, expiresAt: Date.now() + entry.ttlMinutes * 60_000 });
    }
  }

  /** Advance the claim token for a cron, so any in-flight claim holding the old one loses. */
  #bumpCronSeq(cronId: string): number {
    const next = (this.#cronSeq.get(cronId) ?? 0) + 1;
    this.#cronSeq.set(cronId, next);
    return next;
  }

  /**
   * The compare-and-swap behind both claim methods: advance `next_run_date` only if the cron still
   * holds `expectedSeq` and is still enabled, returning the advanced row or `null` for a loser.
   *
   * Synchronous on purpose. It is called from `async` repo methods, but its own body must never
   * suspend — that is what makes the claim indivisible in this driver, exactly as a single
   * conditional `UPDATE` is in Postgres.
   */
  #claimCron(cronId: string, claim: CronClaim): Cron | null {
    const existing = this.#crons.get(cronId);
    // A cron deleted or disabled between the scan and the claim is a loss, not an error: the
    // scheduler treats every `null` the same way, and both mean "do not fire this occurrence".
    if (!existing || !existing.enabled) return null;
    if ((this.#cronSeq.get(cronId) ?? 0) !== claim.expectedSeq) return null;
    this.#bumpCronSeq(cronId);
    return write(this.#crons, cronId, {
      ...existing,
      next_run_date: claim.nextRunDate,
      updated_at: nowIso(),
    });
  }

  /** Drop every version snapshot belonging to an assistant (memory has no cascading FK). */
  #deleteVersionsOf(assistantId: string): void {
    for (const [key, version] of this.#assistantVersions) {
      if (version.assistant_id === assistantId) this.#assistantVersions.delete(key);
    }
  }

  /** Highest version number recorded for an assistant, or 0 when it has no history yet. */
  #maxVersionOf(assistantId: string): number {
    let max = 0;
    for (const version of this.#assistantVersions.values()) {
      if (version.assistant_id === assistantId && version.version > max) max = version.version;
    }
    return max;
  }

  /**
   * Every assistant matching `query`'s filters, sorted — before pagination. **Stored references, not
   * copies**: callers must clone whatever they hand out (`clonePage`).
   *
   * Extracted so `count` does not go through `search`: `search` now bounds an absent limit to a page,
   * so counting via it would report at most one page. Postgres counts with `count(*)`, and the two
   * drivers have to agree.
   */
  /**
   * Every thread matching `query`'s filters, sorted — before pagination. **Stored references, not
   * copies**: callers must clone whatever they hand out (`clonePage`).
   *
   * Extracted for the same reason as {@link #matchingAssistants}: `search` bounds an absent limit to a
   * page, so `count` cannot be measured through it.
   */
  #matchingThreads(query: ThreadSearchQuery): Thread[] {
    const matched = [...this.#threads.values()].filter(
      (thread) =>
        (!query.ids || query.ids.includes(thread.thread_id)) &&
        (!query.status || thread.status === query.status) &&
        isMetadataSubset(thread.metadata, query.metadata) &&
        // The server's own scoping, AND-ed with the caller's filter — see `enforcedMetadata`.
        isMetadataSubset(thread.metadata, query.enforcedMetadata) &&
        isMetadataSubset(thread.values, query.values),
    );
    const sortBy = query.sortBy ?? "created_at";
    const direction = query.sortOrder === "asc" ? 1 : -1;
    const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    matched.sort((a, b) => {
      const primary = compare(String(a[sortBy] ?? ""), String(b[sortBy] ?? ""));
      // Break ties on thread_id in the same direction, so paging is deterministic and matches the
      // Postgres driver's `ORDER BY <sortBy> <dir>, thread_id <dir>`.
      const ordered = primary !== 0 ? primary : compare(a.thread_id, b.thread_id);
      return direction * ordered;
    });
    return matched;
  }

  #matchingAssistants(query: AssistantSearchQuery): Assistant[] {
    const matched = [...this.#assistants.values()].filter(
      (assistant) =>
        (query.graph_id === undefined || assistant.graph_id === query.graph_id) &&
        (query.name === undefined || assistant.name === query.name) &&
        isMetadataSubset(assistant.metadata, query.metadata),
    );
    const sortBy = query.sortBy ?? "created_at";
    const direction = query.sortOrder === "asc" ? 1 : -1;
    const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    matched.sort((a, b) => {
      const primary = compare(String(a[sortBy] ?? ""), String(b[sortBy] ?? ""));
      // Break ties on assistant_id in the same direction, so paging is deterministic and matches
      // the Postgres driver's `ORDER BY <sortBy> <dir>, assistant_id <dir>`.
      const ordered = primary !== 0 ? primary : compare(a.assistant_id, b.assistant_id);
      return direction * ordered;
    });
    return matched;
  }

  readonly assistants: AssistantRepo = {
    // Ordered like the Postgres driver's `ORDER BY created_at, assistant_id`, so a page bounded at the
    // same size holds the *same* rows on both drivers — insertion order would diverge after `hydrate`.
    list: async () =>
      clonePage(
        sortByCreatedAtThenId([...this.#assistants.values()], (row) => row.assistant_id),
        0,
        this.#pageLimit(undefined),
      ),
    search: async (query: AssistantSearchQuery) => {
      const matched = this.#matchingAssistants(query);
      return clonePage(matched, query.offset ?? 0, this.#pageLimit(query.limit));
    },
    count: async (query: AssistantSearchQuery) => this.#matchingAssistants(query).length,
    get: async (assistantId) => readOne(this.#assistants, assistantId),
    create: async (input: AssistantCreate) => {
      const assistantId = input.assistant_id ?? randomUUID();
      // Reject a duplicate id (matches the Postgres driver): the service turns this 409 into
      // if_exists handling, and registerGraphAssistants tolerates it on a concurrent boot.
      if (this.#assistants.has(assistantId)) {
        throw SkeinHttpError.conflict(`Assistant "${assistantId}" already exists.`);
      }
      const at = nowIso();
      const assistant: Assistant = {
        assistant_id: assistantId,
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
      this.#assistantVersions.set(versionKey(assistantId, 1), clone(toVersion(assistant)));
      return write(this.#assistants, assistantId, assistant);
    },
    update: async (assistantId, patch: AssistantUpdate) => {
      const existing = this.#assistants.get(assistantId);
      if (!existing) throw SkeinHttpError.notFound(`Assistant "${assistantId}" not found.`);
      const at = nowIso();
      // New version is max(existing) + 1, NOT the live row's version — after a setLatest rollback
      // the live version is lower than the max, and active+1 would collide with an existing snapshot.
      const next = this.#maxVersionOf(assistantId) + 1;
      const updated: Assistant = {
        ...existing,
        graph_id: patch.graph_id ?? existing.graph_id,
        name: patch.name ?? existing.name,
        description: patch.description !== undefined ? patch.description : existing.description,
        config: patch.config ?? existing.config,
        context: patch.context !== undefined ? patch.context : existing.context,
        // metadata MERGES (shallow), matching LangGraph — patching one key keeps the siblings.
        metadata:
          patch.metadata !== undefined
            ? { ...existing.metadata, ...patch.metadata }
            : existing.metadata,
        version: next,
        updated_at: at,
      };
      this.#assistantVersions.set(versionKey(assistantId, next), clone(toVersion(updated, at)));
      return write(this.#assistants, assistantId, updated);
    },
    listVersions: async (assistantId, query?: AssistantVersionsQuery) => {
      const versions = [...this.#assistantVersions.values()]
        .filter(
          (version) =>
            version.assistant_id === assistantId &&
            isMetadataSubset(version.metadata, query?.metadata),
        )
        .sort((a, b) => b.version - a.version);
      const offset = query?.offset ?? 0;
      return versions.slice(offset, offset + this.#pageLimit(query?.limit)).map(clone);
    },
    setLatest: async (assistantId, version) => {
      const existing = this.#assistants.get(assistantId);
      if (!existing) throw SkeinHttpError.notFound(`Assistant "${assistantId}" not found.`);
      const target = this.#assistantVersions.get(versionKey(assistantId, version));
      if (!target) {
        throw SkeinHttpError.notFound(
          `Version ${version} of assistant "${assistantId}" not found.`,
        );
      }
      const updated: Assistant = {
        ...existing,
        graph_id: target.graph_id,
        name: target.name,
        description: target.description,
        config: target.config,
        context: target.context,
        metadata: target.metadata,
        version: target.version,
        updated_at: nowIso(),
      };
      return write(this.#assistants, assistantId, updated);
    },
    delete: async (assistantId) => {
      this.#assistants.delete(assistantId);
      this.#deleteVersionsOf(assistantId);
    },
  };

  readonly threads: ThreadRepo = {
    list: async () =>
      clonePage(
        sortByCreatedAtThenId([...this.#threads.values()], (row) => row.thread_id),
        0,
        this.#pageLimit(undefined),
      ),
    search: async (query: ThreadSearchQuery) =>
      clonePage(this.#matchingThreads(query), query.offset ?? 0, this.#pageLimit(query.limit)),
    count: async (query: ThreadSearchQuery) => this.#matchingThreads(query).length,
    get: async (threadId) => readOne(this.#threads, threadId),
    create: async (input?: ThreadCreate) => {
      const threadId = input?.thread_id ?? randomUUID();
      // Reject a duplicate id (matches the Postgres driver): the service turns this 409 into
      // if_exists handling. Without it a re-used id silently *overwrote* the thread — resetting its
      // created_at, metadata, status, values and interrupts, so an interrupted thread read as idle.
      if (this.#threads.has(threadId)) {
        throw SkeinHttpError.conflict(`Thread "${threadId}" already exists.`);
      }
      const at = nowIso();
      const thread: Thread = {
        thread_id: threadId,
        created_at: at,
        updated_at: at,
        state_updated_at: at,
        metadata: input?.metadata ?? {},
        status: input?.status ?? "idle",
        values: {} as Record<string, unknown>,
        interrupts: {},
      };
      this.#setThreadExpiry(threadId, input?.ttl);
      return write(this.#threads, thread.thread_id, thread);
    },
    update: async (threadId, patch: ThreadUpdate) => {
      const existing = this.#threads.get(threadId);
      if (!existing) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
      const at = nowIso();
      // `error` is tri-state: absent leaves it alone, `null` clears it, a string sets it. The key
      // is dropped rather than set to null when cleared, so a healthy thread carries no `error`.
      const { error: _replaced, ...withoutError } = existing;
      const error = patch.error === undefined ? existing.error : patch.error;
      const updated: Thread = {
        ...withoutError,
        metadata: patch.metadata ?? existing.metadata,
        status: patch.status ?? existing.status,
        values: patch.values ?? existing.values,
        interrupts: patch.interrupts ?? existing.interrupts,
        updated_at: at,
        state_updated_at: patch.values !== undefined ? at : existing.state_updated_at,
        ...(error == null ? {} : { error }),
      };
      if (patch.ttl !== undefined) this.#setThreadExpiry(threadId, patch.ttl);
      return write(this.#threads, threadId, updated);
    },
    copy: async (threadId) => {
      const existing = this.#threads.get(threadId);
      if (!existing) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
      const at = nowIso();
      const copy: Thread = {
        ...clone(existing),
        thread_id: randomUUID(),
        created_at: at,
        updated_at: at,
        state_updated_at: at,
      };
      // A copy is a new thread, so it starts its own clock under the configured default rather than
      // inheriting the original's remaining lifetime.
      this.#setThreadExpiry(copy.thread_id, undefined);
      return write(this.#threads, copy.thread_id, copy);
    },
    listExpired: async ({ now, limit }) => {
      const cutoff = Date.parse(now);
      return [...this.#threadExpiry]
        .filter(([threadId, expiresAt]) => expiresAt <= cutoff && this.#threads.has(threadId))
        .sort(([, a], [, b]) => a - b)
        .slice(0, Math.min(limit, this.#maxPageSize))
        .map(([threadId]) => threadId);
    },
    delete: async (threadId) => {
      this.#threads.delete(threadId);
      this.#threadExpiry.delete(threadId);
      // Cascade: a deleted thread's runs (and their kwargs) go with it.
      for (const [runId, run] of this.#runs) {
        if (run.thread_id === threadId) {
          this.#runs.delete(runId);
          this.#runKwargs.delete(runId);
        }
      }
      // Thread crons go too, mirroring the Postgres driver's `ON DELETE CASCADE`. This is what makes
      // "a cron whose thread was deleted" a state that cannot exist, rather than one the scheduler
      // has to handle every time it fires.
      for (const [cronId, cron] of this.#crons) {
        if (cron.thread_id === threadId) {
          this.#crons.delete(cronId);
          this.#cronAuth.delete(cronId);
        }
      }
    },
  };

  readonly runs: RunRepo = {
    get: async (runId) => readOne(this.#runs, runId),
    listByThread: async (threadId, query) => {
      // The status filter is applied *before* paging, so `limit`/`offset` page the filtered set —
      // see `RunListQuery.status`.
      //
      // Filtered over the *stored* references and cloned by the page (`clonePage`) rather than cloning
      // the table and slicing after: this is called with no limit on the thread state path, and cloning
      // every run in the process to return one thread's cost ~2.4µs per stored run — 41ms of
      // synchronous event loop at 20k runs, on the default dev/embedded driver.
      const matched: Run[] = [];
      for (const run of this.#runs.values()) {
        if (run.thread_id !== threadId) continue;
        if (query?.status !== undefined && run.status !== query.status) continue;
        matched.push(run);
      }
      // Deliberately unbounded when the caller gives no limit (`runs.listByThread` is one of the two
      // reads the page bound exempts), so the fallback limit is "the rest of the matches".
      return clonePage(matched, query?.offset ?? 0, query?.limit ?? matched.length);
    },
    // One pass over the stored references keeping the max, then a single clone — the whole reason this
    // is a driver method (see `RunRepo.latestForThread`). `created_at` descending, tie-broken on
    // `run_id` descending, matching the Postgres driver's ORDER BY.
    latestForThread: async (threadId) => {
      let latest: Run | undefined;
      for (const run of this.#runs.values()) {
        if (run.thread_id !== threadId) continue;
        if (
          latest === undefined ||
          run.created_at > latest.created_at ||
          (run.created_at === latest.created_at && run.run_id > latest.run_id)
        ) {
          latest = run;
        }
      }
      return latest ? clone(latest) : null;
    },
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
      const stored = write(this.#runs, run.run_id, run);
      if (input.kwargs) this.#runKwargs.set(run.run_id, clone(input.kwargs));
      return stored;
    },
    // Atomic here for free, and deliberately written to stay that way: the scan and the insert both run
    // to completion in a single event-loop turn (nothing here suspends, and `create`'s own body has no
    // `await`), so no other caller can interleave between them. Adding an `await` above the write would
    // silently reopen the race this method exists to close.
    createIfThreadIdle: async (input: RunCreate) => {
      // Checked explicitly because this driver has no foreign key to do it: the Postgres driver refuses
      // an unknown thread (its `SELECT … FOR UPDATE` finds no row), and the two must not disagree.
      if (!this.#threads.has(input.thread_id)) return null;
      for (const run of this.#runs.values()) {
        if (run.thread_id === input.thread_id && !isTerminalRunStatus(run.status)) return null;
      }
      return this.runs.create(input);
    },
    setStatus: async (runId, status: RunStatus, error?: RunError) => {
      const existing = this.#runs.get(runId);
      if (!existing) throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
      // `error` is authoritative on every call, so a stale one is dropped rather than merged. The
      // conditional spread (over `error: undefined`) keeps the key genuinely absent on a run that
      // did not fail, matching the Postgres driver's NULL column.
      const { error: _replaced, ...rest } = existing;
      return write(this.#runs, runId, {
        ...rest,
        status,
        updated_at: nowIso(),
        ...(error ? { error } : {}),
      });
    },
    delete: async (runId) => {
      this.#runs.delete(runId);
      this.#runKwargs.delete(runId);
    },
    getKwargs: async (runId) => {
      const found = this.#runKwargs.get(runId);
      return found ? clone(found) : null;
    },
    recordBaseCheckpoint: async (runId, baseCheckpointId) => {
      // A run created with no kwargs at all still gets the field, so the value is never lost to the
      // absence of a blob to put it in.
      if (!this.#runs.has(runId)) return;
      const existing = this.#runKwargs.get(runId) ?? {};
      this.#runKwargs.set(runId, { ...existing, base_checkpoint_id: baseCheckpointId });
    },
    hasActiveRun: async (threadId) => {
      for (const run of this.#runs.values()) {
        if (run.thread_id === threadId && !isTerminalRunStatus(run.status)) return true;
      }
      return false;
    },
    // `threadId` omitted sweeps every thread (see the `RunRepo.listActiveRuns` contract). Bounded like
    // every other unbounded read, so a server with a very large backlog can't be made to materialize
    // all of it in one call.
    listActiveRuns: async (threadId) => {
      // Stored references filtered, then cloned by the page — see `listByThread`. This one is on the
      // cancel and cron-sweep paths, where cloning first meant copying every run in the process to
      // return the handful that are still inflight.
      const matched: Run[] = [];
      for (const run of this.#runs.values()) {
        if (threadId !== undefined && run.thread_id !== threadId) continue;
        if (isTerminalRunStatus(run.status)) continue;
        matched.push(run);
      }
      return clonePage(matched, 0, this.#pageLimit(undefined));
    },
  };

  /**
   * Every cron matching `query`'s filters, sorted — before pagination. **Stored references, not
   * copies**: callers must clone whatever they hand out. Extracted so `count` does not measure
   * through `search`, for the same reason as {@link #matchingThreads}.
   */
  #matchingCrons(query: CronSearchQuery): Cron[] {
    const matched = [...this.#crons.values()].filter(
      (cron) =>
        (query.assistant_id === undefined || cron.assistant_id === query.assistant_id) &&
        (query.thread_id === undefined || cron.thread_id === query.thread_id) &&
        (query.enabled === undefined || cron.enabled === query.enabled) &&
        isMetadataSubset(cron.metadata, query.metadata) &&
        // The server's own scoping, AND-ed with the caller's filter — see `enforcedMetadata`.
        isMetadataSubset(cron.metadata, query.enforcedMetadata),
    );
    const sortBy = query.sortBy ?? "created_at";
    const direction = query.sortOrder === "asc" ? 1 : -1;
    const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    matched.sort((a, b) => {
      // `next_run_date` is nullable (a dormant cron), and null sorts LAST in both directions to match
      // the Postgres driver's explicit `NULLS LAST`. Everything else compares as a string, which is
      // correct for ISO timestamps and ids alike.
      const left = a[sortBy] ?? null;
      const right = b[sortBy] ?? null;
      let primary: number;
      if (left === null && right === null) primary = 0;
      // Pre-multiplied by the direction so the null still lands last once the sign is applied below.
      else if (left === null) primary = direction;
      else if (right === null) primary = -direction;
      else primary = compare(String(left), String(right));
      // Break ties on cron_id in the same direction, so paging is deterministic and matches the
      // Postgres driver's `ORDER BY <sortBy> <dir> NULLS LAST, cron_id <dir>`.
      const ordered = primary !== 0 ? primary : compare(a.cron_id, b.cron_id);
      return direction * ordered;
    });
    return matched;
  }

  readonly crons: CronRepo = {
    get: async (cronId) => readOne(this.#crons, cronId),
    search: async (query: CronSearchQuery) =>
      clonePage(this.#matchingCrons(query), query.offset ?? 0, this.#pageLimit(query.limit)),
    count: async (query: CronSearchQuery) => this.#matchingCrons(query).length,
    create: async (input: CronCreate) => {
      const cronId = input.cron_id ?? randomUUID();
      if (this.#crons.has(cronId)) {
        throw SkeinHttpError.conflict(`Cron "${cronId}" already exists.`);
      }
      const at = nowIso();
      const cron: Cron = {
        cron_id: cronId,
        assistant_id: input.assistant_id,
        thread_id: input.thread_id ?? null,
        schedule: input.schedule,
        timezone: input.timezone ?? null,
        end_time: input.end_time ?? null,
        next_run_date: input.next_run_date ?? null,
        enabled: input.enabled ?? true,
        payload: input.payload ?? {},
        metadata: input.metadata ?? {},
        user_id: input.user_id ?? null,
        created_at: at,
        updated_at: at,
        // Absent rather than null on a thread cron: the field only means anything for the per-fire
        // thread a stateless cron creates, and the wire type has it optional for exactly that reason.
        ...(input.on_run_completed ? { on_run_completed: input.on_run_completed } : {}),
      };
      if (input.auth) this.#cronAuth.set(cronId, clone(input.auth));
      this.#cronSeq.set(cronId, 0);
      return write(this.#crons, cronId, cron);
    },
    update: async (cronId, patch: CronUpdate) => {
      const existing = this.#crons.get(cronId);
      if (!existing) throw SkeinHttpError.notFound(`Cron "${cronId}" not found.`);
      const updated: Cron = {
        ...existing,
        schedule: patch.schedule ?? existing.schedule,
        // Tri-state: `undefined` leaves the stored value, an explicit `null` clears it. `??` would
        // conflate the two and make "clear my end date" unexpressible.
        timezone: patch.timezone !== undefined ? patch.timezone : existing.timezone,
        end_time: patch.end_time !== undefined ? patch.end_time : existing.end_time,
        next_run_date:
          patch.next_run_date !== undefined ? patch.next_run_date : existing.next_run_date,
        enabled: patch.enabled ?? existing.enabled,
        payload: patch.payload ?? existing.payload,
        // metadata MERGES (shallow), matching assistants and LangGraph's own PATCH semantics.
        metadata:
          patch.metadata !== undefined
            ? { ...existing.metadata, ...patch.metadata }
            : existing.metadata,
        updated_at: nowIso(),
        ...(patch.on_run_completed !== undefined
          ? { on_run_completed: patch.on_run_completed }
          : {}),
      };
      // Every write bumps the claim token, so a claim raced by this patch loses and the scheduler
      // re-reads next tick instead of firing against a payload the caller has just replaced.
      this.#bumpCronSeq(cronId);
      return write(this.#crons, cronId, updated);
    },
    delete: async (cronId) => {
      this.#crons.delete(cronId);
      this.#cronAuth.delete(cronId);
      this.#cronSeq.delete(cronId);
    },
    listDue: async (query) =>
      clonePage(
        this.#matchingCrons({ enabled: true })
          .filter((cron) => cron.next_run_date != null && cron.next_run_date <= query.dueAt)
          // Soonest first, so a truncated scan still drains the backlog in order — with `cron_id`
          // breaking ties, matching the Postgres driver's `ORDER BY next_run_date ASC, cron_id ASC`.
          // Without the tiebreak, crons sharing an occurrence come back in an unrelated order and a
          // capped batch selects a different subset per driver — which, being stable, can starve the
          // same crons tick after tick here while Postgres rotates through them.
          .sort((a, b) => {
            const byDate = (a.next_run_date ?? "").localeCompare(b.next_run_date ?? "");
            return byDate !== 0 ? byDate : a.cron_id.localeCompare(b.cron_id);
          }),
        0,
        this.#pageLimit(query.limit),
      ).map((cron) => ({ cron, occurrenceSeq: this.#cronSeq.get(cron.cron_id) ?? 0 })),
    // Atomic for free, and deliberately written to stay that way — the same rule `createIfThreadIdle`
    // documents. The compare, the advance and the run insert all run in one event-loop turn because
    // nothing between them suspends. Introducing an `await` above the writes would silently reopen
    // the race this method exists to close, and would break the two-schedulers conformance case.
    claimAndCreateRun: async (cronId, claim, runInput) => {
      const advanced = this.#claimCron(cronId, claim);
      if (!advanced) return null;
      const run = await this.runs.create(runInput);
      return { cron: advanced, run };
    },
    claimNextRun: async (cronId, claim) => this.#claimCron(cronId, claim),
    getAuth: async (cronId) => {
      const found = this.#cronAuth.get(cronId);
      return found ? clone(found) : null;
    },
    maxOverdueMs: async (now) => {
      const at = Date.parse(now);
      let worst: number | null = null;
      for (const cron of this.#crons.values()) {
        if (!cron.enabled || cron.next_run_date == null) continue;
        const overdue = at - Date.parse(cron.next_run_date);
        if (overdue >= 0 && (worst === null || overdue > worst)) worst = overdue;
      }
      return worst;
    },
  };

  readonly store: StoreRepo = {
    get: async (namespace, key) => {
      const id = itemKey(namespace, key);
      const found = this.#items.get(id);
      if (!found) return null;
      // Lazy expiry: an expired item reads as absent even before the sweeper deletes it.
      if (this.#isExpired(id)) {
        this.#items.delete(id);
        this.#itemExpiry.delete(id);
        return null;
      }
      this.#maybeRefresh(id);
      return clone(found);
    },
    put: async (namespace, key, value, options?: StorePutOptions) => {
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
      // A per-put ttl wins; otherwise the configured default (null = never expires).
      this.#setExpiry(id, options?.ttl ?? this.#ttl?.defaultTtl ?? null);
      return clone(stored);
    },
    delete: async (namespace, key) => {
      const id = itemKey(namespace, key);
      this.#items.delete(id);
      this.#itemExpiry.delete(id);
    },
    search: async (query: StoreSearchQuery) => {
      const needle = query.query?.toLowerCase();
      // Stored references, filtered in place; only the page is cloned and scored below.
      const matches: SearchItem[] = [...this.#items.entries()]
        .filter(([id]) => !this.#isExpired(id))
        .map(([, item]) => item)
        .filter((item) => hasPrefix(item.namespace, query.prefix))
        .filter((item) =>
          needle ? JSON.stringify(item.value).toLowerCase().includes(needle) : true,
        );

      const page = clonePage(matches, query.offset ?? 0, this.#pageLimit(query.limit));
      // Naive relevance: any query is an exact-substring hit, so score 1 (pgvector does the real
      // semantic ranking in the Postgres driver).
      if (needle) for (const item of page) item.score = 1;
      return page;
    },
    listNamespaces: async (prefix, pagination) => {
      // Key by JSON.stringify (not join) so distinct namespaces whose segments contain the
      // separator can't collide.
      const seen = new Map<string, string[]>();
      for (const [id, item] of this.#items.entries()) {
        if (this.#isExpired(id)) continue;
        if (hasPrefix(item.namespace, prefix)) {
          seen.set(JSON.stringify(item.namespace), item.namespace);
        }
      }
      const namespaces = [...seen.values()].map((namespace) => [...namespace]);
      const offset = pagination?.offset ?? 0;
      const end = pagination?.limit === undefined ? undefined : offset + pagination.limit;
      return namespaces.slice(offset, end);
    },
    sweepExpired: async () => {
      let removed = 0;
      for (const id of [...this.#itemExpiry.keys()]) {
        if (this.#isExpired(id)) {
          this.#items.delete(id);
          this.#itemExpiry.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };

  /**
   * A JSON-serializable copy of every row, so `skein dev` can persist dev state to disk and
   * restore it on the next boot. Rows are deep-cloned at the boundary, exactly like the repo reads.
   */
  snapshot(): MemoryStoreSnapshot {
    const entries = <T>(map: Map<string, T>): [string, T][] =>
      [...map.entries()].map(([id, row]) => [id, clone(row)]);
    return {
      assistants: entries(this.#assistants),
      assistantVersions: entries(this.#assistantVersions),
      threads: entries(this.#threads),
      runs: entries(this.#runs),
      runKwargs: entries(this.#runKwargs),
      items: entries(this.#items),
      // This is what gives `skein dev` cron persistence across restarts for free. `#cronAuth` is
      // deliberately not persisted: a snapshot is written to disk, and a caller's permission scopes
      // are not something to leave in `.skein/`.
      crons: entries(this.#crons),
    };
  }

  /** Replace all rows with a {@link snapshot}. Used by `skein dev` to restore persisted dev state. */
  hydrate(snapshot: MemoryStoreSnapshot): void {
    const fill = <T>(map: Map<string, T>, rows: [string, T][]): void => {
      map.clear();
      for (const [id, row] of rows) map.set(id, clone(row));
    };
    fill(this.#assistants, snapshot.assistants);
    fill(this.#assistantVersions, snapshot.assistantVersions ?? []);
    fill(this.#threads, snapshot.threads);
    fill(this.#runs, snapshot.runs);
    fill(this.#runKwargs, snapshot.runKwargs);
    fill(this.#items, snapshot.items);
    fill(this.#crons, snapshot.crons ?? []);
    // A restored cron starts its claim sequence from zero — the token only has to be consistent
    // *within* a process, since a claim never outlives the tick that took it.
    this.#cronSeq.clear();
    for (const cronId of this.#crons.keys()) this.#cronSeq.set(cronId, 0);
    // Thread expiry is re-derived rather than carried: `fill` above replaced `#threads` wholesale, so
    // leaving the old map would age *new* threads by ids that are gone. Restored threads take the
    // configured default from now — the snapshot has no `expires_at`, so the alternative is either an
    // invented deadline or a thread that can never expire. Matches `#itemExpiry` below, which is
    // cleared for the same reason.
    this.#threadExpiry.clear();
    for (const threadId of this.#threads.keys()) this.#setThreadExpiry(threadId, undefined);
    // Credentials are deliberately not in the snapshot — it is written to `.skein/` on disk. So a
    // restored cron keeps its `user_id` but loses the principal behind it, and the scheduler refuses
    // to fire that combination rather than running it unowned (see `fireCron`). On an
    // unauthenticated server there is no `user_id` to begin with, so `skein dev` is unaffected.
    this.#cronAuth.clear();
    // Backfill a version snapshot for any assistant restored from a pre-versioning dev-state file
    // (which has no assistantVersions), so getVersions/setLatest work and the next update mints
    // max+1 with no gap. Uses the row's current version, since older history wasn't persisted.
    for (const assistant of this.#assistants.values()) {
      if (this.#maxVersionOf(assistant.assistant_id) === 0) {
        this.#assistantVersions.set(
          versionKey(assistant.assistant_id, assistant.version),
          clone(toVersion(assistant)),
        );
      }
    }
    // Item expiry is not persisted; a restored item won't expire until it is written again.
    this.#itemExpiry.clear();
  }

  /**
   * Bulk-load rows from a snapshot, preserving ids + timestamps and *without* clearing what's
   * already here: existing ids are left untouched (insert-if-absent). Unlike {@link hydrate} (a
   * full replace for cross-restart persistence), this is the additive, lossless sink used by
   * migration tooling — see the LangGraph importer in `@skein-js/server-kit/dev`. `loadSnapshotIntoStore`
   * feature-detects this method, so the memory and Postgres drivers import identically.
   */
  async restore(snapshot: SkeinStoreSnapshot): Promise<void> {
    const add = <T>(map: Map<string, T>, rows: [string, T][]): void => {
      for (const [id, row] of rows) if (!map.has(id)) map.set(id, clone(row));
    };
    add(this.#assistants, snapshot.assistants);
    add(this.#assistantVersions, snapshot.assistantVersions ?? []);
    add(this.#threads, snapshot.threads);
    add(this.#runs, snapshot.runs);
    add(this.#runKwargs, snapshot.runKwargs);
    add(this.#items, snapshot.items);
    // Crons go in after threads, since a thread cron references one. A cron whose thread is absent
    // from the import is skipped rather than restored dangling — the same rule the Postgres driver's
    // foreign key enforces for it, and what `runs` already does there.
    add(
      this.#crons,
      (snapshot.crons ?? []).filter(
        ([, cron]) => cron.thread_id == null || this.#threads.has(cron.thread_id),
      ),
    );
    for (const cronId of this.#crons.keys()) {
      if (!this.#cronSeq.has(cronId)) this.#cronSeq.set(cronId, 0);
    }
  }
}

/**
 * A JSON-serializable copy of a {@link MemorySkeinStore}'s rows. An alias of the driver-agnostic
 * {@link SkeinStoreSnapshot} (identical shape); the name predates the shared type and is kept so
 * the dev-persistence snapshot format reads the same.
 */
export type MemoryStoreSnapshot = SkeinStoreSnapshot;
