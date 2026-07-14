// The Postgres SkeinStore: Agent Protocol resources (assistants/threads/runs/store items) over
// `pg`, held to the same shared conformance suite as the memory driver so the two are provably
// interchangeable (docs/storage.md). Graph checkpoints are NOT here — those stay LangGraph-native
// via PostgresSaver. Serializing through Postgres gives the driver-parity isolation for free.

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  SkeinHttpError,
  TERMINAL_RUN_STATUSES,
  type Assistant,
  type AssistantCreate,
  type AssistantRepo,
  type Item,
  type Run,
  type RunCreate,
  type RunKwargs,
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
} from "@skein-js/core";
import { runner as runMigrations } from "node-pg-migrate";
import { Pool } from "pg";

/** Computes embeddings for a batch of texts — injected so tests use a deterministic fake. */
export type EmbedFunction = (texts: string[]) => Promise<number[][]>;

/** Semantic-search config, sourced from `langgraph.json`'s `store.index` (see docs/storage.md). */
export interface StoreIndexConfig {
  /** Embedding dimensionality (informational; the column is dimensionless). */
  dims: number;
  /** Value fields to embed. `["$"]` (default) embeds the whole value as JSON. */
  fields?: string[];
  /** The embedder. Required to enable semantic search; without it, search is naive text matching. */
  embed: EmbedFunction;
}

export interface PostgresSkeinStoreOptions {
  /** Enables pgvector semantic store search. Omitted → search falls back to naive text matching. */
  index?: StoreIndexConfig;
}

const toIsoString = (date: Date): string => date.toISOString();

/** Format a number[] as a pgvector literal, e.g. `[0.1,0.2]`. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** The text embedded for a store item, per the configured `fields` (`["$"]` = the whole value). */
function textForValue(value: Record<string, unknown>, fields?: string[]): string {
  if (!fields || fields.length === 0 || fields.includes("$")) return JSON.stringify(value);
  return fields
    .map((field) => {
      const field_value = value[field];
      return typeof field_value === "string" ? field_value : JSON.stringify(field_value ?? null);
    })
    .join(" ");
}

interface AssistantRow {
  assistant_id: string;
  graph_id: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  context: unknown;
  metadata: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface ThreadRow {
  thread_id: string;
  status: Thread["status"];
  metadata: Record<string, unknown>;
  values: Record<string, unknown>;
  interrupts: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  state_updated_at: Date;
}

interface RunRow {
  run_id: string;
  thread_id: string;
  assistant_id: string;
  status: RunStatus;
  metadata: Record<string, unknown>;
  multitask_strategy: Run["multitask_strategy"];
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function rowToAssistant(row: AssistantRow): Assistant {
  return {
    assistant_id: row.assistant_id,
    graph_id: row.graph_id,
    config: row.config,
    context: row.context,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
    metadata: row.metadata,
    version: row.version,
    name: row.name,
    description: row.description ?? undefined,
  } as Assistant;
}

function rowToThread(row: ThreadRow): Thread {
  return {
    thread_id: row.thread_id,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
    state_updated_at: toIsoString(row.state_updated_at),
    metadata: row.metadata,
    status: row.status,
    values: row.values,
    interrupts: row.interrupts,
  } as Thread;
}

function rowToRun(row: RunRow): Run {
  return {
    run_id: row.run_id,
    thread_id: row.thread_id,
    assistant_id: row.assistant_id,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
    status: row.status,
    metadata: row.metadata,
    multitask_strategy: row.multitask_strategy ?? null,
  } as Run;
}

function rowToItem(row: ItemRow, score?: number): SearchItem {
  const item: Item = {
    namespace: row.namespace,
    key: row.key,
    value: row.value,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
  return score === undefined ? item : { ...item, score };
}

/** Absolute path to this package's node-pg-migrate migration files (resolves from src or dist). */
function migrationsDir(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

/** Postgres `SkeinStore`. Construct with {@link PostgresSkeinStore.connect}, run {@link migrate}. */
export class PostgresSkeinStore implements SkeinStore {
  readonly #pool: Pool;
  readonly #url: string;
  readonly #index?: StoreIndexConfig;

  private constructor(pool: Pool, url: string, index?: StoreIndexConfig) {
    this.#pool = pool;
    this.#url = url;
    this.#index = index;
  }

  /** Connect to Postgres. Call {@link migrate} once before use to create/upgrade the schema. */
  static async connect(url: string, options: PostgresSkeinStoreOptions = {}): Promise<PostgresSkeinStore> {
    const pool = new Pool({ connectionString: url });
    // An idle client can emit 'error' (server restart, dropped connection); without a listener
    // node-postgres re-emits it as an unhandled 'error' that crashes the process. The pool evicts
    // the bad client on its own, so swallowing here is safe — the next query gets a fresh client.
    pool.on("error", () => {});
    return new PostgresSkeinStore(pool, url, options.index);
  }

  /** Apply pending schema migrations (idempotent) via node-pg-migrate. */
  async migrate(): Promise<void> {
    await runMigrations({
      databaseUrl: this.#url,
      dir: migrationsDir(),
      migrationsTable: "skein_migrations",
      direction: "up",
      count: Infinity,
      // node-pg-migrate logs each step to console by default; quiet it (errors still throw).
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    await this.#pool.end();
  }

  /** Empty every resource table. For tests that need a clean schema without re-migrating. */
  async truncateAll(): Promise<void> {
    await this.#pool.query("TRUNCATE assistants, threads, runs, store_items CASCADE");
  }

  readonly assistants: AssistantRepo = {
    list: async () => {
      const { rows } = await this.#pool.query<AssistantRow>(
        "SELECT * FROM assistants ORDER BY created_at",
      );
      return rows.map(rowToAssistant);
    },
    get: async (assistantId) => {
      const { rows } = await this.#pool.query<AssistantRow>(
        "SELECT * FROM assistants WHERE assistant_id = $1",
        [assistantId],
      );
      return rows[0] ? rowToAssistant(rows[0]) : null;
    },
    create: async (input: AssistantCreate) => {
      const { rows } = await this.#pool.query<AssistantRow>(
        `INSERT INTO assistants (assistant_id, graph_id, name, description, config, context, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb) RETURNING *`,
        [
          input.assistant_id ?? randomUUID(),
          input.graph_id,
          input.name ?? input.graph_id,
          input.description ?? null,
          JSON.stringify(input.config ?? {}),
          JSON.stringify(input.context ?? {}),
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      return rowToAssistant(rows[0] as AssistantRow);
    },
    delete: async (assistantId) => {
      await this.#pool.query("DELETE FROM assistants WHERE assistant_id = $1", [assistantId]);
    },
  };

  readonly threads: ThreadRepo = {
    list: async () => {
      const { rows } = await this.#pool.query<ThreadRow>("SELECT * FROM threads ORDER BY created_at");
      return rows.map(rowToThread);
    },
    get: async (threadId) => {
      const { rows } = await this.#pool.query<ThreadRow>(
        "SELECT * FROM threads WHERE thread_id = $1",
        [threadId],
      );
      return rows[0] ? rowToThread(rows[0]) : null;
    },
    create: async (input?: ThreadCreate) => {
      const { rows } = await this.#pool.query<ThreadRow>(
        `INSERT INTO threads (thread_id, status, metadata)
         VALUES ($1, $2, $3::jsonb) RETURNING *`,
        [input?.thread_id ?? randomUUID(), input?.status ?? "idle", JSON.stringify(input?.metadata ?? {})],
      );
      return rowToThread(rows[0] as ThreadRow);
    },
    update: async (threadId, patch: ThreadUpdate) => {
      const { rows } = await this.#pool.query<ThreadRow>(
        `UPDATE threads SET
           metadata = COALESCE($2::jsonb, metadata),
           status = COALESCE($3, status),
           values = COALESCE($4::jsonb, values),
           interrupts = COALESCE($5::jsonb, interrupts),
           updated_at = now(),
           state_updated_at = CASE WHEN $4::jsonb IS NOT NULL THEN now() ELSE state_updated_at END
         WHERE thread_id = $1 RETURNING *`,
        [
          threadId,
          patch.metadata === undefined ? null : JSON.stringify(patch.metadata),
          patch.status ?? null,
          patch.values === undefined ? null : JSON.stringify(patch.values),
          patch.interrupts === undefined ? null : JSON.stringify(patch.interrupts),
        ],
      );
      if (!rows[0]) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
      return rowToThread(rows[0]);
    },
    delete: async (threadId) => {
      // Runs cascade via the foreign key's ON DELETE CASCADE.
      await this.#pool.query("DELETE FROM threads WHERE thread_id = $1", [threadId]);
    },
  };

  readonly runs: RunRepo = {
    get: async (runId) => {
      const { rows } = await this.#pool.query<RunRow>("SELECT * FROM runs WHERE run_id = $1", [runId]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },
    listByThread: async (threadId) => {
      const { rows } = await this.#pool.query<RunRow>(
        "SELECT * FROM runs WHERE thread_id = $1 ORDER BY created_at",
        [threadId],
      );
      return rows.map(rowToRun);
    },
    create: async (input: RunCreate) => {
      const { rows } = await this.#pool.query<RunRow>(
        `INSERT INTO runs (run_id, thread_id, assistant_id, status, metadata, multitask_strategy, kwargs)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb) RETURNING *`,
        [
          input.run_id ?? randomUUID(),
          input.thread_id,
          input.assistant_id,
          input.status ?? "pending",
          JSON.stringify(input.metadata ?? {}),
          input.multitask_strategy ?? null,
          input.kwargs === undefined ? null : JSON.stringify(input.kwargs),
        ],
      );
      return rowToRun(rows[0] as RunRow);
    },
    setStatus: async (runId, status: RunStatus) => {
      const { rows } = await this.#pool.query<RunRow>(
        "UPDATE runs SET status = $2, updated_at = now() WHERE run_id = $1 RETURNING *",
        [runId, status],
      );
      if (!rows[0]) throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
      return rowToRun(rows[0]);
    },
    delete: async (runId) => {
      await this.#pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
    },
    getKwargs: async (runId) => {
      const { rows } = await this.#pool.query<{ kwargs: RunKwargs | null }>(
        "SELECT kwargs FROM runs WHERE run_id = $1",
        [runId],
      );
      return rows[0]?.kwargs ?? null;
    },
    hasActiveRun: async (threadId) => {
      const { rows } = await this.#pool.query<{ active: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE thread_id = $1 AND NOT (status = ANY($2::text[]))) AS active",
        [threadId, TERMINAL_RUN_STATUSES],
      );
      return rows[0]?.active ?? false;
    },
  };

  readonly store: StoreRepo = {
    get: async (namespace, key) => {
      const { rows } = await this.#pool.query<ItemRow>(
        "SELECT namespace, key, value, created_at, updated_at FROM store_items WHERE namespace = $1::text[] AND key = $2",
        [namespace, key],
      );
      return rows[0] ? rowToItem(rows[0]) : null;
    },
    put: async (namespace, key, value) => {
      const embedding =
        this.#index !== undefined
          ? await this.#embed(textForValue(value, this.#index.fields))
          : null;
      const { rows } = await this.#pool.query<ItemRow>(
        `INSERT INTO store_items (namespace, key, value, embedding)
         VALUES ($1::text[], $2, $3::jsonb, $4::vector)
         ON CONFLICT (namespace, key)
         DO UPDATE SET value = EXCLUDED.value, embedding = EXCLUDED.embedding, updated_at = now()
         RETURNING namespace, key, value, created_at, updated_at`,
        [namespace, key, JSON.stringify(value), embedding],
      );
      return rowToItem(rows[0] as ItemRow);
    },
    delete: async (namespace, key) => {
      await this.#pool.query("DELETE FROM store_items WHERE namespace = $1::text[] AND key = $2", [
        namespace,
        key,
      ]);
    },
    search: async (query: StoreSearchQuery) => this.#search(query),
    listNamespaces: async (prefix) => {
      const usePrefix = prefix !== undefined && prefix.length > 0;
      const clause = usePrefix
        ? "WHERE namespace[1:cardinality($1::text[])] = $1::text[]"
        : "";
      const { rows } = await this.#pool.query<{ namespace: string[] }>(
        `SELECT DISTINCT namespace FROM store_items ${clause} ORDER BY namespace`,
        usePrefix ? [prefix] : [],
      );
      return rows.map((row) => row.namespace);
    },
  };

  // Embed one text into a pgvector literal, validating the embedder's output so a misbehaving
  // embedder fails loudly here instead of producing a `'[]'::vector` dimension-mismatch error deep
  // inside a search query.
  async #embed(text: string): Promise<string> {
    if (!this.#index) throw new Error("Cannot embed without a configured store index.");
    const [vector] = await this.#index.embed([text]);
    if (!vector || vector.length === 0) {
      throw new Error("Store index embedder returned an empty vector.");
    }
    if (vector.length !== this.#index.dims) {
      throw new Error(
        `Store index embedder returned ${vector.length} dimensions, expected ${this.#index.dims}.`,
      );
    }
    return toVectorLiteral(vector);
  }

  // Semantic search (pgvector cosine) when an index is configured; otherwise the memory driver's
  // naive-substring behavior, so the shared conformance suite passes identically on both drivers.
  async #search(query: StoreSearchQuery): Promise<SearchItem[]> {
    const usePrefix = query.prefix !== undefined && query.prefix.length > 0;

    if (query.query !== undefined && this.#index !== undefined) {
      const queryVector = await this.#embed(query.query);
      const params: unknown[] = [queryVector];
      let where = "embedding IS NOT NULL";
      if (usePrefix) {
        params.push(query.prefix);
        where += ` AND namespace[1:cardinality($${params.length}::text[])] = $${params.length}::text[]`;
      }
      params.push(query.offset ?? 0);
      const offsetParam = `$${params.length}`;
      let limitClause = "";
      if (query.limit !== undefined) {
        params.push(query.limit);
        limitClause = `LIMIT $${params.length}`;
      }
      const { rows } = await this.#pool.query<ItemRow & { score: number }>(
        `SELECT namespace, key, value, created_at, updated_at, 1 - (embedding <=> $1::vector) AS score
         FROM store_items WHERE ${where}
         ORDER BY embedding <=> $1::vector OFFSET ${offsetParam} ${limitClause}`,
        params,
      );
      return rows.map((row) => rowToItem(row, row.score));
    }

    const clause = usePrefix ? "WHERE namespace[1:cardinality($1::text[])] = $1::text[]" : "";
    const { rows } = await this.#pool.query<ItemRow>(
      `SELECT namespace, key, value, created_at, updated_at FROM store_items ${clause} ORDER BY created_at, key`,
      usePrefix ? [query.prefix] : [],
    );

    let items: SearchItem[] = rows.map((row) => rowToItem(row));
    if (query.query !== undefined) {
      const needle = query.query.toLowerCase();
      items = items
        .filter((item) => JSON.stringify(item.value).toLowerCase().includes(needle))
        .map((item) => ({ ...item, score: 1 }));
    }
    const offset = query.offset ?? 0;
    return items.slice(offset, query.limit === undefined ? undefined : offset + query.limit);
  }
}
