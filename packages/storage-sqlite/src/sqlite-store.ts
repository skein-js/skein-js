import { randomUUID } from "node:crypto";

import {
  DEFAULT_MAX_PAGE_SIZE,
  requireValidMaxPageSize,
  isMetadataSubset,
  matchesItemFilter,
  matchesNamespacePrefix,
  matchesNamespaceQuery,
  isTerminalRunStatus,
  SkeinHttpError,
  type Assistant,
  type AssistantVersion,
  type AssistantRepo,
  type Thread,
  type ThreadRepo,
  type Run,
  type RunCreate,
  type RunRepo,
  type RunResult,
  serializeWireJson,
  type RunKwargs,
  type Cron,
  type CronRepo,
  type CronClaim,
  type Delivery,
  type DeliveryCreate,
  type DeliveryRepo,
  type StoreRepo,
  type Item,
  type SearchItem,
  type IdempotencyRecord,
  type IdempotencyRepo,
  type SkeinStore,
  type StoreTtlConfig,
  type ThreadTtlConfig,
} from "@skein-js/core";
import type { Database } from "better-sqlite3";

type Table =
  | "assistants"
  | "assistant_versions"
  | "threads"
  | "runs"
  | "items"
  | "crons"
  | "idempotency"
  | "deliveries";
const nowIso = (): string => new Date().toISOString();
const pairKey = (first: unknown, second: unknown): string => JSON.stringify([first, second]);
const json = (value: unknown): string => JSON.stringify(value);

/** JSON resources retain the wire shape; indexed generated columns carry relational constraints. */
export class SqliteSkeinStore implements SkeinStore {
  readonly durable = true;
  readonly maxPageSize: number;
  constructor(
    readonly database: Database,
    readonly options: {
      maxPageSize?: number;
      ttl?: StoreTtlConfig;
      threadTtl?: ThreadTtlConfig;
    },
    readonly notifyQueue: () => void = () => {},
  ) {
    this.maxPageSize = requireValidMaxPageSize(options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE);
    database.function("skein_matches", { deterministic: true }, (bodyText, queryText) => {
      const row = JSON.parse(String(bodyText));
      const query = JSON.parse(String(queryText));
      return Number(
        ["graph_id", "name", "status", "assistant_id", "thread_id", "enabled"].every(
          (key) =>
            query[key] === undefined ||
            (key === "name" && query.nameMatch === "substring"
              ? String(row[key]).toLowerCase().includes(String(query[key]).toLowerCase())
              : row[key] === query[key]),
        ) &&
          (query.ids === undefined || query.ids.includes(row.thread_id)) &&
          isMetadataSubset(row.metadata, query.metadata) &&
          !(
            Array.isArray(query.excludeMetadata)
              ? query.excludeMetadata
              : query.excludeMetadata
                ? [query.excludeMetadata]
                : []
          ).some((excluded: Record<string, unknown>) => isMetadataSubset(row.metadata, excluded)) &&
          isMetadataSubset(row.metadata, query.enforcedMetadata) &&
          isMetadataSubset(row.values, query.values),
      );
    });
    database.function("skein_namespace_order", { deterministic: true }, (namespaceText) => {
      const namespace = JSON.parse(String(namespaceText)) as string[];
      return namespace
        .map(
          (segment) =>
            segment
              .split("")
              .map((character) => character.charCodeAt(0).toString(16).padStart(4, "0"))
              .join("") + "!",
        )
        .join("");
    });
    database.function("skein_namespace", { deterministic: true }, (bodyText, queryText) => {
      const row = JSON.parse(String(bodyText));
      const query = JSON.parse(String(queryText));
      return matchesNamespaceQuery(row.namespace, query)
        ? json(
            query.maxDepth === undefined ? row.namespace : row.namespace.slice(0, query.maxDepth),
          )
        : null;
    });
  }

  private limit(limit?: number): number {
    return Math.min(limit ?? this.maxPageSize, this.maxPageSize);
  }
  private get<T>(table: Table, key: string): T | null {
    const row = this.database.prepare(`SELECT body FROM skein_${table} WHERE key = ?`).get(key) as
      { body: string } | undefined;
    return row ? (JSON.parse(row.body) as T) : null;
  }
  private require<T>(table: Table, key: string): T {
    const row = this.get<T>(table, key);
    if (!row) throw SkeinHttpError.notFound(`${table} "${key}" not found.`);
    return row;
  }
  private write<T>(table: Table, key: string, row: T): T {
    this.database
      .prepare(
        `INSERT INTO skein_${table}(key,body) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body`,
      )
      .run(key, json(row));
    return JSON.parse(json(row)) as T;
  }
  private insert<T>(table: Table, key: string, row: T): T {
    if (this.get(table, key)) throw SkeinHttpError.conflict(`${table} "${key}" already exists.`);
    return this.write(table, key, row);
  }
  private delete(table: Table, key: string): void {
    this.database.prepare(`DELETE FROM skein_${table} WHERE key=?`).run(key);
  }
  private rows<T>(sql: string, ...parameters: (string | number | null)[]): T[] {
    return (this.database.prepare(sql).all(...parameters) as { body: string }[]).map(
      ({ body }) => JSON.parse(body) as T,
    );
  }
  private search<T>(
    table: Table,
    id: string,
    query: { limit?: number; offset?: number; sortBy?: string; sortOrder?: string },
  ): T[] {
    // The sort key is never interpolated: it is a bound JSON path. Filters precede LIMIT/OFFSET.
    const path = `$.${query.sortBy ?? "created_at"}`;
    const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
    return this.rows(
      `SELECT body FROM skein_${table} WHERE skein_matches(body,?) ORDER BY
      json_extract(body,?) IS NULL, json_extract(body,?) ${direction}, json_extract(body,?) ${direction} LIMIT ? OFFSET ?`,
      json(query),
      path,
      path,
      `$.${id}`,
      this.limit(query.limit),
      query.offset ?? 0,
    );
  }
  private count(table: Table, query: unknown): number {
    return (
      this.database
        .prepare(`SELECT count(*) AS count FROM skein_${table} WHERE skein_matches(body,?)`)
        .get(json(query)) as { count: number }
    ).count;
  }
  private version(assistant: Assistant, createdAt = assistant.created_at): void {
    const { updated_at: _updated, ...version } = assistant;
    this.write("assistant_versions", pairKey(assistant.assistant_id, assistant.version), {
      ...version,
      created_at: createdAt,
    });
  }
  readonly assistants: AssistantRepo = {
    get: async (id) => this.get("assistants", id),
    list: async () => this.search("assistants", "assistant_id", { sortOrder: "asc" }),
    search: async (query) => this.search("assistants", "assistant_id", query),
    count: async (query) => this.count("assistants", query),
    create: async (input) =>
      this.database.transaction(() => {
        const at = nowIso();
        const id = input.assistant_id ?? randomUUID();
        const row = this.insert<Assistant>("assistants", id, {
          assistant_id: id,
          graph_id: input.graph_id,
          config: input.config ?? {},
          context: input.context ?? {},
          metadata: input.metadata ?? {},
          version: 1,
          name: input.name ?? input.graph_id,
          description: input.description,
          created_at: at,
          updated_at: at,
        });
        this.version(row);
        return row;
      })(),
    update: async (id, patch) =>
      this.database.transaction(() => {
        const existing = this.require<Assistant>("assistants", id);
        const highest = (
          this.database
            .prepare(
              "SELECT coalesce(max(json_extract(body,'$.version')),0) AS version FROM skein_assistant_versions WHERE assistant_id=?",
            )
            .get(id) as { version: number }
        ).version;
        const row = this.write("assistants", id, {
          ...existing,
          graph_id: patch.graph_id ?? existing.graph_id,
          name: patch.name ?? existing.name,
          description: patch.description !== undefined ? patch.description : existing.description,
          config: patch.config ?? existing.config,
          context: patch.context !== undefined ? patch.context : existing.context,
          metadata: { ...existing.metadata, ...patch.metadata },
          version: highest + 1,
          updated_at: nowIso(),
        });
        this.version(row, row.updated_at);
        return row;
      })(),
    delete: async (id) => this.delete("assistants", id),
    listVersions: async (id, query) =>
      this.rows<AssistantVersion>(
        "SELECT body FROM skein_assistant_versions WHERE assistant_id=? AND skein_matches(body,?) ORDER BY json_extract(body,'$.version') DESC LIMIT ? OFFSET ?",
        id,
        json(query ?? {}),
        this.limit(query?.limit),
        query?.offset ?? 0,
      ),
    setLatest: async (id, version) => {
      const existing = this.require<Assistant>("assistants", id);
      const selected = this.require<AssistantVersion>("assistant_versions", pairKey(id, version));
      return this.write("assistants", id, {
        ...existing,
        ...selected,
        created_at: existing.created_at,
        updated_at: nowIso(),
      });
    },
  };
  private threadRetention(id: string): { ttl?: number | null; strategy: "delete" | "keep_latest" } {
    const row = this.database
      .prepare("SELECT ttl_minutes,ttl_strategy,ttl_pinned FROM skein_threads WHERE key=?")
      .get(id) as
      | {
          ttl_minutes: number | null;
          ttl_strategy: "delete" | "keep_latest" | null;
          ttl_pinned: number;
        }
      | undefined;
    return {
      ttl: row?.ttl_pinned ? null : (row?.ttl_minutes ?? this.options.threadTtl?.defaultTtl),
      strategy: row?.ttl_strategy ?? this.options.threadTtl?.strategy ?? "delete",
    };
  }
  private threadExpiry(
    id: string,
    minutes?: number | null,
    strategy?: "delete" | "keep_latest",
  ): void {
    const current = this.threadRetention(id);
    const resolved = minutes === undefined ? current.ttl : minutes;
    this.database
      .prepare(
        "UPDATE skein_threads SET expires_at=?,ttl_minutes=?,ttl_pinned=?,ttl_strategy=? WHERE key=?",
      )
      .run(
        resolved == null ? null : Date.now() + resolved * 60_000,
        resolved ?? null,
        resolved === null ? 1 : 0,
        strategy ?? current.strategy,
        id,
      );
  }
  readonly threads: ThreadRepo = {
    getTtl: async (id) => this.threadRetention(id),
    get: async (id) => this.get("threads", id),
    list: async () => this.search("threads", "thread_id", { sortOrder: "asc" }),
    search: async (query) => this.search("threads", "thread_id", query),
    count: async (query) => this.count("threads", query),
    create: async (input = {}) =>
      this.database.transaction(() => {
        const at = nowIso();
        const id = input.thread_id ?? randomUUID();
        const row = this.insert<Thread>("threads", id, {
          thread_id: id,
          metadata: input.metadata ?? {},
          status: input.status ?? "idle",
          values: {},
          interrupts: {},
          created_at: at,
          updated_at: at,
          state_updated_at: at,
        });
        this.threadExpiry(id, input.ttl, input.ttlStrategy);
        return row;
      })(),
    update: async (id, patch) =>
      this.database.transaction(() => {
        const existing = this.require<Thread>("threads", id);
        const { error: oldError, ...rest } = existing;
        const error = patch.error === undefined ? oldError : patch.error;
        const at = nowIso();
        const row = this.write("threads", id, {
          ...rest,
          metadata: patch.metadata ?? existing.metadata,
          status: patch.status ?? existing.status,
          values: patch.values ?? existing.values,
          interrupts: patch.interrupts ?? existing.interrupts,
          updated_at: at,
          state_updated_at: patch.values !== undefined ? at : existing.state_updated_at,
          ...(error == null ? {} : { error }),
        });
        if (
          patch.ttl !== undefined ||
          patch.ttlStrategy !== undefined ||
          (patch.values !== undefined && this.threadRetention(id).strategy === "keep_latest")
        )
          this.threadExpiry(id, patch.ttl, patch.ttlStrategy);
        return row;
      })(),
    copy: async (id) =>
      this.database.transaction(() => {
        const original = this.require<Thread>("threads", id);
        const copiedId = randomUUID();
        const at = nowIso();
        const row = this.write("threads", copiedId, {
          ...original,
          thread_id: copiedId,
          created_at: at,
          updated_at: at,
          state_updated_at: at,
        });
        this.threadExpiry(copiedId);
        return row;
      })(),
    delete: async (id) => this.delete("threads", id),
    listExpired: async (query) =>
      (
        this.database
          .prepare(
            "SELECT key FROM skein_threads WHERE expires_at<=? AND (COALESCE(ttl_strategy,?) != 'keep_latest' OR NOT EXISTS (SELECT 1 FROM skein_runs WHERE thread_id=skein_threads.key AND status IN ('pending','running'))) ORDER BY expires_at,key LIMIT ?",
          )
          .all(
            Date.parse(query.now),
            this.options.threadTtl?.strategy ?? "delete",
            this.limit(query.limit),
          ) as { key: string }[]
      ).map((row) => row.key),
  };
  private createRun(input: RunCreate): Run {
    const at = nowIso();
    const id = input.run_id ?? randomUUID();
    const row = this.insert<Run>("runs", id, {
      run_id: id,
      thread_id: input.thread_id,
      assistant_id: input.assistant_id,
      status: input.status ?? "pending",
      metadata: input.metadata ?? {},
      multitask_strategy: input.multitask_strategy ?? null,
      created_at: at,
      updated_at: at,
    });
    if (input.kwargs)
      this.database
        .prepare("UPDATE skein_runs SET kwargs=? WHERE key=?")
        .run(json(input.kwargs), id);
    if (row.status === "pending" && input.kwargs?.queue_not_before !== undefined) {
      const due = Date.parse(input.kwargs.queue_not_before);
      if (!Number.isFinite(due)) throw new Error("queue_not_before must be an ISO timestamp.");
      this.database
        .prepare("INSERT INTO skein_run_jobs(run_id,thread_id,due_at) VALUES (?,?,?)")
        .run(id, input.thread_id, due);
    }
    if (row.status === "pending" && input.kwargs?.queue_not_before !== undefined)
      this.notifyQueue();
    return row;
  }
  private hasActiveRun(threadId: string): boolean {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 FROM skein_runs WHERE thread_id=? AND status IN ('pending','running') LIMIT 1",
        )
        .get(threadId),
    );
  }
  private setRunStatus(id: string, status: Run["status"], error?: Run["error"]): Run {
    const { error: _previous, ...existing } = this.require<Run>("runs", id);
    return this.write("runs", id, {
      ...existing,
      status,
      updated_at: nowIso(),
      ...(error ? { error } : {}),
    });
  }
  readonly runs: RunRepo = {
    recordResult: async (id, result) => {
      if (this.get("runs", id))
        this.database
          .prepare("UPDATE skein_runs SET result=? WHERE key=? AND result IS NULL")
          .run(serializeWireJson(result), id);
    },
    getResult: async (id) => {
      const row = this.database.prepare("SELECT result FROM skein_runs WHERE key=?").get(id) as
        { result: string | null } | undefined;
      return row?.result ? (JSON.parse(row.result) as RunResult) : null;
    },
    get: async (id) => this.get("runs", id),
    listByThread: async (id, query) =>
      this.rows(
        "SELECT body FROM skein_runs WHERE thread_id=? AND (? IS NULL OR status=?) ORDER BY rowid LIMIT ? OFFSET ?",
        id,
        query?.status ?? null,
        query?.status ?? null,
        query?.limit ?? -1,
        query?.offset ?? 0,
      ),
    latestForThread: async (id) =>
      this.rows<Run>(
        "SELECT body FROM skein_runs WHERE thread_id=? ORDER BY json_extract(body,'$.created_at') DESC,key DESC LIMIT 1",
        id,
      )[0] ?? null,
    create: async (input) => this.database.transaction(() => this.createRun(input))(),
    createIfThreadIdle: async (input) =>
      this.database.transaction(() =>
        !this.get("threads", input.thread_id) || this.hasActiveRun(input.thread_id)
          ? null
          : this.createRun(input),
      )(),
    createIfThreadMatches: async (input, guard) =>
      this.database.transaction(() => {
        const thread = this.require<Thread>("threads", input.thread_id);
        if (guard.threadStatusIn && !guard.threadStatusIn.includes(thread.status))
          return { refused: "thread_status_mismatch" as const, status: thread.status };
        if (guard.requireNoActiveRun && this.hasActiveRun(input.thread_id))
          return { refused: "thread_busy" as const };
        return { run: this.createRun(input) };
      })(),
    setStatus: async (id, status, error) => this.setRunStatus(id, status, error),
    delete: async (id) => this.delete("runs", id),
    getKwargs: async (id) => {
      const row = this.database.prepare("SELECT kwargs FROM skein_runs WHERE key=?").get(id) as
        { kwargs: string | null } | undefined;
      return row?.kwargs ? (JSON.parse(row.kwargs) as RunKwargs) : null;
    },
    recordBaseCheckpoint: async (id, checkpointId) => {
      this.database
        .prepare(
          "UPDATE skein_runs SET kwargs=json_set(coalesce(kwargs,'{}'),'$.base_checkpoint_id',?) WHERE key=?",
        )
        .run(checkpointId, id);
    },
    hasActiveRun: async (id) => this.hasActiveRun(id),
    listActiveRuns: async (id) =>
      this.rows(
        "SELECT body FROM skein_runs WHERE status IN ('pending','running') AND (? IS NULL OR thread_id=?) LIMIT ?",
        id ?? null,
        id ?? null,
        this.maxPageSize,
      ),
    finalizeWithDelivery: async (id, final) =>
      this.database.transaction(() => {
        const existing = this.get<Run>("runs", id);
        const run =
          existing && !isTerminalRunStatus(existing.status)
            ? this.setRunStatus(id, final.status, final.error)
            : existing;
        return {
          run,
          delivery: this.insertDelivery(id, run?.status ?? final.status, final.delivery),
        };
      })(),
  };
  private claimCron(id: string, claim: CronClaim): Cron | null {
    const row = this.get<Cron>("crons", id);
    const token = this.database
      .prepare("SELECT occurrence_seq FROM skein_crons WHERE key=?")
      .get(id) as { occurrence_seq: number } | undefined;
    if (!row?.enabled || token?.occurrence_seq !== claim.expectedSeq) return null;
    this.database
      .prepare("UPDATE skein_crons SET occurrence_seq=occurrence_seq+1 WHERE key=?")
      .run(id);
    return this.write("crons", id, {
      ...row,
      next_run_date: claim.nextRunDate,
      updated_at: nowIso(),
    });
  }
  readonly crons: CronRepo = {
    get: async (id) => this.get("crons", id),
    search: async (query) => this.search("crons", "cron_id", query),
    count: async (query) => this.count("crons", query),
    create: async (input) =>
      this.database.transaction(() => {
        const at = nowIso();
        const id = input.cron_id ?? randomUUID();
        const cron = this.insert<Cron>("crons", id, {
          cron_id: id,
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
          ...(input.on_run_completed ? { on_run_completed: input.on_run_completed } : {}),
        });
        if (input.auth)
          this.database
            .prepare("UPDATE skein_crons SET auth=? WHERE key=?")
            .run(json(input.auth), id);
        return cron;
      })(),
    update: async (id, patch) =>
      this.database.transaction(() => {
        const row = this.require<Cron>("crons", id);
        const definedPatch = Object.fromEntries(
          Object.entries(patch).filter(([, value]) => value !== undefined),
        );
        const updated = this.write("crons", id, {
          ...row,
          ...definedPatch,
          metadata: { ...row.metadata, ...patch.metadata },
          updated_at: nowIso(),
        });
        this.database
          .prepare("UPDATE skein_crons SET occurrence_seq=occurrence_seq+1 WHERE key=?")
          .run(id);
        return updated;
      })(),
    delete: async (id) => this.delete("crons", id),
    listDue: async (query) => {
      const rows = this.database
        .prepare(
          "SELECT body,occurrence_seq FROM skein_crons WHERE json_extract(body,'$.enabled')=1 AND json_extract(body,'$.next_run_date')<=? ORDER BY json_extract(body,'$.next_run_date'),key LIMIT ?",
        )
        .all(query.dueAt, this.limit(query.limit)) as { body: string; occurrence_seq: number }[];
      return rows.map((row) => ({
        cron: JSON.parse(row.body) as Cron,
        occurrenceSeq: row.occurrence_seq,
      }));
    },
    claimNextRun: async (id, claim) => this.database.transaction(() => this.claimCron(id, claim))(),
    claimAndCreateRun: async (id, claim, input) =>
      this.database.transaction(() => {
        const cron = this.claimCron(id, claim);
        return cron ? { cron, run: this.createRun(input) } : null;
      })(),
    getAuth: async (id) => {
      const row = this.database.prepare("SELECT auth FROM skein_crons WHERE key=?").get(id) as
        { auth: string | null } | undefined;
      return row?.auth ? JSON.parse(row.auth) : null;
    },
    maxOverdueMs: async (now) => {
      const row = this.database
        .prepare(
          "SELECT min(json_extract(body,'$.next_run_date')) AS due FROM skein_crons WHERE json_extract(body,'$.enabled')=1 AND json_extract(body,'$.next_run_date')<=?",
        )
        .get(now) as { due: string | null };
      return row.due ? Date.parse(now) - Date.parse(row.due) : null;
    },
  };
  readonly store: StoreRepo = {
    get: async (namespace, key, options) =>
      this.database.transaction(() => {
        const id = pairKey(namespace, key);
        this.database
          .prepare("DELETE FROM skein_items WHERE key=? AND expires_at<=?")
          .run(id, Date.now());
        const item = this.get<Item>("items", id);
        if (
          item &&
          (options?.refreshTtl ??
            (this.options.ttl !== undefined && this.options.ttl.refreshOnRead !== false))
        ) {
          this.database
            .prepare(
              "UPDATE skein_items SET expires_at=? + ttl_minutes*60000 WHERE key=? AND ttl_minutes IS NOT NULL",
            )
            .run(Date.now(), id);
        }
        return item;
      })(),
    put: async (namespace, key, value, options) =>
      this.store.putWithOptions!(namespace, key, value, options),
    putWithOptions: async (namespace, key, value, options) =>
      this.database.transaction(() => {
        const id = pairKey(namespace, key);
        const at = nowIso();
        const existing = this.get<Item>("items", id);
        const row = this.write("items", id, {
          namespace: [...namespace],
          key,
          value,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        });
        const minutes =
          options?.ttl === undefined ? (this.options.ttl?.defaultTtl ?? null) : options.ttl;
        this.database
          .prepare("UPDATE skein_items SET expires_at=?,ttl_minutes=?,index_fields=? WHERE key=?")
          .run(
            minutes == null ? null : Date.now() + minutes * 60_000,
            minutes,
            options?.index === undefined ? null : json(options.index),
            id,
          );
        return row;
      })(),
    delete: async (namespace, key) => this.delete("items", pairKey(namespace, key)),
    search: async (query) => {
      // Capture the original filter: JSON serialization would erase explicit undefined operands.
      this.database.function("skein_search_item", (bodyText, indexText) => {
        const item = JSON.parse(String(bodyText));
        const index =
          indexText == null ? undefined : (JSON.parse(String(indexText)) as false | string[]);
        const indexed =
          index && !index.includes("$")
            ? Object.fromEntries(index.map((field) => [field, item.value[field]]))
            : item.value;
        return Number(
          (!query.prefix || matchesNamespacePrefix(item.namespace, query.prefix)) &&
            matchesItemFilter(item.value, query.filter) &&
            (!query.query ||
              (index !== false &&
                index?.length !== 0 &&
                json(indexed).toLowerCase().includes(query.query.toLowerCase()))),
        );
      });
      const rows = this.rows<SearchItem>(
        "SELECT body FROM skein_items WHERE (expires_at IS NULL OR expires_at>?) AND skein_search_item(body,index_fields) ORDER BY rowid LIMIT ? OFFSET ?",
        Date.now(),
        this.limit(query.limit),
        query.offset ?? 0,
      );
      if (
        query.refreshTtl ??
        (this.options.ttl !== undefined && this.options.ttl.refreshOnRead !== false)
      ) {
        this.database.transaction(() => {
          const refresh = this.database.prepare(
            "UPDATE skein_items SET expires_at=? + ttl_minutes*60000 WHERE key=? AND ttl_minutes IS NOT NULL",
          );
          for (const row of rows) refresh.run(Date.now(), pairKey(row.namespace, row.key));
        })();
      }
      return query.query ? rows.map((row) => ({ ...row, score: 1 })) : rows;
    },
    listNamespaces: async (query) => {
      // Deduplicate/truncate before paging. Hex ordering of UTF-8 segments matches namespace order.
      const rows = this.database
        .prepare(
          "SELECT DISTINCT skein_namespace(body,?) AS namespace FROM skein_items WHERE (expires_at IS NULL OR expires_at>?) AND skein_namespace(body,?) IS NOT NULL ORDER BY skein_namespace_order(namespace) LIMIT ? OFFSET ?",
        )
        .all(
          json(query ?? {}),
          Date.now(),
          json(query ?? {}),
          this.limit(query?.limit),
          query?.offset ?? 0,
        ) as { namespace: string }[];
      return rows.map((row) => JSON.parse(row.namespace) as string[]);
    },
    sweepExpired: async () =>
      this.database.prepare("DELETE FROM skein_items WHERE expires_at<=?").run(Date.now()).changes,
  };
  readonly idempotency: IdempotencyRepo = {
    get: async (scope, key) => this.get("idempotency", pairKey(scope, key)),
    claim: async (claim) =>
      this.database.transaction(() => {
        const id = pairKey(claim.scope, claim.key);
        const existing = this.get<IdempotencyRecord>("idempotency", id);
        if (existing && Date.parse(existing.expires_at) > Date.parse(claim.now))
          return { claimed: false, record: existing };
        const at = nowIso();
        const record = this.write<IdempotencyRecord>("idempotency", id, {
          scope: claim.scope,
          key: claim.key,
          fingerprint: claim.fingerprint,
          claim_id: claim.claim_id,
          status: "in_flight",
          created_at: existing?.created_at ?? at,
          updated_at: at,
          expires_at: claim.expires_at,
        });
        return { claimed: true, record };
      })(),
    record: async (scope, key, claimId, recorded) => {
      const id = pairKey(scope, key);
      const existing = this.get<IdempotencyRecord>("idempotency", id);
      if (!existing || existing.claim_id !== claimId) return;
      this.write("idempotency", id, {
        ...existing,
        status: "done",
        response: {
          status: recorded.status,
          body: recorded.body,
          ...(recorded.headers ? { headers: recorded.headers } : {}),
        },
        ...(recorded.run_id !== undefined ? { run_id: recorded.run_id } : {}),
        ...(recorded.thread_id !== undefined ? { thread_id: recorded.thread_id } : {}),
        expires_at: recorded.expires_at,
        updated_at: nowIso(),
      });
    },
    release: async (scope, key, claimId) => {
      this.database
        .prepare("DELETE FROM skein_idempotency WHERE key=? AND json_extract(body,'$.claim_id')=?")
        .run(pairKey(scope, key), claimId);
    },
    deleteByThread: async (id) =>
      this.database
        .prepare("DELETE FROM skein_idempotency WHERE json_extract(body,'$.thread_id')=?")
        .run(id).changes,
    deleteByRun: async (id) =>
      this.database
        .prepare("DELETE FROM skein_idempotency WHERE json_extract(body,'$.run_id')=?")
        .run(id).changes,
    sweepExpired: async (now) =>
      this.database
        .prepare("DELETE FROM skein_idempotency WHERE json_extract(body,'$.expires_at')<=?")
        .run(now).changes,
  };
  private insertDelivery(runId: string, status: Run["status"], input: DeliveryCreate): Delivery {
    const at = nowIso();
    const id = input.delivery_id ?? randomUUID();
    return this.insert<Delivery>("deliveries", id, {
      delivery_id: id,
      run_id: runId,
      thread_id: input.thread_id,
      url: input.url,
      payload: input.payload ?? null,
      payload_truncated: input.payload_truncated ?? false,
      run_status: status,
      status: "delivering",
      attempt: 1,
      next_attempt_at: input.next_attempt_at,
      last_error: null,
      created_at: at,
      updated_at: at,
      expires_at: input.expires_at,
    });
  }
  private dueDeliveries(now: string, limit?: number): Delivery[] {
    return this.rows(
      "SELECT body FROM skein_deliveries WHERE json_extract(body,'$.status') IN ('pending','delivering') AND json_extract(body,'$.next_attempt_at')<=? ORDER BY json_extract(body,'$.next_attempt_at'),key LIMIT ?",
      now,
      this.limit(limit),
    );
  }
  readonly deliveries: DeliveryRepo = {
    get: async (id) => this.get("deliveries", id),
    listByRun: async (id, query) =>
      this.rows(
        "SELECT body FROM skein_deliveries WHERE json_extract(body,'$.run_id')=? AND (? IS NULL OR json_extract(body,'$.status')=?) ORDER BY json_extract(body,'$.created_at') DESC,key DESC LIMIT ? OFFSET ?",
        id,
        query?.status ?? null,
        query?.status ?? null,
        this.limit(query?.limit),
        query?.offset ?? 0,
      ),
    listDue: async (query) => this.dueDeliveries(query.now, query.limit),
    claimDue: async (query) =>
      this.database.transaction(() =>
        this.dueDeliveries(query.now, query.limit).map((row) =>
          this.write("deliveries", row.delivery_id, {
            ...row,
            status: "delivering" as const,
            attempt: row.attempt + 1,
            next_attempt_at: query.leaseUntil,
            updated_at: nowIso(),
          }),
        ),
      )(),
    recordAttempt: async (id, result) => {
      const existing = this.get<Delivery>("deliveries", id);
      if (!existing) return null;
      const row =
        result.outcome === "delivered"
          ? { ...existing, status: "delivered" as const, payload: null, last_error: null }
          : result.outcome === "dead"
            ? { ...existing, status: "dead" as const, last_error: result.error }
            : {
                ...existing,
                status: "pending" as const,
                last_error: result.error,
                next_attempt_at: result.nextAttemptAt,
              };
      return this.write("deliveries", id, {
        ...row,
        attempt: result.attempt ?? existing.attempt,
        updated_at: nowIso(),
      });
    },
    retryNow: async (id, at) => {
      const row = this.get<Delivery>("deliveries", id);
      if (!row || row.payload === null) return null;
      return this.write("deliveries", id, {
        ...row,
        status: "pending",
        next_attempt_at: at,
        updated_at: nowIso(),
      });
    },
    sweepExpired: async (now) =>
      this.database
        .prepare(
          "DELETE FROM skein_deliveries WHERE json_extract(body,'$.status') IN ('delivered','dead') AND json_extract(body,'$.expires_at')<=?",
        )
        .run(now).changes,
  };
}
