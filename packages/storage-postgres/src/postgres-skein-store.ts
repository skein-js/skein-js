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
  type SkeinStoreSnapshot,
  type StorePutOptions,
  type StoreRepo,
  type StoreSearchQuery,
  type StoreTtlConfig,
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

/** Connection tuning shared by every `pg` pool skein opens against the same database. */
export interface PostgresPoolOptions {
  /**
   * Max connections in the pool (`pg` default is 10). Lower it to fit a managed database's
   * connection cap — remember skein opens a second pool for `PostgresSaver` per instance.
   */
  poolMax?: number;
  /**
   * Disable TLS certificate verification (`ssl: { rejectUnauthorized: false }`). Needed only for a
   * managed database that presents a self-signed cert over a public URL; leave off for private
   * networking (plaintext) or a proper CA chain. `sslmode` in the URL is honored by `pg` regardless.
   */
  sslNoVerify?: boolean;
}

export interface PostgresSkeinStoreOptions extends PostgresPoolOptions {
  /** Enables pgvector semantic store search. Omitted → search falls back to naive text matching. */
  index?: StoreIndexConfig;
  /** Store-item expiry policy (from `langgraph.json` `store.ttl`). Omitted → items never expire. */
  ttl?: StoreTtlConfig;
}

/**
 * Build a `pg` Pool with skein's connection tuning applied. Shared by the store and the checkpoint
 * saver so both honor `poolMax`/`sslNoVerify` identically against the same `POSTGRES_URI`.
 */
export function createPostgresPool(url: string, options: PostgresPoolOptions = {}): Pool {
  const pool = new Pool({
    connectionString: url,
    ...(options.poolMax !== undefined ? { max: options.poolMax } : {}),
    // Only override TLS to skip verification; otherwise let `pg` derive `ssl` from the URL's
    // `sslmode`, so a proper CA chain (or plaintext private networking) is unaffected.
    ...(options.sslNoVerify ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  // An idle client can emit 'error' (server restart, dropped connection); without a listener
  // node-postgres re-emits it as an unhandled 'error' that crashes the process. The pool evicts
  // the bad client on its own, so swallowing here is safe — the next query gets a fresh client.
  pool.on("error", () => {});
  return pool;
}

/**
 * Session-independent advisory-lock key that serializes the opt-in pgvector setup (extension +
 * column) across concurrently-booting instances, so a rolling deploy doesn't race `CREATE EXTENSION`.
 */
const PGVECTOR_SETUP_LOCK = 0x736b6569; // "skei"

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

/** SQL predicate: the store item is not past its TTL (or has none). */
const NOT_EXPIRED = "(expires_at IS NULL OR expires_at > now())";

/** SQL expression computing `expires_at` from a ttl-in-minutes bind param (`null` → never expires). */
const expiresAtSql = (ttlParam: string): string =>
  `CASE WHEN ${ttlParam}::double precision IS NULL THEN NULL ` +
  `ELSE now() + ${ttlParam}::double precision * interval '1 minute' END`;

/** Absolute path to this package's node-pg-migrate migration files (resolves from src or dist). */
function migrationsDir(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

/** Postgres `SkeinStore`. Construct with {@link PostgresSkeinStore.connect}, run {@link migrate}. */
export class PostgresSkeinStore implements SkeinStore {
  readonly #pool: Pool;
  readonly #url: string;
  readonly #index?: StoreIndexConfig;
  readonly #ttl?: StoreTtlConfig;

  private constructor(pool: Pool, url: string, index?: StoreIndexConfig, ttl?: StoreTtlConfig) {
    this.#pool = pool;
    this.#url = url;
    this.#index = index;
    this.#ttl = ttl;
  }

  /** Connect to Postgres. Call {@link migrate} once before use to create/upgrade the schema. */
  static async connect(
    url: string,
    options: PostgresSkeinStoreOptions = {},
  ): Promise<PostgresSkeinStore> {
    return new PostgresSkeinStore(
      createPostgresPool(url, options),
      url,
      options.index,
      options.ttl,
    );
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
    // Semantic search is opt-in: only when a store index is configured do we require pgvector.
    // This keeps the base schema runnable on a stock Postgres (e.g. Railway's default) that lacks
    // the extension. Both statements are idempotent, so it's safe on every boot / re-migrate.
    if (this.#index !== undefined) await this.#setupPgvector();
  }

  // Enable pgvector + add the embedding column, serialized by a transaction-scoped advisory lock so
  // concurrently-booting instances (a rolling deploy) don't race `CREATE EXTENSION` — which can
  // raise "tuple concurrently updated" when two sessions run it at once. The xact lock frees on
  // COMMIT/ROLLBACK. node-pg-migrate lock-serializes its own migrations, but this DDL runs after it.
  async #setupPgvector(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [PGVECTOR_SETUP_LOCK]);
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      } catch (error) {
        // `CREATE EXTENSION` only enables an extension already installed on the server — it can't
        // install pgvector onto a server that lacks it (Railway's default Postgres, most stock
        // images). Turn the raw Postgres error into an actionable one.
        throw new Error(
          `Could not enable pgvector, required by the configured store.index. Use a Postgres with ` +
            `pgvector installed (e.g. the pgvector/pgvector image, or Railway's pgvector template) — ` +
            `or remove store.index to run without semantic search. Original error: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await client.query("ALTER TABLE store_items ADD COLUMN IF NOT EXISTS embedding vector");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    await this.#pool.end();
  }

  /** Empty every resource table. For tests that need a clean schema without re-migrating. */
  async truncateAll(): Promise<void> {
    await this.#pool.query("TRUNCATE assistants, threads, runs, store_items CASCADE");
  }

  /**
   * Bulk-load rows from a {@link SkeinStoreSnapshot}, preserving ids **and timestamps**, in one
   * transaction. Existing rows are left untouched (`ON CONFLICT DO NOTHING`) so re-running an
   * import never clobbers state skein has written since. Threads are inserted before runs to
   * satisfy the runs→threads foreign key, and a run whose thread isn't part of the import is skipped
   * (rather than tripping the FK and aborting everything). When a store index is configured, item
   * embeddings are computed in one batch outside the transaction; if the embedder fails, items are
   * still imported (just not semantically indexed) rather than failing the whole migration — this
   * matches the memory driver, which never embeds. The lossless Postgres sink for migration tooling
   * (`loadSnapshotIntoStore` in `@skein-js/express` feature-detects it — see the LangGraph importer).
   */
  async restore(snapshot: SkeinStoreSnapshot): Promise<void> {
    const kwargsByRun = new Map(snapshot.runKwargs);

    // Embed store items in ONE batch, outside the transaction (an external embedder shouldn't hold a
    // client, and one call beats N). A failure is non-fatal: we warn and import the items without a
    // vector, so the migration still completes. Skipped/failed items simply get a null embedding.
    const embeddingByItem = new Map<string, string>();
    if (this.#index !== undefined && snapshot.items.length > 0) {
      const { dims, fields } = this.#index;
      try {
        const vectors = await this.#index.embed(
          snapshot.items.map(([, item]) => textForValue(item.value, fields)),
        );
        snapshot.items.forEach(([id], index) => {
          const vector = vectors[index];
          if (vector && vector.length === dims) embeddingByItem.set(id, toVectorLiteral(vector));
        });
      } catch (error) {
        console.warn(
          `skein: could not embed imported store items; importing them without a semantic index ` +
            `(${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }

    // Runs FK-reference threads; a run whose thread isn't in this import can't be inserted, so skip
    // it instead of aborting the whole transaction (the memory driver has no FK and tolerates it).
    const importedThreadIds = new Set(snapshot.threads.map(([, thread]) => thread.thread_id));
    let skippedOrphanRuns = 0;

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (const [, assistant] of snapshot.assistants) {
        await client.query(
          `INSERT INTO assistants
             (assistant_id, graph_id, name, description, config, context, metadata, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10)
           ON CONFLICT (assistant_id) DO NOTHING`,
          [
            assistant.assistant_id,
            assistant.graph_id,
            assistant.name ?? assistant.graph_id,
            assistant.description ?? null,
            JSON.stringify(assistant.config ?? {}),
            JSON.stringify(assistant.context ?? {}),
            JSON.stringify(assistant.metadata ?? {}),
            assistant.version ?? 1,
            assistant.created_at,
            assistant.updated_at,
          ],
        );
      }
      for (const [, thread] of snapshot.threads) {
        await client.query(
          `INSERT INTO threads
             (thread_id, status, metadata, values, interrupts, created_at, updated_at, state_updated_at)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8)
           ON CONFLICT (thread_id) DO NOTHING`,
          [
            thread.thread_id,
            thread.status ?? "idle",
            JSON.stringify(thread.metadata ?? {}),
            JSON.stringify(thread.values ?? {}),
            JSON.stringify(thread.interrupts ?? {}),
            thread.created_at,
            thread.updated_at,
            thread.state_updated_at ?? thread.updated_at,
          ],
        );
      }
      for (const [, run] of snapshot.runs) {
        if (!importedThreadIds.has(run.thread_id)) {
          skippedOrphanRuns += 1;
          continue;
        }
        const kwargs = kwargsByRun.get(run.run_id) ?? null;
        await client.query(
          `INSERT INTO runs
             (run_id, thread_id, assistant_id, status, metadata, multitask_strategy, kwargs, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)
           ON CONFLICT (run_id) DO NOTHING`,
          [
            run.run_id,
            run.thread_id,
            run.assistant_id,
            run.status ?? "pending",
            JSON.stringify(run.metadata ?? {}),
            run.multitask_strategy ?? null,
            kwargs === null ? null : JSON.stringify(kwargs),
            run.created_at,
            run.updated_at,
          ],
        );
      }
      for (const [id, item] of snapshot.items) {
        // The `embedding` column only exists when a store index is configured (see migrate());
        // without one, insert the pgvector-free row so a stock Postgres never sees the column.
        const query =
          this.#index !== undefined
            ? {
                text: `INSERT INTO store_items (namespace, key, value, embedding, created_at, updated_at)
                       VALUES ($1::text[], $2, $3::jsonb, $4::vector, $5, $6)
                       ON CONFLICT (namespace, key) DO NOTHING`,
                values: [
                  item.namespace,
                  item.key,
                  JSON.stringify(item.value),
                  embeddingByItem.get(id) ?? null,
                  item.createdAt,
                  item.updatedAt,
                ],
              }
            : {
                text: `INSERT INTO store_items (namespace, key, value, created_at, updated_at)
                       VALUES ($1::text[], $2, $3::jsonb, $4, $5)
                       ON CONFLICT (namespace, key) DO NOTHING`,
                values: [
                  item.namespace,
                  item.key,
                  JSON.stringify(item.value),
                  item.createdAt,
                  item.updatedAt,
                ],
              };
        await client.query(query.text, query.values);
      }
      await client.query("COMMIT");
      if (skippedOrphanRuns > 0) {
        console.warn(
          `skein: skipped ${skippedOrphanRuns} imported run(s) whose thread was not part of the import.`,
        );
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      const { rows } = await this.#pool.query<ThreadRow>(
        "SELECT * FROM threads ORDER BY created_at",
      );
      return rows.map(rowToThread);
    },
    search: async (query) => {
      const params: unknown[] = [];
      const clauses: string[] = [];
      if (query.metadata && Object.keys(query.metadata).length > 0) {
        params.push(JSON.stringify(query.metadata));
        clauses.push(`metadata @> $${params.length}::jsonb`);
      }
      if (query.values && Object.keys(query.values).length > 0) {
        params.push(JSON.stringify(query.values));
        clauses.push(`values @> $${params.length}::jsonb`);
      }
      if (query.status) {
        params.push(query.status);
        clauses.push(`status = $${params.length}`);
      }
      if (query.ids) {
        params.push(query.ids);
        clauses.push(`thread_id = ANY($${params.length}::text[])`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      // Whitelist the sort column — it is interpolated, never parameterized.
      const sortColumns = new Set(["thread_id", "status", "created_at", "updated_at"]);
      const sortBy = sortColumns.has(query.sortBy ?? "") ? query.sortBy : "created_at";
      const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
      params.push(query.offset ?? 0);
      const offsetParam = `$${params.length}`;
      let limitClause = "";
      if (query.limit !== undefined) {
        params.push(query.limit);
        limitClause = `LIMIT $${params.length}`;
      }
      // `thread_id` is a unique tiebreaker so OFFSET/LIMIT paging is stable when the primary sort key
      // ties (equal timestamps/status) — without it Postgres row order is undefined across queries and
      // a page could drop or duplicate a row.
      const { rows } = await this.#pool.query<ThreadRow>(
        `SELECT * FROM threads ${where} ORDER BY ${sortBy} ${direction}, thread_id ${direction} OFFSET ${offsetParam} ${limitClause}`,
        params,
      );
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
        [
          input?.thread_id ?? randomUUID(),
          input?.status ?? "idle",
          JSON.stringify(input?.metadata ?? {}),
        ],
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
    copy: async (threadId) => {
      // Duplicate the row under a fresh id and timestamps; checkpoint history is copied separately
      // at the service layer via the LangGraph checkpointer.
      const { rows } = await this.#pool.query<ThreadRow>(
        `INSERT INTO threads (thread_id, status, metadata, values, interrupts)
         SELECT $1, status, metadata, values, interrupts FROM threads WHERE thread_id = $2
         RETURNING *`,
        [randomUUID(), threadId],
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
      const { rows } = await this.#pool.query<RunRow>("SELECT * FROM runs WHERE run_id = $1", [
        runId,
      ]);
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
      // Only when TTL is configured (and refresh-on-read isn't disabled) does a live read extend the
      // item's expiry. Doing it as an `UPDATE ... RETURNING` both refreshes and filters out an
      // already-expired row in one round trip. With no TTL configured we take the plain SELECT path so
      // a read-heavy store never pays for a write on every get.
      if (this.#ttl !== undefined && this.#ttl.refreshOnRead !== false) {
        const { rows } = await this.#pool.query<ItemRow>(
          `UPDATE store_items
             SET expires_at = CASE WHEN ttl_minutes IS NOT NULL
                                   THEN now() + ttl_minutes * interval '1 minute'
                                   ELSE expires_at END
           WHERE namespace = $1::text[] AND key = $2 AND ${NOT_EXPIRED}
           RETURNING namespace, key, value, created_at, updated_at`,
          [namespace, key],
        );
        return rows[0] ? rowToItem(rows[0]) : null;
      }
      const { rows } = await this.#pool.query<ItemRow>(
        `SELECT namespace, key, value, created_at, updated_at FROM store_items
         WHERE namespace = $1::text[] AND key = $2 AND ${NOT_EXPIRED}`,
        [namespace, key],
      );
      return rows[0] ? rowToItem(rows[0]) : null;
    },
    put: async (namespace, key, value, options?: StorePutOptions) => {
      // A per-put ttl (minutes) wins; otherwise the configured default (null = never expires).
      const ttlMinutes = options?.ttl ?? this.#ttl?.defaultTtl ?? null;
      // The `embedding` column only exists when a store index is configured (see migrate()); a
      // pgvector-free deployment writes the row without it, so a stock Postgres never sees `vector`.
      if (this.#index !== undefined) {
        const embedding = await this.#embed(textForValue(value, this.#index.fields));
        const { rows } = await this.#pool.query<ItemRow>(
          `INSERT INTO store_items (namespace, key, value, embedding, ttl_minutes, expires_at)
           VALUES ($1::text[], $2, $3::jsonb, $4::vector, $5, ${expiresAtSql("$5")})
           ON CONFLICT (namespace, key)
           DO UPDATE SET value = EXCLUDED.value, embedding = EXCLUDED.embedding,
             ttl_minutes = EXCLUDED.ttl_minutes, expires_at = EXCLUDED.expires_at, updated_at = now()
           RETURNING namespace, key, value, created_at, updated_at`,
          [namespace, key, JSON.stringify(value), embedding, ttlMinutes],
        );
        return rowToItem(rows[0] as ItemRow);
      }
      const { rows } = await this.#pool.query<ItemRow>(
        `INSERT INTO store_items (namespace, key, value, ttl_minutes, expires_at)
         VALUES ($1::text[], $2, $3::jsonb, $4, ${expiresAtSql("$4")})
         ON CONFLICT (namespace, key)
         DO UPDATE SET value = EXCLUDED.value, ttl_minutes = EXCLUDED.ttl_minutes,
           expires_at = EXCLUDED.expires_at, updated_at = now()
         RETURNING namespace, key, value, created_at, updated_at`,
        [namespace, key, JSON.stringify(value), ttlMinutes],
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
        ? `WHERE namespace[1:cardinality($1::text[])] = $1::text[] AND ${NOT_EXPIRED}`
        : `WHERE ${NOT_EXPIRED}`;
      const { rows } = await this.#pool.query<{ namespace: string[] }>(
        `SELECT DISTINCT namespace FROM store_items ${clause} ORDER BY namespace`,
        usePrefix ? [prefix] : [],
      );
      return rows.map((row) => row.namespace);
    },
    sweepExpired: async () => {
      const { rowCount } = await this.#pool.query(
        `DELETE FROM store_items WHERE expires_at IS NOT NULL AND expires_at <= now()`,
      );
      return rowCount ?? 0;
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
      let where = `embedding IS NOT NULL AND ${NOT_EXPIRED}`;
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

    const clause = usePrefix
      ? `WHERE namespace[1:cardinality($1::text[])] = $1::text[] AND ${NOT_EXPIRED}`
      : `WHERE ${NOT_EXPIRED}`;
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
