// The transport-neutral handler table. Each handler validates the raw request, calls the typed
// service, and returns a `ProtocolResponse` a framework adapter serializes. Routes/shapes follow
// the `@langchain/langgraph-sdk` client (the conformance oracle): /assistants, /threads, /runs,
// /store. SSE responses carry a pre-serialized event iterable (data frames + a synthesized
// terminal event read from the run's final status).

import {
  isTerminalRunStatus,
  RUN_STATUSES,
  SkeinHttpError,
  type RunFrame,
  type RunStatus,
} from "@skein-js/core";

import type { CancelRunOptions, CreateRunInput } from "./runs/run-service.js";
import type { ProtocolService } from "./service.js";
import { parseAfterSeq, toSseEvents } from "./sse/sse.js";
import type { CommandInput, ThreadStreamInput } from "./threads/thread-stream-service.js";
import { parse, requireParam } from "./validation/parse.js";
import {
  assistantCountSchema,
  assistantCreateSchema,
  assistantSearchSchema,
  assistantSetLatestSchema,
  assistantUpdateSchema,
  assistantVersionsSchema,
  cancelManySchema,
  commandBodySchema,
  cronCountSchema,
  cronCreateSchema,
  cronSearchSchema,
  cronUpdateSchema,
  listNamespacesSchema,
  runBatchCreateSchema,
  runCreateSchema,
  storePutSchema,
  storeSearchSchema,
  threadCreateSchema,
  threadPatchSchema,
  threadHistorySchema,
  threadCountSchema,
  threadPruneSchema,
  threadSearchSchema,
  threadStateCheckpointSchema,
  threadStateUpdateSchema,
  threadStreamSchema,
} from "./validation/schemas.js";

/** A normalized request an adapter maps its framework request onto. */
export interface ProtocolRequest {
  /** HTTP method (e.g. `"POST"`), used to synthesize the WHATWG `Request` an auth handler receives. */
  method: string;
  /** Absolute request URL, so a synthesized `Request` carries the path + query an auth handler reads. */
  url: string;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
  headers: Record<string, string | undefined>;
  /**
   * Aborts when the client goes away, so a handler can stop work the caller will never read.
   * Optional: an adapter that can't observe disconnects simply omits it. Currently honored by the
   * single-graph invoke surface; protocol runs carry their own cancellation through the run row.
   */
  signal?: AbortSignal;
}

/** A normalized response an adapter serializes back onto its framework response. */
export type ProtocolResponse =
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "empty"; status: number; headers?: Record<string, string> }
  | {
      kind: "sse";
      status: number;
      events: AsyncIterable<string>;
      headers?: Record<string, string>;
    };

export type ProtocolHandler = (req: ProtocolRequest) => Promise<ProtocolResponse>;

export interface ProtocolHandlers {
  // assistants
  getAssistant: ProtocolHandler;
  searchAssistants: ProtocolHandler;
  countAssistants: ProtocolHandler;
  getAssistantSchemas: ProtocolHandler;
  createAssistant: ProtocolHandler;
  updateAssistant: ProtocolHandler;
  deleteAssistant: ProtocolHandler;
  listAssistantVersions: ProtocolHandler;
  setAssistantLatestVersion: ProtocolHandler;
  getAssistantGraph: ProtocolHandler;
  getAssistantSubgraphs: ProtocolHandler;
  // threads
  createThread: ProtocolHandler;
  getThread: ProtocolHandler;
  listThreads: ProtocolHandler;
  countThreads: ProtocolHandler;
  pruneThreads: ProtocolHandler;
  copyThread: ProtocolHandler;
  patchThread: ProtocolHandler;
  deleteThread: ProtocolHandler;
  getThreadHistory: ProtocolHandler;
  getThreadState: ProtocolHandler;
  getThreadStateAtCheckpoint: ProtocolHandler;
  getThreadStateAtCheckpointFromBody: ProtocolHandler;
  updateThreadState: ProtocolHandler;
  // runs
  createWaitRun: ProtocolHandler;
  createStreamRun: ProtocolHandler;
  createBackgroundRun: ProtocolHandler;
  createStatelessRun: ProtocolHandler;
  createRunBatch: ProtocolHandler;
  getRun: ProtocolHandler;
  listThreadRuns: ProtocolHandler;
  joinRunStream: ProtocolHandler;
  joinRun: ProtocolHandler;
  cancelRun: ProtocolHandler;
  cancelManyRuns: ProtocolHandler;
  deleteRun: ProtocolHandler;
  // crons
  createCron: ProtocolHandler;
  getCron: ProtocolHandler;
  searchCrons: ProtocolHandler;
  countCrons: ProtocolHandler;
  updateCron: ProtocolHandler;
  deleteCron: ProtocolHandler;
  // thread streaming / commands
  postThreadStream: ProtocolHandler;
  getThreadStream: ProtocolHandler;
  postThreadCommands: ProtocolHandler;
  // meta
  getServerInfo: ProtocolHandler;
  // store
  putStoreItem: ProtocolHandler;
  getStoreItem: ProtocolHandler;
  deleteStoreItem: ProtocolHandler;
  searchStoreItems: ProtocolHandler;
  listStoreNamespaces: ProtocolHandler;
}

const json = (body: unknown, status = 200, headers?: Record<string, string>): ProtocolResponse => ({
  kind: "json",
  status,
  body,
  headers,
});
const empty = (status = 204): ProtocolResponse => ({ kind: "empty", status });

/** A single query value: the first entry if repeated, else the string, else undefined. */
function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Ceiling on any integer read from the query string. Matches the cap the request *body* schemas apply
 * to a `limit`, so the two ways of asking for a page size agree.
 */
const MAX_QUERY_INT = 1000;

/**
 * Default page for the two collections that had no bound at all: `GET /threads/{id}/runs` and
 * `POST /store/namespaces`.
 *
 * 100, matching what the LangGraph SDK itself sends for `store.listNamespaces` (`limit ?? 100`), so a
 * caller that omits the parameter gets the same page from skein as from Platform. Smaller than
 * `MAX_QUERY_INT`/`SKEIN_MAX_PAGE_SIZE` on purpose: a run row carries its error and metadata, so a
 * page of them is heavier than a page of ids, and both endpoints previously returned *everything*.
 * A caller wanting more asks for more, up to the 1000 ceiling every other collection shares.
 */
const DEFAULT_COLLECTION_PAGE_SIZE = 100;

/** Parse a namespace query param: repeated values, or a single dot-separated string. */
function namespaceFromQuery(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return value.split(".");
  return [];
}

/**
 * A positive-integer query param, bounded by {@link MAX_QUERY_INT}.
 *
 * Bounded rather than rejected: these are all "how much do you want" params, and a caller asking for
 * more than the ceiling wants as much as it can get. An *unbounded* value is the problem — it used to
 * mean `?limit=1000000` was accepted verbatim.
 */
function positiveIntQuery(value: string | string[] | undefined): number | undefined {
  const raw = queryValue(value);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, MAX_QUERY_INT);
}

/** Coerce a `?flag=true|false` query param to a boolean (anything else → undefined). */
function booleanQuery(value: string | string[] | undefined): boolean | undefined {
  const raw = queryValue(value);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/** `?xray` is `boolean | number` (a depth bound) — try boolean first, then a positive integer. */
function xrayQuery(value: string | string[] | undefined): number | boolean | undefined {
  return booleanQuery(value) ?? positiveIntQuery(value);
}

/**
 * `?status=` on `GET /threads/{id}/runs`. Ignored rather than rejected when it is not a run status —
 * this is a query string, which every other filter in this table absorbs rather than 400s on, and the
 * SDK sends the field on calls that do not mean to filter.
 */
function runStatusQuery(value: string | string[] | undefined): RunStatus | undefined {
  const raw = queryValue(value);
  return raw !== undefined && (RUN_STATUSES as readonly string[]).includes(raw)
    ? (raw as RunStatus)
    : undefined;
}

/**
 * `?action=` and `?wait=` on the two cancel endpoints — both sent by every `client.runs.cancel(...)`
 * call. An unrecognized `action` falls back to `interrupt`, its default and the safer of the two: it
 * keeps the run's writes, where a mistyped value silently discarding them would be unrecoverable.
 */
function cancelOptionsFrom(req: ProtocolRequest): CancelRunOptions {
  const action = queryValue(req.query["action"]);
  return {
    action: action === "rollback" ? "rollback" : "interrupt",
    // `wait=1` is what the SDK sends (not `true`), so both spellings are accepted.
    wait: booleanQuery(req.query["wait"]) ?? queryValue(req.query["wait"]) === "1",
  };
}

/**
 * Normalize `before` to the config `getStateHistory` expects. The SDK sends a config; a hand-rolled
 * caller is more likely to send the bare checkpoint id, so accept both — and forward *only* the id, so
 * the thread scope stays server-owned.
 */
function historyBefore(before: string | { configurable: { checkpoint_id: string } }): {
  configurable: { checkpoint_id: string };
} {
  const checkpointId = typeof before === "string" ? before : before.configurable.checkpoint_id;
  return { configurable: { checkpoint_id: checkpointId } };
}

/**
 * `Content-Location` for a created run — the header the SDK parses (`getRunMetadataFromResponse`) to
 * fire `onRunCreated`, which is how `useStream` learns the run id it stores to rejoin a stream after a
 * remount. Without it that callback never fires and `reconnectOnMount` cannot work.
 *
 * The thread-scoped spelling always, even for a stateless run: the SDK's own regex makes the
 * `/threads/{id}` prefix optional and reports `thread_id: undefined` when it is missing, so naming the
 * server-created thread is strictly more useful to a client that wants to follow the run.
 */
function runLocationHeaders(threadId: string, runId: string): Record<string, string> {
  return { "content-location": `/threads/${threadId}/runs/${runId}` };
}

export function createProtocolHandlers(service: ProtocolService): ProtocolHandlers {
  // Build an SSE response whose terminal event reflects the run's final status once frames end.
  const sse = (
    started: {
      runId: string;
      frames: AsyncIterable<RunFrame>;
      finalStatus?: () => Promise<RunStatus | null>;
    },
    headers?: Record<string, string>,
  ): ProtocolResponse => ({
    kind: "sse",
    status: 200,
    // The started run's own resolver when it has one (exact, read from the execution outcome), else the
    // run row. See `StartedStream.finalStatus` for why the row is not good enough on its own.
    events: toSseEvents(
      started.frames,
      started.finalStatus ?? (() => service.runs.finalStatus(started.runId)),
    ),
    ...(headers ? { headers } : {}),
  });

  const afterSeqFrom = (req: ProtocolRequest): number =>
    parseAfterSeq(req.headers["last-event-id"]);

  return {
    // --- assistants ---------------------------------------------------------------------------
    getAssistant: async (req) =>
      json(await service.assistants.get(requireParam(req.params, "assistant_id"))),

    searchAssistants: async (req) => {
      const body = parse(assistantSearchSchema, req.body ?? {});
      const query = {
        graph_id: body.graph_id,
        name: body.name,
        metadata: body.metadata,
        limit: body.limit,
        offset: body.offset,
        sortBy: body.sort_by,
        sortOrder: body.sort_order,
      };
      const [assistants, total] = await Promise.all([
        service.assistants.search(query),
        service.assistants.count(query),
      ]);
      return json(assistants, 200, { "x-pagination-total": String(total) });
    },

    countAssistants: async (req) => {
      const body = parse(assistantCountSchema, req.body ?? {});
      return json(
        await service.assistants.count({
          graph_id: body.graph_id,
          name: body.name,
          metadata: body.metadata,
        }),
      );
    },

    getAssistantSchemas: async (req) =>
      json(await service.assistants.schemas(requireParam(req.params, "assistant_id"))),

    createAssistant: async (req) => {
      const body = parse(assistantCreateSchema, req.body);
      return json(
        await service.assistants.create({
          graph_id: body.graph_id,
          assistant_id: body.assistant_id,
          name: body.name,
          description: body.description,
          config: body.config,
          context: body.context,
          metadata: body.metadata,
          ifExists: body.if_exists,
        }),
      );
    },

    updateAssistant: async (req) =>
      json(
        await service.assistants.update(
          requireParam(req.params, "assistant_id"),
          parse(assistantUpdateSchema, req.body ?? {}),
        ),
      ),

    deleteAssistant: async (req) => {
      await service.assistants.delete(requireParam(req.params, "assistant_id"), {
        deleteThreads: booleanQuery(req.query["delete_threads"]) ?? false,
      });
      return empty();
    },

    listAssistantVersions: async (req) => {
      const body = parse(assistantVersionsSchema, req.body ?? {});
      return json(
        await service.assistants.listVersions(requireParam(req.params, "assistant_id"), {
          metadata: body.metadata,
          limit: body.limit,
          offset: body.offset,
        }),
      );
    },

    setAssistantLatestVersion: async (req) => {
      const body = parse(assistantSetLatestSchema, req.body);
      return json(
        await service.assistants.setLatest(requireParam(req.params, "assistant_id"), body.version),
      );
    },

    getAssistantGraph: async (req) =>
      json(
        await service.assistants.drawGraph(requireParam(req.params, "assistant_id"), {
          xray: xrayQuery(req.query["xray"]),
        }),
      ),

    getAssistantSubgraphs: async (req) =>
      json(
        await service.assistants.subgraphs(requireParam(req.params, "assistant_id"), {
          namespace: queryValue(req.query["namespace"]) ?? req.params["namespace"],
          recurse: booleanQuery(req.query["recurse"]) ?? false,
        }),
      ),

    // --- threads ------------------------------------------------------------------------------
    createThread: async (req) =>
      json(await service.threads.create(parse(threadCreateSchema, req.body ?? {}))),

    getThread: async (req) =>
      json(await service.threads.get(requireParam(req.params, "thread_id"))),

    listThreads: async (req) => {
      const body = parse(threadSearchSchema, req.body ?? {});
      return json(
        await service.threads.search({
          metadata: body.metadata,
          values: body.values,
          status: body.status,
          ids: body.ids,
          limit: body.limit,
          offset: body.offset,
          sortBy: body.sort_by,
          sortOrder: body.sort_order,
        }),
      );
    },

    countThreads: async (req) => {
      const body = parse(threadCountSchema, req.body ?? {});
      return json(
        await service.threads.count({
          metadata: body.metadata,
          values: body.values,
          status: body.status,
          ids: body.ids,
        }),
      );
    },

    pruneThreads: async (req) => {
      const body = parse(threadPruneSchema, req.body);
      return json(
        await service.threads.prune({
          threadIds: body.thread_ids,
          ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
        }),
      );
    },

    copyThread: async (req) =>
      json(await service.threads.copy(requireParam(req.params, "thread_id"))),

    patchThread: async (req) =>
      json(
        await service.threads.patch(
          requireParam(req.params, "thread_id"),
          parse(threadPatchSchema, req.body ?? {}),
        ),
      ),

    deleteThread: async (req) => {
      await service.threads.delete(requireParam(req.params, "thread_id"));
      return empty();
    },

    getThreadHistory: async (req) => {
      // The SDK sends every option in the body; `?limit=` is kept as a fallback for hand-rolled callers
      // that reach for a query param on a POST. It is *clamped* rather than rejected, unlike the body's
      // limit — a query string has no schema to 400 from.
      const body = parse(threadHistorySchema, req.body ?? {}) ?? {};
      const limit = body.limit ?? positiveIntQuery(req.query["limit"]);
      return json(
        await service.threads.history(requireParam(req.params, "thread_id"), {
          ...(limit !== undefined ? { limit } : {}),
          ...(body.before ? { before: historyBefore(body.before) } : {}),
          ...(body.metadata ? { filter: body.metadata } : {}),
        }),
      );
    },

    getThreadState: async (req) =>
      json(await service.threads.getState(requireParam(req.params, "thread_id"))),

    getThreadStateAtCheckpoint: async (req) =>
      json(
        await service.threads.getStateAt(
          requireParam(req.params, "thread_id"),
          requireParam(req.params, "checkpoint_id"),
        ),
      ),

    // The object-shaped sibling of the route above, and the only one that can address a **subgraph**:
    // the pointer's `checkpoint_ns` is forwarded, which is the whole reason the SDK routes an object
    // checkpoint here instead of to the id-shaped GET. An absent pointer (or one carrying no
    // `checkpoint_id`) reads the thread tip rather than 404ing, matching `@langchain/langgraph-api`,
    // which spreads the checkpoint into `configurable` and lets the checkpointer resolve it.
    getThreadStateAtCheckpointFromBody: async (req) => {
      const threadId = requireParam(req.params, "thread_id");
      const body = parse(threadStateCheckpointSchema, req.body ?? {});
      const checkpointId = body.checkpoint?.checkpoint_id;
      return json(
        checkpointId !== undefined
          ? await service.threads.getStateAt(
              threadId,
              checkpointId,
              body.checkpoint?.checkpoint_ns ?? undefined,
            )
          : await service.threads.getState(threadId),
      );
    },

    updateThreadState: async (req) => {
      const body = parse(threadStateUpdateSchema, req.body ?? {});
      return json(
        await service.threads.updateState(requireParam(req.params, "thread_id"), {
          values: body.values,
          as_node: body.as_node,
          checkpoint_id: body.checkpoint_id,
          checkpoint: body.checkpoint ?? undefined,
        }),
      );
    },

    // --- runs ---------------------------------------------------------------------------------
    createWaitRun: async (req) => {
      const { runId, threadId, result } = await service.runs.createWait(
        parse(runCreateSchema, req.body) as CreateRunInput,
      );
      return json(result, 200, runLocationHeaders(threadId, runId));
    },

    createStreamRun: async (req) => {
      const started = await service.runs.createStream(
        parse(runCreateSchema, req.body) as CreateRunInput,
      );
      return sse(started, runLocationHeaders(started.threadId, started.runId));
    },

    createBackgroundRun: async (req) => {
      const run = await service.runs.createBackground(
        requireParam(req.params, "thread_id"),
        parse(runCreateSchema, req.body) as CreateRunInput,
      );
      return json(run, 200, runLocationHeaders(run.thread_id, run.run_id));
    },

    createStatelessRun: async (req) => {
      const run = await service.runs.createStatelessBackground(
        parse(runCreateSchema, req.body) as CreateRunInput,
      );
      return json(run, 200, runLocationHeaders(run.thread_id, run.run_id));
    },

    createRunBatch: async (req) =>
      // No `Content-Location`: it names one run, and this response carries many. The runs themselves
      // are in the body, each with its `run_id` and `thread_id`.
      json(
        await service.runs.createBatch(parse(runBatchCreateSchema, req.body) as CreateRunInput[]),
      ),

    getRun: async (req) => json(await service.runs.get(requireParam(req.params, "run_id"))),

    listThreadRuns: async (req) => {
      // `positiveIntQuery`, not a Zod schema: this is a GET, and every other query-string limit in this
      // table clamps rather than 400s — see its docstring. A schema here would make the one paginated
      // GET in the protocol reject `?limit=5000` and `?offset=-1` where its siblings absorb them.
      const limit = positiveIntQuery(req.query["limit"]) ?? DEFAULT_COLLECTION_PAGE_SIZE;
      const offset = positiveIntQuery(req.query["offset"]);
      const status = runStatusQuery(req.query["status"]);
      return json(
        await service.runs.listByThread(requireParam(req.params, "thread_id"), {
          limit,
          ...(offset !== undefined ? { offset } : {}),
          ...(status !== undefined ? { status } : {}),
        }),
      );
    },

    joinRunStream: async (req) => {
      const runId = requireParam(req.params, "run_id");
      const frames = await service.runs.join(runId, afterSeqFrom(req));
      return sse({ runId, frames });
    },

    /**
     * Block until the run settles, then answer its final state as JSON — the SDK's `runs.join()`,
     * where `joinRunStream` above is `runs.joinStream()`.
     *
     * The terminal check before subscribing is load-bearing, not an optimization. Both event buses
     * remember a closed run for 24h and then forget it (`MemoryRunEventBus`'s `finishedIdTtlMs`, the
     * Redis driver's closed marker); past that window `subscribe` treats the id as a run that has not
     * started yet and **waits forever**. The run row has no such expiry, so it — not the bus — decides
     * whether there is anything left to wait for.
     *
     * `?cancel_on_disconnect` is accepted and ignored: honouring it needs a transport-level disconnect
     * signal, which a JSON `ProtocolResponse` (unlike the SSE ones) never sees. `@langchain/langgraph-api`
     * does not read it on this route either.
     */
    joinRun: async (req) => {
      const runId = requireParam(req.params, "run_id");
      const run = await service.runs.get(runId); // 404s when absent or not this caller's
      if (!isTerminalRunStatus(run.status)) {
        const frames = await service.runs.join(runId, 0);
        for await (const _frame of frames) {
          // Drain rather than forward: this route reports the outcome, not the transcript. The bus
          // closes when the run settles, which is what makes this the "block until done" wait.
        }
      }
      // Re-read for the settled row: the status above is stale by now for a run we just waited on.
      // `runs.get` *throws* on absence, and the row can legitimately be gone by the time we wake —
      // `cancel?action=rollback` deletes it, as does `on_completion: "delete"` cascading the thread.
      // The caller waited successfully, so that must answer with state, not the 404 the throw would
      // otherwise produce.
      const settled = await service.runs.get(runId).catch((error: unknown) => {
        if (error instanceof SkeinHttpError && error.status === 404) return undefined;
        throw error;
      });
      // A failed run must not read as an empty success — same `__error__` envelope `createWait` uses.
      // `error` is optional on the row, so fall back to the status rather than emitting a bare `{}`.
      if (settled && (settled.status === "error" || settled.status === "timeout")) {
        return json({
          __error__: settled.error ?? {
            message: `Run "${runId}" finished with status "${settled.status}".`,
          },
        });
      }
      return json((await service.threads.getState(run.thread_id)).values);
    },

    cancelRun: async (req) =>
      json(await service.runs.cancel(requireParam(req.params, "run_id"), cancelOptionsFrom(req))),

    cancelManyRuns: async (req) => {
      const body = parse(cancelManySchema, req.body ?? {});
      const { cancelledRunIds, truncated } = await service.runs.cancelMany({
        threadId: body.thread_id,
        runIds: body.run_ids,
        status: body.status,
        ...cancelOptionsFrom(req),
      });
      // The SDK types `cancelMany` as `Promise<void>` and ignores the body, so its shape is skein's to
      // choose. It reports what happened rather than nothing: a bounded sweep that left runs going has
      // to be visible to a caller that asked to cancel everything. `truncated` is a fact about the
      // caller's own page — never a count of what other principals are running.
      return json({
        cancelled_count: cancelledRunIds.length,
        cancelled_run_ids: cancelledRunIds,
        truncated,
      });
    },

    deleteRun: async (req) => {
      await service.runs.delete(requireParam(req.params, "run_id"));
      return empty();
    },

    // --- crons --------------------------------------------------------------------------------
    // One handler for both create routes: the thread-scoped path folds `thread_id` into the body
    // (`foldThreadIdIntoBody`), exactly as the thread-scoped wait/stream runs do.
    createCron: async (req) => {
      const body = parse(cronCreateSchema, req.body ?? {});
      return json(await service.crons.create(body));
    },

    getCron: async (req) => json(await service.crons.get(requireParam(req.params, "cron_id"))),

    searchCrons: async (req) => {
      const body = parse(cronSearchSchema, req.body ?? {});
      // Paired with a total, like assistants and threads — the SDK ignores the header, but a client
      // paging a cron list has no other way to know how far it goes.
      const [crons, total] = await Promise.all([
        service.crons.search(body),
        service.crons.count(body),
      ]);
      return json(crons, 200, { "x-pagination-total": String(total) });
    },

    // Answers a **bare integer**, not `{ count }` — matching the OpenAPI spec and what the SDK's
    // `crons.count()` reads.
    countCrons: async (req) =>
      json(await service.crons.count(parse(cronCountSchema, req.body ?? {}))),

    updateCron: async (req) => {
      const body = parse(cronUpdateSchema, req.body ?? {});
      return json(await service.crons.update(requireParam(req.params, "cron_id"), body));
    },

    // 200 with a JSON body, not 204 — and the body matters. The SDK's `BaseClient` skips
    // `response.json()` only for 202 and 204, so a 200 with an empty body makes the official client
    // throw `SyntaxError: Unexpected end of JSON input` on a request that actually succeeded.
    // `serializeWireJson(null)` is `"null"`, which parses.
    deleteCron: async (req) => {
      await service.crons.delete(requireParam(req.params, "cron_id"));
      return json(null);
    },

    // --- thread streaming / commands ----------------------------------------------------------
    postThreadStream: async (req) => {
      const started = await service.threadStream.stream(
        requireParam(req.params, "thread_id"),
        parse(threadStreamSchema, req.body) as ThreadStreamInput,
      );
      return sse(started, runLocationHeaders(started.threadId, started.runId));
    },

    getThreadStream: async (req) => {
      const started = await service.threadStream.joinStream(
        requireParam(req.params, "thread_id"),
        afterSeqFrom(req),
      );
      return sse(started, runLocationHeaders(started.threadId, started.runId));
    },

    postThreadCommands: async (req) => {
      const started = await service.threadStream.command(
        requireParam(req.params, "thread_id"),
        parse(commandBodySchema, req.body ?? {}) as CommandInput,
      );
      return sse(started, runLocationHeaders(started.threadId, started.runId));
    },

    // --- meta ---------------------------------------------------------------------------------
    getServerInfo: async () => json(await service.meta.info()),

    // --- store --------------------------------------------------------------------------------
    putStoreItem: async (req) => {
      const body = parse(storePutSchema, req.body);
      return json(await service.store.put(body.namespace, body.key, body.value, { ttl: body.ttl }));
    },

    getStoreItem: async (req) => {
      const namespace = namespaceFromQuery(req.query["namespace"]);
      const key = queryValue(req.query["key"]) ?? "";
      return json(await service.store.get(namespace, key));
    },

    deleteStoreItem: async (req) => {
      const namespace = namespaceFromQuery(req.query["namespace"]);
      const key = queryValue(req.query["key"]) ?? "";
      await service.store.delete(namespace, key);
      return empty();
    },

    searchStoreItems: async (req) => {
      const body = parse(storeSearchSchema, req.body ?? {});
      return json(
        await service.store.search({
          prefix: body.namespace_prefix,
          query: body.query,
          limit: body.limit,
          offset: body.offset,
        }),
      );
    },

    listStoreNamespaces: async (req) => {
      const body = parse(listNamespacesSchema, req.body ?? {});
      return json(
        await service.store.listNamespaces(body.prefix, {
          limit: body.limit ?? DEFAULT_COLLECTION_PAGE_SIZE,
          ...(body.offset !== undefined ? { offset: body.offset } : {}),
        }),
      );
    },
  };
}
