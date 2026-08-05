// The Postgres SkeinStore: Agent Protocol resources (assistants/threads/runs/store items) over
// `pg`, held to the same shared conformance suite as the memory driver so the two are provably
// interchangeable (docs/storage.md). Graph checkpoints are NOT here — those stay LangGraph-native
// via PostgresSaver. Serializing through Postgres gives the driver-parity isolation for free.

import { randomUUID } from "node:crypto";

import {
  SkeinHttpError,
  INFLIGHT_RUN_STATUSES,
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
  DEFAULT_MAX_PAGE_SIZE,
  requireValidMaxPageSize,
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
import { Pool, type PoolClient } from "pg";

import { acquireSessionAdvisoryLock, applySkeinMigrations } from "./run-migrations.js";

/** Computes embeddings for a batch of texts — injected so tests use a deterministic fake. */
export type EmbedFunction = (texts: string[]) => Promise<number[][]>;

/** Semantic-search config, sourced from `langgraph.json`'s `store.index` (see docs/storage.md). */
export interface StoreIndexConfig {
  /**
   * Embedding dimensionality. Informational while the column stays dimensionless — but required, and
   * enforced on the column, when {@link StoreIndexConfig.hnsw} is on: pgvector cannot index a
   * dimensionless `vector`.
   */
  dims: number;
  /** Value fields to embed. `["$"]` (default) embeds the whole value as JSON. */
  fields?: string[];
  /** The embedder. Required to enable semantic search; without it, search is naive text matching. */
  embed: EmbedFunction;
  /**
   * Build an HNSW index on the embedding column. Off by default.
   *
   * Opt-in because HNSW is **approximate**: it changes which rows a semantic search returns, which is
   * a semantic change and not one to inherit from an upgrade. Without it every search is an exact
   * sequential scan computing cosine distance over every row — correct, and fine until the store
   * grows. Turning it on also pins the column to `vector(dims)`.
   */
  hnsw?: boolean;
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
  /**
   * How long to wait for a connection from the pool before failing (ms).
   *
   * `pg` waits **forever** by default, so a database that has become unreachable turns every request
   * into a hang rather than an error — no status code, no log line, just a socket the client eventually
   * gives up on. A bounded wait surfaces the fault.
   */
  connectionTimeoutMs?: number;
  /** How long an unused client stays in the pool before being closed (ms). `pg` default is 10s. */
  idleTimeoutMs?: number;
  /**
   * Server-side ceiling on a single statement (ms), applied per connection.
   *
   * The last line of defence against one pathological query pinning a pool connection indefinitely.
   * Unset here means no timeout; `@skein-js/runtime` resolves the default (30s) from the environment.
   * Per *statement*, not per request. Schema DDL must not run under it — see `migrate()` and
   * `#setupPgvector`, which lift it on their own client and then destroy that connection rather than
   * returning a session-exempt one to the pool.
   */
  statementTimeoutMs?: number;
}

export interface PostgresSkeinStoreOptions extends PostgresPoolOptions {
  /**
   * Rows a `search` returns when the caller asks for no limit. Defaults to
   * {@link DEFAULT_MAX_PAGE_SIZE}. Lower it on a small instance; an absent limit used to mean *every*
   * row, which for threads meant every thread's full mirrored graph state.
   */
  maxPageSize?: number;
  /** Enables pgvector semantic store search. Omitted → search falls back to naive text matching. */
  index?: StoreIndexConfig;
  /** Store-item expiry policy (from `langgraph.json` `store.ttl`). Omitted → items never expire. */
  ttl?: StoreTtlConfig;
  /**
   * Thread expiry policy (from `langgraph.json` `checkpointer.ttl`). Omitted → threads never expire.
   */
  threadTtl?: ThreadTtlConfig;
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
    ...(options.connectionTimeoutMs !== undefined
      ? { connectionTimeoutMillis: options.connectionTimeoutMs }
      : {}),
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMillis: options.idleTimeoutMs } : {}),
  });
  // Applied with a `SET` on connect rather than as a startup parameter. A startup parameter would be
  // marginally cheaper, but PgBouncer and Supabase's pooler *reject* unrecognised ones outright
  // ("unsupported startup parameter"), so every connection would fail rather than degrade. `SET` is
  // safe in session pooling; under transaction pooling it does not persist, which is a silent
  // no-op — acceptable, since this is a backstop rather than a correctness guarantee.
  if (options.statementTimeoutMs !== undefined && options.statementTimeoutMs > 0) {
    const timeout = Math.trunc(options.statementTimeoutMs);
    pool.on("connect", (client) => {
      // Swallowed: the pool's own 'error' handler below deals with a broken client, and failing to set
      // a backstop must not take down a connection that is otherwise fine.
      client.query(`SET statement_timeout = ${timeout}`).catch(() => {});
    });
  }
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

/** Match the migration runner: boot must wait for a peer, but never forever. */
const PGVECTOR_SETUP_LOCK_TIMEOUT_MS = 60_000;

/** pgvector's own ceiling on a `vector` column's dimensionality. */
const PGVECTOR_MAX_DIMENSIONS = 16_000;

/**
 * Expired store items deleted per statement by `sweepExpired`. Small enough that one batch stays well
 * inside any sane `statement_timeout`, large enough that a big backlog clears in a reasonable number of
 * round trips. The sweep loops until a batch comes back short.
 */
const SWEEP_BATCH_ROWS = 5000;

/** The HNSW index `store.index.hnsw` builds. Named once — it is referenced by three statements. */
const HNSW_INDEX_NAME = "store_items_embedding_hnsw_idx";

/**
 * Make every connection in `pool` scan an HNSW index iteratively rather than once.
 *
 * Without this, a filtered semantic search can come back **empty**. HNSW returns a fixed candidate set
 * (`hnsw.ef_search`, 40 by default) and the namespace predicate is applied *after* it — so if none of
 * those nearest neighbours happen to be in the requested namespace, the query yields nothing even
 * though matching rows exist. skein's store is namespace-partitioned by design and `getStore()` always
 * searches with a prefix, so that is the dominant query shape, not an edge case.
 *
 * `strict_order` rather than `relaxed_order`: the search returns a similarity score and callers rank
 * on it, so exact ordering has to hold.
 *
 * Set per connection (once, on connect) rather than per query, which would need a transaction and
 * three extra round trips on every search. Failure is tolerated and logged: `iterative_scan` arrived
 * in pgvector 0.8, and on an older server the old post-filter behaviour is the best available.
 */
function enableIterativeIndexScan(pool: Pool): void {
  pool.on("connect", (client) => {
    client.query("SET hnsw.iterative_scan = strict_order").catch(() => {
      // Swallowed per connection, warned once — see `warnedAboutIterativeScan`.
      if (!warnedAboutIterativeScan) {
        warnedAboutIterativeScan = true;
        console.warn(
          "skein: this Postgres does not support hnsw.iterative_scan (pgvector < 0.8), so a " +
            "namespace-filtered semantic search may return fewer rows than exist — HNSW filters " +
            "after selecting candidates. Upgrade pgvector, or unset store.index.hnsw for exact search.",
        );
      }
    });
  });
}

/** One warning per process, not per connection. */
let warnedAboutIterativeScan = false;

/**
 * Validate `dims` before it is interpolated into `ALTER TABLE … TYPE vector(<dims>)`.
 *
 * A type modifier cannot be a bind parameter, so this value reaches the SQL as text and has to be
 * proven safe first. The bounds are pgvector's own, and they double as the guard that keeps it an
 * integer *literal*: `Number.isInteger(1e21)` is true, but `String(1e21)` is `"1e+21"`, which is not
 * valid SQL. Lives here rather than in config validation because `embedPostgresGraphs` takes `index`
 * straight from code and never sees the `langgraph.json` schema.
 */
function requireIndexableDimensions(dims: number | undefined): number {
  if (
    typeof dims !== "number" ||
    !Number.isInteger(dims) ||
    dims <= 0 ||
    dims > PGVECTOR_MAX_DIMENSIONS
  ) {
    throw new Error(
      `store.index.hnsw needs store.index.dims to be an integer between 1 and ` +
        `${PGVECTOR_MAX_DIMENSIONS} — pgvector cannot index a dimensionless vector column, and that ` +
        `is its own limit. Got: ${String(dims)}.`,
    );
  }
  return dims;
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

interface AssistantVersionRow {
  assistant_id: string;
  version: number;
  graph_id: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  context: unknown;
  metadata: Record<string, unknown>;
  created_at: Date;
}

interface ThreadRow {
  thread_id: string;
  status: Thread["status"];
  metadata: Record<string, unknown>;
  values: Record<string, unknown>;
  interrupts: Record<string, unknown>;
  error: string | null;
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
  error: RunError | null;
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

interface CronRow {
  cron_id: string;
  assistant_id: string;
  thread_id: string | null;
  schedule: string;
  timezone: string | null;
  end_time: Date | null;
  next_run_date: Date | null;
  enabled: boolean;
  // bigint: `pg` hands it back as a string rather than risk a lossy Number, so it is parsed on the
  // way out (see `rowToCron`). Occurrence counts never approach 2^53, so a JS number is safe here.
  occurrence_seq: string;
  on_run_completed: "delete" | "keep" | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  user_id: string | null;
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

/**
 * `INFLIGHT_RUN_STATUSES` as a SQL literal list, for a predicate the planner can match against
 * `runs_inflight_created_at_idx` (migration 0006). Interpolated rather than parameterized *because* a
 * parameter defeats the match — and safely so: these are internal enum values from a `readonly` constant,
 * never anything a caller supplies. Quoted through a single helper so the two places that need the
 * predicate cannot spell it differently.
 */
const INFLIGHT_STATUS_SQL = INFLIGHT_RUN_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * Insert a run row and return it, on whatever executor the caller has — the pool for `create`, a
 * transaction's client for `createIfThreadIdle`.
 *
 * Shared rather than duplicated because `reject` is the *default* multitask strategy, so the guarded path
 * is the one most run creations take: a column added to `runs` and wired into only one of the two copies
 * would be silently missing from most runs, and no test could notice — both spellings return a `Run`.
 */
async function insertRun(
  executor: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  input: RunCreate,
): Promise<Run> {
  const { rows } = await executor.query<RunRow>(
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
}

/** Insert a cron row and return it. Extracted so `create` can wrap it in one try/catch. */
async function insertCron(
  executor: Pick<Pool, "query">,
  cronId: string,
  input: CronCreate,
): Promise<Cron> {
  const { rows } = await executor.query<CronRow>(
    `INSERT INTO crons (cron_id, assistant_id, thread_id, schedule, timezone, end_time,
                        next_run_date, enabled, on_run_completed, payload, metadata, user_id, auth)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb)
     RETURNING *`,
    [
      cronId,
      input.assistant_id,
      input.thread_id ?? null,
      input.schedule,
      input.timezone ?? null,
      input.end_time ?? null,
      input.next_run_date ?? null,
      input.enabled ?? true,
      input.on_run_completed ?? null,
      JSON.stringify(input.payload ?? {}),
      JSON.stringify(input.metadata ?? {}),
      input.user_id ?? null,
      input.auth === undefined ? null : JSON.stringify(input.auth),
    ],
  );
  return rowToCron(rows[0] as CronRow);
}

/**
 * The compare-and-swap behind both claim methods: advance `next_run_date` only if the cron still
 * holds `expectedSeq` and is still enabled, returning the advanced row or `null` for a loser.
 *
 * This single statement is what replaces a leader election. Every instance ticks, every instance may
 * see the same due cron, and Postgres serializes them on the primary-key row — exactly one matches
 * `occurrence_seq` and the rest update zero rows. No lock ordering, no deadlock surface, no
 * isolation-level dependency, and nothing to reclaim if the winner then dies.
 *
 * `enabled` is in the predicate, not just in the due scan: a cron disabled between the scan and the
 * claim must lose rather than fire one last time.
 *
 * Runs on whatever executor the caller has — the pool for a bare advance, a transaction's client
 * when the run row has to commit with it.
 */
async function claimCronOccurrence(
  executor: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  cronId: string,
  claim: CronClaim,
): Promise<Cron | null> {
  const { rows } = await executor.query<CronRow>(
    `UPDATE crons
        SET next_run_date = $3::timestamptz,
            occurrence_seq = occurrence_seq + 1,
            updated_at = now()
      WHERE cron_id = $1 AND occurrence_seq = $2 AND enabled
      RETURNING *`,
    [cronId, claim.expectedSeq, claim.nextRunDate],
  );
  return rows[0] ? rowToCron(rows[0]) : null;
}

/** True for a Postgres `unique_violation` (SQLSTATE 23505) — a duplicate primary/unique key. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/** Build the shared WHERE clause + params for assistant search/count (graph_id, name, metadata). */
function assistantSearchWhere(query: AssistantSearchQuery): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (query.graph_id !== undefined) {
    params.push(query.graph_id);
    clauses.push(`graph_id = $${params.length}`);
  }
  if (query.name !== undefined) {
    params.push(query.name);
    clauses.push(`name = $${params.length}`);
  }
  if (query.metadata && Object.keys(query.metadata).length > 0) {
    params.push(JSON.stringify(query.metadata));
    clauses.push(`metadata @> $${params.length}::jsonb`);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/**
 * Build the shared WHERE clause + params for thread search/count (metadata, ownership scoping, values,
 * status, ids). Extracted so `count` filters *identically* to `search` — the two disagreeing is a
 * silent bug, since a count that does not match its own listing looks like a race rather than a defect.
 */
function threadSearchWhere(query: ThreadSearchQuery): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (query.metadata && Object.keys(query.metadata).length > 0) {
    params.push(JSON.stringify(query.metadata));
    clauses.push(`metadata @> $${params.length}::jsonb`);
  }
  // A second containment clause rather than one merged object, so a caller's filter and the
  // server's scoping can name the same key and correctly match nothing. Uses `threads_metadata_idx`
  // (GIN, jsonb_path_ops) the same way, which is what turns the auth path into an index lookup.
  if (query.enforcedMetadata && Object.keys(query.enforcedMetadata).length > 0) {
    params.push(JSON.stringify(query.enforcedMetadata));
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
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function rowToAssistantVersion(row: AssistantVersionRow): AssistantVersion {
  return {
    assistant_id: row.assistant_id,
    version: row.version,
    graph_id: row.graph_id,
    config: row.config,
    context: row.context,
    created_at: toIsoString(row.created_at),
    metadata: row.metadata,
    name: row.name,
    description: row.description ?? undefined,
  } as AssistantVersion;
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
    // Absent rather than null on a healthy thread, matching the memory driver.
    ...(row.error === null ? {} : { error: row.error }),
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
    // Absent rather than null on a run that did not fail, matching the memory driver.
    ...(row.error === null ? {} : { error: row.error }),
  } as Run;
}

function rowToCron(row: CronRow): Cron {
  return {
    cron_id: row.cron_id,
    assistant_id: row.assistant_id,
    thread_id: row.thread_id,
    schedule: row.schedule,
    timezone: row.timezone,
    end_time: row.end_time === null ? null : toIsoString(row.end_time),
    next_run_date: row.next_run_date === null ? null : toIsoString(row.next_run_date),
    enabled: row.enabled,
    payload: row.payload,
    metadata: row.metadata,
    user_id: row.user_id,
    created_at: toIsoString(row.created_at),
    updated_at: toIsoString(row.updated_at),
    // Absent rather than null on a thread cron, matching the memory driver: the field only means
    // anything for the per-fire thread a stateless cron creates.
    ...(row.on_run_completed === null ? {} : { on_run_completed: row.on_run_completed }),
  };
}

/** The claim token as the scheduler sees it — `pg` returns `bigint` as a string. */
const rowToOccurrenceSeq = (row: { occurrence_seq: string }): number =>
  Number.parseInt(row.occurrence_seq, 10);

/**
 * The shared `WHERE` for cron search and count, so the two cannot drift on what they match.
 * `enforcedMetadata` is AND-ed with the caller's own filter rather than merged into it, so a caller
 * cannot widen the server's scoping by supplying an overlapping key.
 */
function cronSearchWhere(query: CronSearchQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.assistant_id !== undefined) {
    params.push(query.assistant_id);
    clauses.push(`assistant_id = $${params.length}`);
  }
  if (query.thread_id !== undefined) {
    params.push(query.thread_id);
    clauses.push(`thread_id = $${params.length}`);
  }
  if (query.enabled !== undefined) {
    params.push(query.enabled);
    clauses.push(`enabled = $${params.length}`);
  }
  if (query.metadata !== undefined) {
    params.push(JSON.stringify(query.metadata));
    clauses.push(`metadata @> $${params.length}::jsonb`);
  }
  if (query.enforcedMetadata !== undefined) {
    params.push(JSON.stringify(query.enforcedMetadata));
    clauses.push(`metadata @> $${params.length}::jsonb`);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
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

/** Postgres `SkeinStore`. Construct with {@link PostgresSkeinStore.connect}, run {@link migrate}. */
export class PostgresSkeinStore implements SkeinStore {
  readonly #pool: Pool;
  readonly #index?: StoreIndexConfig;
  readonly #ttl?: StoreTtlConfig;
  readonly #threadTtl?: ThreadTtlConfig;

  readonly #maxPageSize: number;

  private constructor(
    pool: Pool,
    index?: StoreIndexConfig,
    ttl?: StoreTtlConfig,
    maxPageSize?: number,
    threadTtl?: ThreadTtlConfig,
  ) {
    this.#maxPageSize = requireValidMaxPageSize(maxPageSize ?? DEFAULT_MAX_PAGE_SIZE);
    this.#pool = pool;
    this.#index = index;
    this.#ttl = ttl;
    this.#threadTtl = threadTtl;
  }

  /** The bound this driver applies to an unbounded read — see `SkeinStore.maxPageSize`. */
  get maxPageSize(): number {
    return this.#maxPageSize;
  }

  /** Rows here outlive the process — see `SkeinStore.durable`. */
  get durable(): boolean {
    return true;
  }

  /**
   * The effective `LIMIT` for a search: the caller's, bounded by `maxPageSize`.
   *
   * An absent limit resolves to `maxPageSize` rather than to "no limit". Unbounded was the old
   * behaviour and it meant a single `POST /threads/search` with an empty body pulled every thread —
   * each carrying its full mirrored graph state — into the heap. An explicit limit is clamped too, so
   * lowering `maxPageSize` on a small instance actually holds.
   */
  #pageLimit(limit: number | undefined): number {
    return Math.min(limit ?? this.#maxPageSize, this.#maxPageSize);
  }

  /** Run `work` inside a transaction, committing on success and rolling back on any error. */
  async #withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Connect to Postgres. Call {@link migrate} once before use to create/upgrade the schema. */
  static async connect(
    url: string,
    options: PostgresSkeinStoreOptions = {},
  ): Promise<PostgresSkeinStore> {
    const pool = createPostgresPool(url, options);
    if (options.index?.hnsw) enableIterativeIndexScan(pool);
    return new PostgresSkeinStore(
      pool,
      options.index,
      options.ttl,
      options.maxPageSize,
      options.threadTtl,
    );
  }

  /**
   * Apply pending schema migrations. Idempotent, and advisory-locked so concurrently-booting
   * instances during a rolling deploy queue up rather than collide.
   */
  async migrate(): Promise<void> {
    await applySkeinMigrations(this.#pool);
    // Semantic search is opt-in: only when a store index is configured do we require pgvector.
    // This keeps the base schema runnable on a stock Postgres (e.g. Railway's default) that lacks
    // the extension. Both statements are idempotent, so it's safe on every boot / re-migrate.
    if (this.#index !== undefined) await this.#setupPgvector();
  }

  /**
   * Enable pgvector, add the embedding column, and — when `store.index.hnsw` is on — pin the column's
   * dimension and build the index.
   *
   * Serialized across concurrently-booting instances by a **session**-scoped advisory lock held on one
   * client for the whole sequence. It cannot be transaction-scoped: `CREATE INDEX CONCURRENTLY` is
   * rejected inside a transaction block, so it has to run after the COMMIT — and a transaction-scoped
   * lock is released *by* that COMMIT, leaving the index build unprotected. Two instances then race it
   * and Postgres deadlocks one of them, while the survivor leaves an **invalid** index that
   * `IF NOT EXISTS` skips forever, so HNSW is silently never used. `applyConcurrentMigration` in
   * run-migrations.ts holds a session lock for exactly this reason.
   *
   * The `dims` validation happens before any of it, so a misconfigured deployment fails without first
   * taking the lock and doing DDL it will only roll back.
   */
  async #setupPgvector(): Promise<void> {
    const dims = this.#index?.hnsw ? requireIndexableDimensions(this.#index.dims) : undefined;
    const client = await this.#pool.connect();
    let locked = false;
    try {
      // Exempt from any configured `statement_timeout`, for the same reason migrations are: the column
      // rewrite and the concurrent index build below are legitimately slow, and a cancelled build leaves
      // an invalid index. Lock acquisition still has its own wall-clock bound below.
      await client.query("SET statement_timeout = 0");
      await acquireSessionAdvisoryLock(client, {
        key: PGVECTOR_SETUP_LOCK,
        timeoutMs: PGVECTOR_SETUP_LOCK_TIMEOUT_MS,
        timeoutMessage:
          `Timed out after ${PGVECTOR_SETUP_LOCK_TIMEOUT_MS}ms waiting for the pgvector setup lock ` +
          `(pg_advisory_lock key ${PGVECTOR_SETUP_LOCK}). Another instance is either still setting ` +
          `up pgvector, or a previous one died holding the lock — check for idle sessions with ` +
          `\`SELECT * FROM pg_locks WHERE locktype = 'advisory'\`.`,
      });
      locked = true;

      // Before the ALTER, not after: pinning a column that has an *invalid* index attached drops and
      // rebuilds that index inline, non-concurrently, holding ACCESS EXCLUSIVE on store_items for the
      // whole build — measured at ~48s on 400k rows where the same ALTER against a valid index is
      // ~3ms. That would block every read and write, at boot, with nothing in the logs. Clearing it
      // first means the rebuild happens concurrently below instead.
      if (dims !== undefined) await this.#dropInvalidHnswIndex(client);

      await client.query("BEGIN");
      try {
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
        if (dims !== undefined) await this.#pinEmbeddingDimension(client, dims);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      // On the same client, so the session lock above still covers it.
      if (dims !== undefined) await this.#createHnswIndex(client);
    } finally {
      // Unlock explicitly so a waiting peer proceeds immediately rather than when the socket tears down.
      // Swallowed on failure: destroying the connection below ends the session, which frees it anyway.
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [PGVECTOR_SETUP_LOCK]).catch(() => {});
      }
      // Destroyed, never returned to the pool. This session ran `SET statement_timeout = 0` above, which
      // is session-level: a client handed back carrying it would silently exempt whatever query reused
      // it. Destroying makes the pool open a fresh connection, which runs the connect hook and gets the
      // configured timeout — and it guarantees the advisory lock is gone even if the unlock failed.
      client.release(true);
    }
  }

  /**
   * Drop a leftover invalid HNSW index so the next build is concurrent rather than inline.
   *
   * An interrupted `CREATE INDEX CONCURRENTLY` leaves the index behind marked invalid: unusable by
   * queries, skipped by `IF NOT EXISTS`, and — the expensive part — silently rebuilt inline by any
   * later `ALTER COLUMN … TYPE` on the column it covers.
   */
  async #dropInvalidHnswIndex(client: PoolClient): Promise<void> {
    const { rows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
          WHERE c.relname = $1 AND NOT i.indisvalid
       ) AS exists`,
      [HNSW_INDEX_NAME],
    );
    if (rows[0]?.exists !== true) return;
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${HNSW_INDEX_NAME}`);
  }

  /**
   * Give the embedding column a fixed dimension, which pgvector requires before it can be indexed.
   *
   * The column is created dimensionless so the base schema works without knowing `dims`; HNSW cannot
   * work that way. This is a rewrite of the column under ACCESS EXCLUSIVE, so on a large
   * `store_items` the first boot with `hnsw` on blocks reads and writes for the duration — and it
   * queues behind any long-running query already touching the table.
   *
   * `dims` is pre-validated by {@link requireIndexableDimensions}, which is what makes interpolating
   * it safe.
   */
  async #pinEmbeddingDimension(client: PoolClient, dims: number): Promise<void> {
    try {
      await client.query(`ALTER TABLE store_items ALTER COLUMN embedding TYPE vector(${dims})`);
    } catch (error) {
      throw new Error(
        `Could not pin store_items.embedding to vector(${dims}), which store.index.hnsw requires. ` +
          `The usual cause is existing rows embedded at a different dimensionality — an embedder or ` +
          `model change. Re-embed those rows, or clear them, or turn store.index.hnsw off to keep ` +
          `exact (unindexed) search. Original error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Build the HNSW index, concurrently and outside any transaction.
   *
   * `IF NOT EXISTS` so every boot is a no-op once it exists. On a large `store_items` the first build
   * is slow; it does not block reads or writes, but it does hold the boot until it finishes. Raise
   * `maintenance_work_mem` if pgvector warns that the graph no longer fits in it — that is by far the
   * biggest lever on build time.
   */
  async #createHnswIndex(client: PoolClient): Promise<void> {
    try {
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${HNSW_INDEX_NAME}
           ON store_items USING hnsw (embedding vector_cosine_ops)`,
      );
    } catch (error) {
      throw new Error(
        `Could not build ${HNSW_INDEX_NAME}, required by store.index.hnsw. If this reports that the ` +
          `"hnsw" access method does not exist, the server's pgvector predates 0.5.0 — upgrade it or ` +
          `turn store.index.hnsw off. If it reports that CREATE INDEX CONCURRENTLY cannot run inside ` +
          `a transaction block, connect to the database directly rather than through a ` +
          `transaction-pooling proxy such as PgBouncer. An interrupted build leaves an invalid index, ` +
          `which the next boot clears and retries. Original error: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /** Close the connection pool. */
  async close(): Promise<void> {
    await this.#pool.end();
  }

  /** Empty every resource table. For tests that need a clean schema without re-migrating. */
  async truncateAll(): Promise<void> {
    await this.#pool.query(
      "TRUNCATE assistants, assistant_versions, threads, runs, crons, store_items CASCADE",
    );
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
   * (`loadSnapshotIntoStore` in `@skein-js/server-kit/dev` feature-detects it — see the importer).
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
    let skippedOrphanCrons = 0;

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
      // Version snapshots FK-reference assistants, so they go in after them. A version whose
      // assistant isn't part of the import is skipped (FK would abort the whole transaction).
      const importedAssistantIds = new Set(
        snapshot.assistants.map(([, assistant]) => assistant.assistant_id),
      );
      for (const [, version] of snapshot.assistantVersions ?? []) {
        if (!importedAssistantIds.has(version.assistant_id)) continue;
        await client.query(
          `INSERT INTO assistant_versions
             (assistant_id, version, graph_id, name, description, config, context, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)
           ON CONFLICT (assistant_id, version) DO NOTHING`,
          [
            version.assistant_id,
            version.version,
            version.graph_id,
            version.name ?? version.graph_id,
            version.description ?? null,
            JSON.stringify(version.config ?? {}),
            JSON.stringify(version.context ?? {}),
            JSON.stringify(version.metadata ?? {}),
            version.created_at,
          ],
        );
      }
      for (const [, thread] of snapshot.threads) {
        await client.query(
          `INSERT INTO threads
             (thread_id, status, metadata, values, interrupts, error, created_at, updated_at, state_updated_at)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
           ON CONFLICT (thread_id) DO NOTHING`,
          [
            thread.thread_id,
            thread.status ?? "idle",
            JSON.stringify(thread.metadata ?? {}),
            JSON.stringify(thread.values ?? {}),
            JSON.stringify(thread.interrupts ?? {}),
            typeof thread.error === "string" ? thread.error : null,
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
             (run_id, thread_id, assistant_id, status, metadata, multitask_strategy, kwargs, error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10)
           ON CONFLICT (run_id) DO NOTHING`,
          [
            run.run_id,
            run.thread_id,
            run.assistant_id,
            run.status ?? "pending",
            JSON.stringify(run.metadata ?? {}),
            run.multitask_strategy ?? null,
            kwargs === null ? null : JSON.stringify(kwargs),
            run.error === undefined ? null : JSON.stringify(run.error),
            run.created_at,
            run.updated_at,
          ],
        );
      }
      // After threads, since a thread cron FK-references one. A cron whose thread is not part of
      // this import is skipped rather than aborting the transaction, exactly like runs above.
      // `auth` is deliberately not restored: it is not in the snapshot (a snapshot is written to
      // disk, and a caller's permission scopes are not something to persist there), so a restored
      // cron fires unauthenticated until it is recreated.
      for (const [, cron] of snapshot.crons ?? []) {
        if (cron.thread_id != null && !importedThreadIds.has(cron.thread_id)) {
          skippedOrphanCrons += 1;
          continue;
        }
        await client.query(
          `INSERT INTO crons
             (cron_id, assistant_id, thread_id, schedule, timezone, end_time, next_run_date, enabled,
              on_run_completed, payload, metadata, user_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
           ON CONFLICT (cron_id) DO NOTHING`,
          [
            cron.cron_id,
            cron.assistant_id,
            cron.thread_id ?? null,
            cron.schedule,
            cron.timezone ?? null,
            cron.end_time ?? null,
            cron.next_run_date ?? null,
            cron.enabled ?? true,
            cron.on_run_completed ?? null,
            JSON.stringify(cron.payload ?? {}),
            JSON.stringify(cron.metadata ?? {}),
            cron.user_id ?? null,
            cron.created_at,
            cron.updated_at,
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
      if (skippedOrphanCrons > 0) {
        console.warn(
          `skein: skipped ${skippedOrphanCrons} imported cron(s) whose thread was not part of the import.`,
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
        // Tiebreaker for the same reason `search` has one: with a LIMIT, *which* rows come back is
        // undefined when `created_at` ties (a restored snapshot can tie at millisecond resolution).
        "SELECT * FROM assistants ORDER BY created_at, assistant_id LIMIT $1",
        [this.#pageLimit(undefined)],
      );
      return rows.map(rowToAssistant);
    },
    search: async (query: AssistantSearchQuery) => {
      const { where, params } = assistantSearchWhere(query);
      // Whitelist the sort column — it is interpolated, never parameterized.
      const sortColumns = new Set(["assistant_id", "graph_id", "name", "created_at", "updated_at"]);
      const sortBy = sortColumns.has(query.sortBy ?? "") ? query.sortBy : "created_at";
      const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
      params.push(query.offset ?? 0);
      const offsetParam = `$${params.length}`;
      // Always bounded: an absent limit means the first page, not the whole table.
      params.push(this.#pageLimit(query.limit));
      const limitClause = `LIMIT $${params.length}`;
      // `assistant_id` is a unique tiebreaker so OFFSET/LIMIT paging is stable when the primary sort
      // key ties — mirrors the memory driver's `ORDER BY <sortBy> <dir>, assistant_id <dir>`.
      const { rows } = await this.#pool.query<AssistantRow>(
        `SELECT * FROM assistants ${where} ORDER BY ${sortBy} ${direction}, assistant_id ${direction} OFFSET ${offsetParam} ${limitClause}`,
        params,
      );
      return rows.map(rowToAssistant);
    },
    count: async (query: AssistantSearchQuery) => {
      const { where, params } = assistantSearchWhere(query);
      const { rows } = await this.#pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM assistants ${where}`,
        params,
      );
      return Number.parseInt(rows[0]?.count ?? "0", 10);
    },
    get: async (assistantId) => {
      const { rows } = await this.#pool.query<AssistantRow>(
        "SELECT * FROM assistants WHERE assistant_id = $1",
        [assistantId],
      );
      return rows[0] ? rowToAssistant(rows[0]) : null;
    },
    create: async (input: AssistantCreate) =>
      this.#withTransaction(async (client) => {
        const assistantId = input.assistant_id ?? randomUUID();
        let rows: AssistantRow[];
        try {
          ({ rows } = await client.query<AssistantRow>(
            `INSERT INTO assistants (assistant_id, graph_id, name, description, config, context, metadata)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb) RETURNING *`,
            [
              assistantId,
              input.graph_id,
              input.name ?? input.graph_id,
              input.description ?? null,
              JSON.stringify(input.config ?? {}),
              JSON.stringify(input.context ?? {}),
              JSON.stringify(input.metadata ?? {}),
            ],
          ));
        } catch (error) {
          // Surface a duplicate id as a typed 409 (matches the memory driver) so the service can
          // apply if_exists and registerGraphAssistants can tolerate a concurrent-boot race.
          if (isUniqueViolation(error)) {
            throw SkeinHttpError.conflict(`Assistant "${assistantId}" already exists.`);
          }
          throw error;
        }
        const created = rows[0] as AssistantRow;
        // Seed version 1 from the row we just inserted, sharing its created_at.
        await client.query(
          `INSERT INTO assistant_versions
             (assistant_id, version, graph_id, name, description, config, context, metadata, created_at)
           VALUES ($1, 1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
          [
            assistantId,
            created.graph_id,
            created.name,
            created.description,
            JSON.stringify(created.config),
            JSON.stringify(created.context ?? {}),
            JSON.stringify(created.metadata),
            created.created_at,
          ],
        );
        return rowToAssistant(created);
      }),
    update: async (assistantId, patch: AssistantUpdate) =>
      this.#withTransaction(async (client) => {
        // Compute the merged row + next version atomically. COALESCE keeps omitted fields (NULL param
        // = "unchanged"); metadata MERGES via jsonb `||` (matching LangGraph — `x || NULL` is NULL, so
        // COALESCE falls back to the existing metadata when the param is absent); and the new version
        // is max(history)+1, NOT the live `version` (after a setLatest rollback the live version is
        // below the max, and `version + 1` would collide with an existing snapshot's primary key).
        const { rows } = await client.query<AssistantRow>(
          `UPDATE assistants SET
             graph_id = COALESCE($2, graph_id),
             name = COALESCE($3, name),
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             config = COALESCE($6::jsonb, config),
             context = COALESCE($7::jsonb, context),
             metadata = COALESCE(metadata || $8::jsonb, metadata),
             version = (SELECT COALESCE(MAX(version), 0) + 1 FROM assistant_versions WHERE assistant_id = $1),
             updated_at = now()
           WHERE assistant_id = $1 RETURNING *`,
          [
            assistantId,
            patch.graph_id ?? null,
            patch.name ?? null,
            patch.description !== undefined,
            patch.description ?? null,
            patch.config === undefined ? null : JSON.stringify(patch.config),
            patch.context === undefined ? null : JSON.stringify(patch.context),
            patch.metadata === undefined ? null : JSON.stringify(patch.metadata),
          ],
        );
        if (!rows[0]) throw SkeinHttpError.notFound(`Assistant "${assistantId}" not found.`);
        const updated = rows[0];
        // Append the new version snapshot, timestamped to this update (its own created_at).
        await client.query(
          `INSERT INTO assistant_versions
             (assistant_id, version, graph_id, name, description, config, context, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
          [
            assistantId,
            updated.version,
            updated.graph_id,
            updated.name,
            updated.description,
            JSON.stringify(updated.config),
            JSON.stringify(updated.context ?? {}),
            JSON.stringify(updated.metadata),
            updated.updated_at,
          ],
        );
        return rowToAssistant(updated);
      }),
    listVersions: async (assistantId, query?: AssistantVersionsQuery) => {
      const params: unknown[] = [assistantId];
      let where = "WHERE assistant_id = $1";
      if (query?.metadata && Object.keys(query.metadata).length > 0) {
        params.push(JSON.stringify(query.metadata));
        where += ` AND metadata @> $${params.length}::jsonb`;
      }
      params.push(query?.offset ?? 0);
      const offsetParam = `$${params.length}`;
      params.push(this.#pageLimit(query?.limit));
      const limitClause = `LIMIT $${params.length}`;
      const { rows } = await this.#pool.query<AssistantVersionRow>(
        `SELECT * FROM assistant_versions ${where} ORDER BY version DESC OFFSET ${offsetParam} ${limitClause}`,
        params,
      );
      return rows.map(rowToAssistantVersion);
    },
    setLatest: async (assistantId, version) =>
      this.#withTransaction(async (client) => {
        const target = await client.query<AssistantVersionRow>(
          "SELECT * FROM assistant_versions WHERE assistant_id = $1 AND version = $2",
          [assistantId, version],
        );
        if (!target.rows[0]) {
          // Distinguish an unknown assistant from an unknown version, matching the memory driver.
          const exists = await client.query("SELECT 1 FROM assistants WHERE assistant_id = $1", [
            assistantId,
          ]);
          throw SkeinHttpError.notFound(
            exists.rows[0]
              ? `Version ${version} of assistant "${assistantId}" not found.`
              : `Assistant "${assistantId}" not found.`,
          );
        }
        const snapshot = target.rows[0];
        const { rows } = await client.query<AssistantRow>(
          `UPDATE assistants SET
             graph_id = $2, name = $3, description = $4,
             config = $5::jsonb, context = $6::jsonb, metadata = $7::jsonb,
             version = $8, updated_at = now()
           WHERE assistant_id = $1 RETURNING *`,
          [
            assistantId,
            snapshot.graph_id,
            snapshot.name,
            snapshot.description,
            JSON.stringify(snapshot.config),
            JSON.stringify(snapshot.context ?? {}),
            JSON.stringify(snapshot.metadata),
            snapshot.version,
          ],
        );
        // The version SELECT above ran in this transaction, but a concurrent delete could still have
        // removed the assistant under READ COMMITTED — return a clean 404 rather than crash on rows[0].
        if (!rows[0]) throw SkeinHttpError.notFound(`Assistant "${assistantId}" not found.`);
        return rowToAssistant(rows[0]);
      }),
    delete: async (assistantId) => {
      // Versions cascade via the foreign key's ON DELETE CASCADE.
      await this.#pool.query("DELETE FROM assistants WHERE assistant_id = $1", [assistantId]);
    },
  };

  readonly threads: ThreadRepo = {
    list: async () => {
      const { rows } = await this.#pool.query<ThreadRow>(
        "SELECT * FROM threads ORDER BY created_at, thread_id LIMIT $1",
        [this.#pageLimit(undefined)],
      );
      return rows.map(rowToThread);
    },
    search: async (query) => {
      const { where, params } = threadSearchWhere(query);
      // Whitelist the sort column — it is interpolated, never parameterized.
      const sortColumns = new Set(["thread_id", "status", "created_at", "updated_at"]);
      const sortBy = sortColumns.has(query.sortBy ?? "") ? query.sortBy : "created_at";
      const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
      params.push(query.offset ?? 0);
      const offsetParam = `$${params.length}`;
      // Always bounded: an absent limit means the first page, not the whole table.
      params.push(this.#pageLimit(query.limit));
      const limitClause = `LIMIT $${params.length}`;
      // `thread_id` is a unique tiebreaker so OFFSET/LIMIT paging is stable when the primary sort key
      // ties (equal timestamps/status) — without it Postgres row order is undefined across queries and
      // a page could drop or duplicate a row.
      const { rows } = await this.#pool.query<ThreadRow>(
        `SELECT * FROM threads ${where} ORDER BY ${sortBy} ${direction}, thread_id ${direction} OFFSET ${offsetParam} ${limitClause}`,
        params,
      );
      return rows.map(rowToThread);
    },
    count: async (query) => {
      const { where, params } = threadSearchWhere(query);
      const { rows } = await this.#pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM threads ${where}`,
        params,
      );
      // ::text then parse: a bare count(*) is bigint, which `pg` hands back as a string anyway, and
      // being explicit keeps the driver from silently depending on that.
      return Number.parseInt(rows[0]?.count ?? "0", 10);
    },
    get: async (threadId) => {
      const { rows } = await this.#pool.query<ThreadRow>(
        "SELECT * FROM threads WHERE thread_id = $1",
        [threadId],
      );
      return rows[0] ? rowToThread(rows[0]) : null;
    },
    create: async (input?: ThreadCreate) => {
      const threadId = input?.thread_id ?? randomUUID();
      // An absent `ttl` falls back to the configured default, so a create that says nothing still
      // expires under a configured policy; an explicit `null` pins the thread against any TTL.
      const ttlMinutes =
        input?.ttl === undefined ? (this.#threadTtl?.defaultTtl ?? null) : input.ttl;
      try {
        const { rows } = await this.#pool.query<ThreadRow>(
          `INSERT INTO threads (thread_id, status, metadata, ttl_minutes, expires_at)
           VALUES ($1, $2, $3::jsonb, $4, ${expiresAtSql("$4")}) RETURNING *`,
          [threadId, input?.status ?? "idle", JSON.stringify(input?.metadata ?? {}), ttlMinutes],
        );
        return rowToThread(rows[0] as ThreadRow);
      } catch (error) {
        // A duplicate id is a typed 409, matching the memory driver and every other create here —
        // the service turns it into if_exists handling. Without this the raw `pg` unique violation
        // escaped as a 500.
        if (isUniqueViolation(error)) {
          throw SkeinHttpError.conflict(`Thread "${threadId}" already exists.`);
        }
        throw error;
      }
    },
    update: async (threadId, patch: ThreadUpdate) => {
      const { rows } = await this.#pool.query<ThreadRow>(
        `UPDATE threads SET
           metadata = COALESCE($2::jsonb, metadata),
           status = COALESCE($3, status),
           values = COALESCE($4::jsonb, values),
           interrupts = COALESCE($5::jsonb, interrupts),
           error = CASE WHEN $6::boolean THEN $7::text ELSE error END,
           ttl_minutes = CASE WHEN $8::boolean THEN $9::double precision ELSE ttl_minutes END,
           expires_at = CASE WHEN $8::boolean THEN ${expiresAtSql("$9")} ELSE expires_at END,
           updated_at = now(),
           state_updated_at = CASE WHEN $4::jsonb IS NOT NULL THEN now() ELSE state_updated_at END
         WHERE thread_id = $1 RETURNING *`,
        [
          threadId,
          patch.metadata === undefined ? null : JSON.stringify(patch.metadata),
          patch.status ?? null,
          patch.values === undefined ? null : JSON.stringify(patch.values),
          patch.interrupts === undefined ? null : JSON.stringify(patch.interrupts),
          // `error` is tri-state, so COALESCE can't express it: absent leaves the column alone,
          // `null` clears it, a string sets it. The boolean says "the patch mentioned error".
          patch.error !== undefined,
          patch.error ?? null,
          // `ttl` is tri-state for the same reason: absent leaves the expiry alone, `null` pins the
          // thread, a number restarts its clock from now.
          patch.ttl !== undefined,
          patch.ttl ?? null,
        ],
      );
      if (!rows[0]) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
      return rowToThread(rows[0]);
    },
    copy: async (threadId) => {
      // Duplicate the row under a fresh id and timestamps; checkpoint history is copied separately
      // at the service layer via the LangGraph checkpointer.
      const { rows } = await this.#pool.query<ThreadRow>(
        // A copy is a new thread, so it starts its own clock under the configured default rather
        // than inheriting the original's remaining lifetime.
        `INSERT INTO threads (thread_id, status, metadata, values, interrupts, error, ttl_minutes, expires_at)
         SELECT $1, status, metadata, values, interrupts, error, $3, ${expiresAtSql("$3")}
         FROM threads WHERE thread_id = $2
         RETURNING *`,
        [randomUUID(), threadId, this.#threadTtl?.defaultTtl ?? null],
      );
      if (!rows[0]) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
      return rowToThread(rows[0]);
    },
    listExpired: async ({ now, limit }) => {
      // Ids only: the sweeper deletes each through the thread service so an in-flight run is aborted
      // and checkpoints are cleaned up, which this bare row read cannot do. Oldest expiry first, so a
      // backlog drains in the order it accrued rather than starving the earliest threads.
      const { rows } = await this.#pool.query<{ thread_id: string }>(
        `SELECT thread_id FROM threads
         WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
         ORDER BY expires_at ASC, thread_id ASC
         LIMIT $2`,
        [now, this.#pageLimit(limit)],
      );
      return rows.map((row) => row.thread_id);
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
    listByThread: async (threadId, query) => {
      const params: unknown[] = [threadId];
      // The status filter joins the WHERE clause rather than filtering a page afterwards, so
      // `limit`/`offset` page the filtered set — see `RunListQuery.status`.
      let statusSql = "";
      if (query?.status !== undefined) {
        params.push(query.status);
        statusSql = ` AND status = $${params.length}`;
      }
      let paginationSql = "";
      if (query?.limit !== undefined) {
        params.push(query.offset ?? 0);
        const offsetParam = `$${params.length}`;
        params.push(query.limit);
        paginationSql = ` OFFSET ${offsetParam} LIMIT $${params.length}`;
      }
      const { rows } = await this.#pool.query<RunRow>(
        `SELECT * FROM runs WHERE thread_id = $1${statusSql} ORDER BY created_at, run_id${paginationSql}`,
        params,
      );
      return rows.map(rowToRun);
    },
    create: async (input: RunCreate) => insertRun(this.#pool, input),
    createIfThreadIdle: async (input: RunCreate) => {
      // Serialized on the **thread row**, not on the runs table: `SELECT … FOR UPDATE` takes a row lock
      // that concurrent run-creates for the same thread queue behind, so the inflight check below and
      // the insert are indivisible against other connections — which is the whole point (see the
      // `createIfThreadIdle` contract).
      //
      // A bare `INSERT … WHERE NOT EXISTS (…)` is NOT enough, and that is the trap this replaces: under
      // READ COMMITTED the subquery reads a snapshot and takes no predicate lock, so two concurrent
      // inserts both see an idle thread and both land. A unique partial index would be airtight but is
      // wrong here — `enqueue` legitimately creates a second inflight run on a busy thread.
      //
      // Locking the *parent* row rather than raising the isolation level keeps the contention exactly as
      // narrow as the invariant (one thread), and Postgres releases it on commit or on a dropped
      // connection with no timeout to tune.
      return this.#withTransaction(async (client) => {
        const { rows: threadRows } = await client.query<{ thread_id: string }>(
          "SELECT thread_id FROM threads WHERE thread_id = $1 FOR UPDATE",
          [input.thread_id],
        );
        // No thread row means the caller's `ensureThread` did not run (or it was deleted meanwhile).
        // Refuse rather than insert a run whose foreign key is about to fail anyway.
        if (!threadRows[0]) return null;

        const { rows: inflight } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM runs WHERE thread_id = $1 AND status IN (${INFLIGHT_STATUS_SQL})) AS exists`,
          [input.thread_id],
        );
        if (inflight[0]?.exists) return null;

        return insertRun(client, input);
      });
    },
    setStatus: async (runId, status: RunStatus, error?: RunError) => {
      // `error` is written unconditionally, so omitting it clears a stale one — a run row's error
      // always describes its current status. Status and error move in the same single write; see
      // the `RunRepo.setStatus` contract for why they must not be split.
      const { rows } = await this.#pool.query<RunRow>(
        "UPDATE runs SET status = $2, error = $3::jsonb, updated_at = now() WHERE run_id = $1 RETURNING *",
        [runId, status, error === undefined ? null : JSON.stringify(error)],
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
    recordBaseCheckpoint: async (runId, baseCheckpointId) => {
      // `jsonb_set` patches the one key server-side, so a concurrent write to another key is not lost
      // and the run's whole input blob is neither read back nor re-serialized. `coalesce` covers a run
      // created without kwargs; `create_missing = true` adds the key on first record. The value is
      // JSON-encoded so a `null` lands as jsonb null (recorded-as-empty) rather than as SQL NULL, which
      // `jsonb_set` would turn the entire kwargs column into.
      await this.#pool.query(
        `UPDATE runs
            SET kwargs = jsonb_set(coalesce(kwargs, '{}'::jsonb), '{base_checkpoint_id}', $2::jsonb, true)
          WHERE run_id = $1`,
        [runId, JSON.stringify(baseCheckpointId)],
      );
    },
    hasActiveRun: async (threadId) => {
      const { rows } = await this.#pool.query<{ active: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM runs WHERE thread_id = $1 AND status IN (${INFLIGHT_STATUS_SQL})) AS active`,
        [threadId],
      );
      return rows[0]?.active ?? false;
    },
    // `threadId` omitted sweeps every thread (see the `RunRepo.listActiveRuns` contract). Bounded like
    // every other unbounded read, so a server with a very large backlog can't be made to materialize
    // all of it in one call.
    //
    // Filtered *positively* against `INFLIGHT_STATUS_SQL`, not with `NOT (status = ANY($n))`. Postgres
    // uses a partial index only when it can prove the query implies the index predicate, and it cannot
    // prove that of a negated, parameterized list — so the negated form made the whole-server sweep
    // sequential-scan and sort the entire `runs` table while still paying `runs_inflight_created_at_idx`'s
    // write cost. See migration 0006.
    listActiveRuns: async (threadId) => {
      const params: unknown[] = [];
      let threadSql = "";
      if (threadId !== undefined) {
        params.push(threadId);
        threadSql = ` AND thread_id = $${params.length}`;
      }
      params.push(this.#pageLimit(undefined));
      const { rows } = await this.#pool.query<RunRow>(
        `SELECT * FROM runs WHERE status IN (${INFLIGHT_STATUS_SQL})${threadSql} ` +
          `ORDER BY created_at, run_id LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToRun);
    },
  };

  readonly crons: CronRepo = {
    get: async (cronId) => {
      const { rows } = await this.#pool.query<CronRow>("SELECT * FROM crons WHERE cron_id = $1", [
        cronId,
      ]);
      return rows[0] ? rowToCron(rows[0]) : null;
    },
    search: async (query) => {
      const { where, params } = cronSearchWhere(query);
      // Whitelist the sort column — it is interpolated, never parameterized.
      const sortColumns = new Set([
        "cron_id",
        "assistant_id",
        "thread_id",
        "created_at",
        "updated_at",
        "next_run_date",
        // In the OpenAPI spec's `sort_by` enum but not the SDK's; accepted so a client written
        // against either does not get a silent fallback to `created_at`.
        "end_time",
      ]);
      const sortBy = sortColumns.has(query.sortBy ?? "") ? query.sortBy : "created_at";
      const direction = query.sortOrder === "asc" ? "ASC" : "DESC";
      params.push(query.offset ?? 0);
      const offsetParam = `$${params.length}`;
      params.push(this.#pageLimit(query.limit));
      // `NULLS LAST` explicitly in both directions: `next_run_date` and `end_time` are nullable, and
      // Postgres defaults nulls first on DESC — which would put every dormant cron at the top of
      // "soonest next run". The memory driver sorts nulls last unconditionally to match.
      const { rows } = await this.#pool.query<CronRow>(
        `SELECT * FROM crons ${where} ORDER BY ${sortBy} ${direction} NULLS LAST, cron_id ${direction} ` +
          `OFFSET ${offsetParam} LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToCron);
    },
    count: async (query) => {
      const { where, params } = cronSearchWhere(query);
      const { rows } = await this.#pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM crons ${where}`,
        params,
      );
      return Number.parseInt(rows[0]?.count ?? "0", 10);
    },
    create: async (input: CronCreate) => {
      const cronId = input.cron_id ?? randomUUID();
      try {
        return await insertCron(this.#pool, cronId, input);
      } catch (error) {
        // A duplicate id is a typed 409, matching the memory driver and every other create here.
        // Not reachable over HTTP today (the service assigns the id), but a direct `store.crons.create`
        // — the embedded path — would otherwise get a raw `pg` error as a 500.
        if (isUniqueViolation(error)) {
          throw SkeinHttpError.conflict(`Cron "${cronId}" already exists.`);
        }
        throw error;
      }
    },
    update: async (cronId, patch: CronUpdate) => {
      // Every nullable field is tri-state: a `$n::boolean` "was it supplied" flag drives a CASE, so
      // an explicit `null` clears while an omitted key leaves the stored value. `COALESCE` alone
      // cannot express that — it reads null as "not supplied", making "clear my end date"
      // unexpressible, which the wire contract requires (PATCH: send null to clear).
      const { rows } = await this.#pool.query<CronRow>(
        `UPDATE crons SET
           schedule = COALESCE($2, schedule),
           timezone = CASE WHEN $3::boolean THEN $4::text ELSE timezone END,
           end_time = CASE WHEN $5::boolean THEN $6::timestamptz ELSE end_time END,
           next_run_date = CASE WHEN $7::boolean THEN $8::timestamptz ELSE next_run_date END,
           enabled = COALESCE($9::boolean, enabled),
           on_run_completed = CASE WHEN $10::boolean THEN $11::text ELSE on_run_completed END,
           payload = COALESCE($12::jsonb, payload),
           -- metadata MERGES (shallow) via ||, matching assistants and LangGraph's PATCH semantics.
           metadata = CASE WHEN $13::jsonb IS NULL THEN metadata ELSE metadata || $13::jsonb END,
           -- Bumped on every write, so a claim raced by this patch loses and the scheduler re-reads
           -- next tick rather than firing against a payload the caller has just replaced.
           occurrence_seq = occurrence_seq + 1,
           updated_at = now()
         WHERE cron_id = $1
         RETURNING *`,
        [
          cronId,
          patch.schedule ?? null,
          patch.timezone !== undefined,
          patch.timezone ?? null,
          patch.end_time !== undefined,
          patch.end_time ?? null,
          patch.next_run_date !== undefined,
          patch.next_run_date ?? null,
          patch.enabled ?? null,
          patch.on_run_completed !== undefined,
          patch.on_run_completed ?? null,
          patch.payload === undefined ? null : JSON.stringify(patch.payload),
          patch.metadata === undefined ? null : JSON.stringify(patch.metadata),
        ],
      );
      if (!rows[0]) throw SkeinHttpError.notFound(`Cron "${cronId}" not found.`);
      return rowToCron(rows[0]);
    },
    delete: async (cronId) => {
      await this.#pool.query("DELETE FROM crons WHERE cron_id = $1", [cronId]);
    },
    // `WHERE enabled` is a bare literal, deliberately: that is what lets the planner match the
    // partial index `crons_due_idx`. `enabled = $n` would sequential-scan while still paying the
    // index's write cost — the same trap migration 0006 documents for inflight runs.
    listDue: async (query) => {
      const { rows } = await this.#pool.query<CronRow>(
        `SELECT * FROM crons
          WHERE enabled AND next_run_date IS NOT NULL AND next_run_date <= $1::timestamptz
          ORDER BY next_run_date ASC, cron_id ASC
          LIMIT $2`,
        [query.dueAt, this.#pageLimit(query.limit)],
      );
      return rows.map((row) => ({ cron: rowToCron(row), occurrenceSeq: rowToOccurrenceSeq(row) }));
    },
    claimAndCreateRun: async (cronId, claim, runInput) =>
      // One transaction, so the claim and the run row commit together. That is what makes the run
      // row a transactional outbox: advancing alone would silently skip the occurrence if this
      // instance died before the insert, and inserting first would re-fire it. Committed together,
      // the worst case is a `pending` run that was never enqueued — which the scheduler re-enqueues,
      // and which is the window every background run already has.
      this.#withTransaction(async (client) => {
        const claimed = await claimCronOccurrence(client, cronId, claim);
        if (!claimed) return null;
        const run = await insertRun(client, runInput);
        return { cron: claimed, run };
      }),
    claimNextRun: async (cronId, claim) => claimCronOccurrence(this.#pool, cronId, claim),
    getAuth: async (cronId) => {
      const { rows } = await this.#pool.query<{ auth: CronAuth | null }>(
        "SELECT auth FROM crons WHERE cron_id = $1",
        [cronId],
      );
      return rows[0]?.auth ?? null;
    },
    maxOverdueMs: async (now) => {
      // `min(next_run_date)` over the same predicate the due scan uses, so it reads the partial
      // index rather than the table, and cannot be under-reported by a truncated page.
      const { rows } = await this.#pool.query<{ overdue_ms: string | null }>(
        `SELECT extract(epoch FROM ($1::timestamptz - min(next_run_date))) * 1000 AS overdue_ms
           FROM crons
          WHERE enabled AND next_run_date IS NOT NULL AND next_run_date <= $1::timestamptz`,
        [now],
      );
      const overdue = rows[0]?.overdue_ms;
      return overdue == null ? null : Math.round(Number(overdue));
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
    listNamespaces: async (prefix, pagination) => {
      const usePrefix = prefix !== undefined && prefix.length > 0;
      const clause = usePrefix
        ? `WHERE namespace[1:cardinality($1::text[])] = $1::text[] AND ${NOT_EXPIRED}`
        : `WHERE ${NOT_EXPIRED}`;
      const params: unknown[] = usePrefix ? [prefix] : [];
      let paginationSql = "";
      if (pagination?.limit !== undefined) {
        params.push(pagination.offset ?? 0, pagination.limit);
        paginationSql = ` OFFSET $${params.length - 1} LIMIT $${params.length}`;
      }
      const { rows } = await this.#pool.query<{ namespace: string[] }>(
        `SELECT DISTINCT namespace FROM store_items ${clause} ORDER BY namespace${paginationSql}`,
        params,
      );
      return rows.map((row) => row.namespace);
    },
    sweepExpired: async () => {
      // Deleted in batches, not in one statement. A single unbounded DELETE is all-or-nothing under the
      // statement timeout: once the expired backlog is large enough to exceed it — a first sweep after
      // enabling TTL on an existing store, or a restart after downtime — the statement is cancelled, the
      // whole delete rolls back, and the next sweep starts from a *larger* backlog. It could then never
      // succeed again, and the only symptom would be a table growing forever, since reads filter expired
      // rows out anyway. Batching makes each round independently committed, so progress is guaranteed.
      let swept = 0;
      for (;;) {
        // `ctid` rather than the primary key: it is the physical row pointer, so the subselect feeds the
        // delete without a second index lookup per row.
        const { rowCount } = await this.#pool.query(
          `DELETE FROM store_items WHERE ctid IN (
             SELECT ctid FROM store_items
              WHERE expires_at IS NOT NULL AND expires_at <= now()
              LIMIT ${SWEEP_BATCH_ROWS}
           )`,
        );
        const deleted = rowCount ?? 0;
        swept += deleted;
        if (deleted < SWEEP_BATCH_ROWS) return swept;
      }
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
      // Always bounded: an absent limit means the first page, not the whole table.
      params.push(this.#pageLimit(query.limit));
      const limitClause = `LIMIT $${params.length}`;
      const { rows } = await this.#pool.query<ItemRow & { score: number }>(
        `SELECT namespace, key, value, created_at, updated_at, 1 - (embedding <=> $1::vector) AS score
         FROM store_items WHERE ${where}
         ORDER BY embedding <=> $1::vector OFFSET ${offsetParam} ${limitClause}`,
        params,
      );
      return rows.map((row) => rowToItem(row, row.score));
    }

    const params: unknown[] = usePrefix ? [query.prefix] : [];
    const clause = usePrefix
      ? `WHERE namespace[1:cardinality($1::text[])] = $1::text[] AND ${NOT_EXPIRED}`
      : `WHERE ${NOT_EXPIRED}`;

    // Without a text query the rows SQL returns are exactly the rows we return, so paginate in the
    // database. This is the common shape — a plain namespace listing — and it used to read the whole
    // table to slice it in JS.
    //
    // *With* a text query the filter runs in JS, and it cannot be pushed down as-is: the JS predicate
    // matches against `JSON.stringify(value)`, whereas jsonb `::text` canonicalizes key order and
    // whitespace, so `value::text ILIKE` is a different match. Pushing `LIMIT` down ahead of the JS
    // filter would also drop true matches beyond the window. That path is therefore still an unbounded
    // read; fixing it means aligning both drivers on one normalized text, which is a conformance-level
    // change and its own piece of work. Configure `store.index` for pgvector search to avoid it.
    let pagination = "";
    if (query.query === undefined) {
      params.push(query.offset ?? 0);
      const offsetParam = `$${params.length}`;
      params.push(this.#pageLimit(query.limit));
      pagination = `OFFSET ${offsetParam} LIMIT $${params.length}`;
    }

    const { rows } = await this.#pool.query<ItemRow>(
      `SELECT namespace, key, value, created_at, updated_at FROM store_items ${clause}
       ORDER BY created_at, key ${pagination}`,
      params,
    );

    let items: SearchItem[] = rows.map((row) => rowToItem(row));
    if (query.query === undefined) return items;

    const needle = query.query.toLowerCase();
    items = items
      .filter((item) => JSON.stringify(item.value).toLowerCase().includes(needle))
      .map((item) => ({ ...item, score: 1 }));
    const offset = query.offset ?? 0;
    return items.slice(offset, offset + this.#pageLimit(query.limit));
  }
}
