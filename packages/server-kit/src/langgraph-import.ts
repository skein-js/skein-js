// Import an existing LangGraph.js **in-memory** dev state into skein, losslessly. When someone
// runs `langgraph dev` (the `@langchain/langgraph-api` server), all local state — assistants,
// threads, runs, store items, and graph checkpoints — is persisted under a `.langgraph_api/`
// directory. This reads that directory and reconstructs skein's own `DevStateSnapshot`, so
// adopting skein (`skein dev`, or a Postgres deployment) carries everything over.
//
// Two things make this clean:
//   • LangGraph's on-disk format is three superjson JSON files (not pickle/binary). The only
//     custom transformer it uses is `Uint8Array` ⇄ base64, which we replicate on a *private*
//     superjson instance (no global side effects). We deliberately skip `@langchain/core`'s `load`
//     reviver: skein treats graph state/config/values as opaque JSON, and checkpoint blobs stay
//     bytes — so reconstructing LangChain class instances would only round-trip back to the same
//     serialized form.
//   • LangGraph's checkpointer file *is* a `MemorySaver`'s `storage`/`writes` maps — the exact
//     shape `dev-persistence.ts` already snapshots — so we reuse `snapshotCheckpointer` verbatim.
//
// The `.langgraph_api/` file names and layout are `@langchain/langgraph-api` internals (verified
// stable across 1.2.x–1.4.x), not a public API, so reads are best-effort and guarded by the caller.

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  MemorySaver,
  type BaseCheckpointSaver,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import {
  isTerminalRunStatus,
  type Assistant,
  type AssistantVersion,
  type Item,
  type Run,
  type RunKwargs,
  type SkeinStore,
  type SkeinStoreSnapshot,
  type Thread,
} from "@skein-js/core";
import { SuperJSON } from "superjson";
import { z } from "zod";

import {
  hydrateCheckpointer,
  snapshotCheckpointer,
  type CheckpointerSnapshot,
  type DevStateSnapshot,
} from "./dev-persistence.js";

/** The three files `@langchain/langgraph-api` writes under `.langgraph_api/`. */
const OPS_FILE = ".langgraphjs_ops.json";
const STORE_FILE = ".langgraphjs_api.store.json";
const CHECKPOINTER_FILE = ".langgraphjs_api.checkpointer.json";

/**
 * A private superjson reader configured exactly like `@langchain/langgraph-api`'s persistence
 * layer — its one custom transformer is `Uint8Array` ⇄ base64. Using an instance (not the global
 * singleton) keeps importing this module side-effect free, which `sideEffects: false` relies on.
 */
const langgraphSuperjson = new SuperJSON();
langgraphSuperjson.registerCustom<Uint8Array, string>(
  {
    isApplicable: (value): value is Uint8Array => value instanceof Uint8Array,
    serialize: (value) => Buffer.from(value).toString("base64"),
    deserialize: (value) => new Uint8Array(Buffer.from(value, "base64")),
  },
  "Uint8Array",
);

// --- LangGraph on-disk shapes (only the fields we read) -----------------------------------
// These files are written by a *different* tool, so we validate them at this boundary with Zod
// (AGENTS.md golden rule) rather than blindly casting — a malformed row is rejected with a clear
// error here instead of surfacing later as a corrupt skein row or a Postgres constraint violation.
// `.passthrough()` keeps unknown/newer fields, and timestamps are `Date` (post-superjson) or string.

const timestamp = z.union([z.date(), z.string()]).optional();
const jsonObject = z.record(z.unknown());

const langgraphAssistantSchema = z
  .object({
    assistant_id: z.string(),
    graph_id: z.string(),
    name: z.string().optional(),
    description: z.string().nullish(),
    config: jsonObject.optional(),
    context: z.unknown().optional(),
    metadata: jsonObject.optional(),
    version: z.number().optional(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .passthrough();

// A single entry from the top-level `assistant_versions` array — one immutable version snapshot.
const langgraphAssistantVersionSchema = z
  .object({
    assistant_id: z.string(),
    version: z.number(),
    graph_id: z.string(),
    name: z.string().optional(),
    description: z.string().nullish(),
    config: jsonObject.optional(),
    context: z.unknown().optional(),
    metadata: jsonObject.optional(),
    created_at: timestamp,
  })
  .passthrough();

const langgraphThreadSchema = z
  .object({
    thread_id: z.string(),
    status: z.string().optional(),
    metadata: jsonObject.optional(),
    values: jsonObject.optional(),
    interrupts: jsonObject.optional(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .passthrough();

const langgraphRunSchema = z
  .object({
    run_id: z.string(),
    thread_id: z.string(),
    assistant_id: z.string(),
    status: z.string().optional(),
    metadata: jsonObject.optional(),
    multitask_strategy: z.string().nullish(),
    kwargs: jsonObject.optional(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .passthrough();

const langgraphOpsSchema = z
  .object({
    assistants: z.record(langgraphAssistantSchema).optional(),
    assistant_versions: z.array(langgraphAssistantVersionSchema).optional(),
    threads: z.record(langgraphThreadSchema).optional(),
    runs: z.record(langgraphRunSchema).optional(),
  })
  .passthrough();

const langgraphStoreItemSchema = z
  .object({
    namespace: z.array(z.string()),
    key: z.string(),
    value: jsonObject,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .passthrough();

/** `InMemoryStore`'s internals: `data` is `namespace → key → item` (`vectors` is a derived index we
 * don't import). Validating `data` here also validates every store item at the boundary. */
const langgraphStoreFileSchema = z
  .object({ data: z.map(z.string(), z.map(z.string(), langgraphStoreItemSchema)).optional() })
  .passthrough();

/** `MemorySaver`'s internal maps as LangGraph persists them (blobs are `Uint8Array`, kept opaque). */
const langgraphCheckpointerSchema = z
  .object({ storage: jsonObject, writes: jsonObject })
  .passthrough();

type LanggraphAssistant = z.infer<typeof langgraphAssistantSchema>;
type LanggraphAssistantVersion = z.infer<typeof langgraphAssistantVersionSchema>;
type LanggraphThread = z.infer<typeof langgraphThreadSchema>;
type LanggraphRun = z.infer<typeof langgraphRunSchema>;

/**
 * Read + superjson-decode one `.langgraph_api/` file. Returns `null` when the file is absent
 * (nothing to import). A present-but-unparseable file throws a clear, file-named error rather than
 * a raw superjson exception, and never returns `undefined` — so callers' nullish checks are honest.
 */
async function readSuperjsonFile<T>(filepath: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(filepath, "utf8");
  } catch {
    return null;
  }
  try {
    return langgraphSuperjson.parse<T>(text) ?? null;
  } catch (error) {
    throw new Error(
      `Could not parse LangGraph state file "${filepath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Validate a decoded value against a schema, throwing a concise, boundary-named error on mismatch. */
function validateShape<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid LangGraph ${label}: ${detail}`);
  }
  return result.data;
}

/** A `Date` (post-superjson) or already-ISO string → ISO string; `fallback` when absent. */
function toIso(value: Date | string | undefined, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return fallback;
}

function toAssistant(row: LanggraphAssistant, now: string): Assistant {
  return {
    assistant_id: row.assistant_id,
    graph_id: row.graph_id,
    name: row.name ?? row.graph_id,
    description: row.description ?? undefined,
    config: row.config ?? {},
    context: row.context ?? {},
    metadata: row.metadata ?? {},
    version: row.version ?? 1,
    created_at: toIso(row.created_at, now),
    updated_at: toIso(row.updated_at, now),
  } as Assistant;
}

function toAssistantVersion(row: LanggraphAssistantVersion, now: string): AssistantVersion {
  return {
    assistant_id: row.assistant_id,
    version: row.version,
    graph_id: row.graph_id,
    name: row.name ?? row.graph_id,
    description: row.description ?? undefined,
    config: row.config ?? {},
    context: row.context ?? {},
    metadata: row.metadata ?? {},
    created_at: toIso(row.created_at, now),
  } as AssistantVersion;
}

function toThread(row: LanggraphThread, now: string): Thread {
  const createdAt = toIso(row.created_at, now);
  const updatedAt = toIso(row.updated_at, createdAt);
  return {
    thread_id: row.thread_id,
    status: (row.status ?? "idle") as Thread["status"],
    metadata: row.metadata ?? {},
    values: row.values ?? {},
    interrupts: (row.interrupts ?? {}) as Thread["interrupts"],
    created_at: createdAt,
    updated_at: updatedAt,
    state_updated_at: updatedAt,
  } as Thread;
}

function toRun(row: LanggraphRun, now: string): Run {
  const createdAt = toIso(row.created_at, now);
  // A run captured mid-flight by `langgraph dev` (pending/running) can never be resumed or finished
  // by skein — no worker owns it. Left non-terminal, it would make hasActiveRun() report the thread
  // busy forever, so every subsequent run on it 409s. Coerce such runs to a terminal `error` so the
  // imported thread stays usable (its state/history live in the checkpointer regardless).
  const status = (row.status ?? "success") as Run["status"];
  return {
    run_id: row.run_id,
    thread_id: row.thread_id,
    assistant_id: row.assistant_id,
    status: isTerminalRunStatus(status) ? status : "error",
    metadata: row.metadata ?? {},
    multitask_strategy: (row.multitask_strategy ?? null) as Run["multitask_strategy"],
    created_at: createdAt,
    updated_at: toIso(row.updated_at, createdAt),
  } as Run;
}

/** Keep only the replay fields skein's `RunKwargs` models (LangGraph carries other extras too). */
function toRunKwargs(kwargs: Record<string, unknown> | undefined): RunKwargs {
  if (!kwargs) return {};
  const {
    input,
    command,
    config,
    context,
    stream_mode,
    interrupt_before,
    interrupt_after,
    webhook,
  } = kwargs as RunKwargs & Record<string, unknown>;
  return {
    input,
    command,
    config,
    context,
    stream_mode,
    interrupt_before,
    interrupt_after,
    ...(typeof webhook === "string" ? { webhook } : {}),
  };
}

/**
 * Read a LangGraph `.langgraph_api/` directory and reconstruct skein's `DevStateSnapshot`.
 * Returns `null` when the directory holds none of the expected files (nothing to import).
 */
export async function readLanggraphDevState(
  langgraphApiDir: string,
): Promise<DevStateSnapshot | null> {
  const now = new Date().toISOString();

  // Read raw (a present-but-corrupt file throws; an absent one is null), then validate each at this
  // untrusted boundary before mapping.
  const [opsRaw, storeRaw, checkpointerRaw] = await Promise.all([
    readSuperjsonFile<unknown>(path.join(langgraphApiDir, OPS_FILE)),
    readSuperjsonFile<unknown>(path.join(langgraphApiDir, STORE_FILE)),
    readSuperjsonFile<unknown>(path.join(langgraphApiDir, CHECKPOINTER_FILE)),
  ]);

  // Nothing present (each is null/undefined) → nothing to import.
  if (!opsRaw && !storeRaw && !checkpointerRaw) return null;

  const ops = opsRaw ? validateShape(langgraphOpsSchema, opsRaw, OPS_FILE) : null;
  const storeFile = storeRaw ? validateShape(langgraphStoreFileSchema, storeRaw, STORE_FILE) : null;
  const checkpointerFile = checkpointerRaw
    ? validateShape(langgraphCheckpointerSchema, checkpointerRaw, CHECKPOINTER_FILE)
    : null;

  const runEntries = Object.entries(ops?.runs ?? {});
  const items: [string, Item][] = [];
  if (storeFile?.data) {
    for (const namespaceItems of storeFile.data.values()) {
      for (const stored of namespaceItems.values()) {
        const item: Item = {
          namespace: stored.namespace,
          key: stored.key,
          value: stored.value,
          createdAt: toIso(stored.createdAt, now),
          updatedAt: toIso(stored.updatedAt, now),
        };
        items.push([JSON.stringify([stored.namespace, stored.key]), item]);
      }
    }
  }

  const store: SkeinStoreSnapshot = {
    assistants: Object.entries(ops?.assistants ?? {}).map(([id, row]) => [
      id,
      toAssistant(row, now),
    ]),
    assistantVersions: (ops?.assistant_versions ?? []).map((row) => [
      JSON.stringify([row.assistant_id, row.version]),
      toAssistantVersion(row, now),
    ]),
    threads: Object.entries(ops?.threads ?? {}).map(([id, row]) => [id, toThread(row, now)]),
    runs: runEntries.map(([id, row]) => [id, toRun(row, now)]),
    runKwargs: runEntries.map(([id, row]) => [id, toRunKwargs(row.kwargs)]),
    items,
  };

  let checkpoints: CheckpointerSnapshot = { storage: {}, writes: {} };
  if (checkpointerFile) {
    // The decoded `{ storage, writes }` are already `MemorySaver`'s runtime maps (Uint8Array
    // blobs), so we borrow a saver and reuse skein's own base64 snapshotter — no new format code.
    const saver = new MemorySaver();
    saver.storage = checkpointerFile.storage as MemorySaver["storage"];
    saver.writes = checkpointerFile.writes as MemorySaver["writes"];
    checkpoints = snapshotCheckpointer(saver);
  }

  return { version: 1, store, checkpoints };
}

/** Row/checkpoint counts in a snapshot, for CLI + log summaries. */
export interface DevStateCounts {
  assistants: number;
  threads: number;
  runs: number;
  items: number;
  /** Threads that carry graph checkpoint history. */
  checkpointedThreads: number;
}

export function describeSnapshot(snapshot: DevStateSnapshot): DevStateCounts {
  return {
    assistants: snapshot.store.assistants.length,
    threads: snapshot.store.threads.length,
    runs: snapshot.store.runs.length,
    items: snapshot.store.items.length,
    checkpointedThreads: Object.keys(snapshot.checkpoints.storage).length,
  };
}

/** A store that can bulk-load a snapshot verbatim, preserving ids + timestamps (see `restore` on
 * the memory + Postgres drivers). Import targets must support this; it's the lossless sink. */
interface BulkRestorable {
  restore(snapshot: SkeinStoreSnapshot): Promise<void>;
}

function supportsRestore(store: SkeinStore): store is SkeinStore & BulkRestorable {
  return typeof (store as Partial<BulkRestorable>).restore === "function";
}

/** Copy every checkpoint tuple from `snapshot` into `target` via the public checkpointer API,
 * so it works against any `BaseCheckpointSaver` (e.g. `PostgresSaver`), not just a `MemorySaver`. */
async function copyCheckpoints(
  snapshot: CheckpointerSnapshot,
  target: BaseCheckpointSaver,
): Promise<void> {
  const source = new MemorySaver();
  hydrateCheckpointer(source, snapshot);

  // Oldest-first, so a parent checkpoint is always written before the child that points at it.
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of source.list({})) tuples.push(tuple);
  tuples.reverse();

  for (const tuple of tuples) {
    const configurable = tuple.config.configurable ?? {};
    const putConfig = {
      configurable: {
        thread_id: configurable.thread_id,
        checkpoint_ns: configurable.checkpoint_ns ?? "",
        // `put` reads `checkpoint_id` as the PARENT pointer; the child's own id is `checkpoint.id`.
        checkpoint_id: tuple.parentConfig?.configurable?.checkpoint_id,
      },
    };
    const stored = await target.put(
      putConfig,
      tuple.checkpoint,
      (tuple.metadata ?? {}) as CheckpointMetadata,
      tuple.checkpoint.channel_versions ?? {},
    );

    const writesByTask = new Map<string, [string, unknown][]>();
    for (const [taskId, channel, value] of tuple.pendingWrites ?? []) {
      const writes = writesByTask.get(taskId) ?? [];
      writes.push([channel, value]);
      writesByTask.set(taskId, writes);
    }
    for (const [taskId, writes] of writesByTask) {
      await target.putWrites(stored, writes, taskId);
    }
  }
}

/**
 * Load a `DevStateSnapshot` into a live store + checkpointer — the sink for importing into a real
 * skein deployment (e.g. Postgres). Resource rows go through the driver's `restore` (ids +
 * timestamps preserved, `ON CONFLICT DO NOTHING` so re-runs are safe); checkpoints — graph state +
 * full history — are copied via the public checkpointer API. Throws if the store can't bulk-restore
 * (both first-party drivers can); a custom driver must implement `restore` to be an import target.
 */
export async function loadSnapshotIntoStore(
  snapshot: DevStateSnapshot,
  store: SkeinStore,
  checkpointer: BaseCheckpointSaver,
): Promise<void> {
  if (!supportsRestore(store)) {
    throw new Error(
      "Target store does not support bulk import (no restore() method). " +
        "Use the in-memory or Postgres driver, or implement restore() on your SkeinStore.",
    );
  }
  await store.restore(snapshot.store);
  await copyCheckpoints(snapshot.checkpoints, checkpointer);
}
