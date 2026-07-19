// The transport-neutral handler table. Each handler validates the raw request, calls the typed
// service, and returns a `ProtocolResponse` a framework adapter serializes. Routes/shapes follow
// the `@langchain/langgraph-sdk` client (the conformance oracle): /assistants, /threads, /runs,
// /store. SSE responses carry a pre-serialized event iterable (data frames + a synthesized
// terminal event read from the run's final status).

import type { RunFrame } from "@skein-js/core";

import type { CreateRunInput } from "./runs/run-service.js";
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
  commandBodySchema,
  listNamespacesSchema,
  runCreateSchema,
  storePutSchema,
  storeSearchSchema,
  threadCreateSchema,
  threadPatchSchema,
  threadSearchSchema,
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
}

/** A normalized response an adapter serializes back onto its framework response. */
export type ProtocolResponse =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "empty"; status: number }
  | { kind: "sse"; status: number; events: AsyncIterable<string> };

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
  copyThread: ProtocolHandler;
  patchThread: ProtocolHandler;
  deleteThread: ProtocolHandler;
  getThreadHistory: ProtocolHandler;
  getThreadState: ProtocolHandler;
  getThreadStateAtCheckpoint: ProtocolHandler;
  updateThreadState: ProtocolHandler;
  // runs
  createWaitRun: ProtocolHandler;
  createStreamRun: ProtocolHandler;
  createBackgroundRun: ProtocolHandler;
  getRun: ProtocolHandler;
  listThreadRuns: ProtocolHandler;
  joinRunStream: ProtocolHandler;
  cancelRun: ProtocolHandler;
  deleteRun: ProtocolHandler;
  // thread streaming / commands
  postThreadStream: ProtocolHandler;
  getThreadStream: ProtocolHandler;
  postThreadCommands: ProtocolHandler;
  // store
  putStoreItem: ProtocolHandler;
  getStoreItem: ProtocolHandler;
  deleteStoreItem: ProtocolHandler;
  searchStoreItems: ProtocolHandler;
  listStoreNamespaces: ProtocolHandler;
}

const json = (body: unknown, status = 200): ProtocolResponse => ({ kind: "json", status, body });
const empty = (status = 204): ProtocolResponse => ({ kind: "empty", status });

/** A single query value: the first entry if repeated, else the string, else undefined. */
function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Parse a namespace query param: repeated values, or a single dot-separated string. */
function namespaceFromQuery(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return value.split(".");
  return [];
}

function positiveIntQuery(value: string | string[] | undefined): number | undefined {
  const raw = queryValue(value);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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

export function createProtocolHandlers(service: ProtocolService): ProtocolHandlers {
  // Build an SSE response whose terminal event reflects the run's final status once frames end.
  const sse = (runId: string, frames: AsyncIterable<RunFrame>): ProtocolResponse => ({
    kind: "sse",
    status: 200,
    events: toSseEvents(frames, () => service.runs.finalStatus(runId)),
  });

  const afterSeqFrom = (req: ProtocolRequest): number =>
    parseAfterSeq(req.headers["last-event-id"]);

  return {
    // --- assistants ---------------------------------------------------------------------------
    getAssistant: async (req) =>
      json(await service.assistants.get(requireParam(req.params, "assistant_id"))),

    searchAssistants: async (req) => {
      const body = parse(assistantSearchSchema, req.body ?? {});
      return json(
        await service.assistants.search({
          graph_id: body.graph_id,
          name: body.name,
          metadata: body.metadata,
          limit: body.limit,
          offset: body.offset,
          sortBy: body.sort_by,
          sortOrder: body.sort_order,
        }),
      );
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
      const limit = positiveIntQuery(req.query["limit"]);
      const options = limit === undefined ? undefined : { limit };
      return json(await service.threads.history(requireParam(req.params, "thread_id"), options));
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
    createWaitRun: async (req) =>
      json(await service.runs.createWait(parse(runCreateSchema, req.body) as CreateRunInput)),

    createStreamRun: async (req) => {
      const started = await service.runs.createStream(
        parse(runCreateSchema, req.body) as CreateRunInput,
      );
      return sse(started.runId, started.frames);
    },

    createBackgroundRun: async (req) =>
      json(
        await service.runs.createBackground(
          requireParam(req.params, "thread_id"),
          parse(runCreateSchema, req.body) as CreateRunInput,
        ),
      ),

    getRun: async (req) => json(await service.runs.get(requireParam(req.params, "run_id"))),

    listThreadRuns: async (req) =>
      json(await service.runs.listByThread(requireParam(req.params, "thread_id"))),

    joinRunStream: async (req) => {
      const runId = requireParam(req.params, "run_id");
      const frames = await service.runs.join(runId, afterSeqFrom(req));
      return sse(runId, frames);
    },

    cancelRun: async (req) => json(await service.runs.cancel(requireParam(req.params, "run_id"))),

    deleteRun: async (req) => {
      await service.runs.delete(requireParam(req.params, "run_id"));
      return empty();
    },

    // --- thread streaming / commands ----------------------------------------------------------
    postThreadStream: async (req) => {
      const started = await service.threadStream.stream(
        requireParam(req.params, "thread_id"),
        parse(threadStreamSchema, req.body) as ThreadStreamInput,
      );
      return sse(started.runId, started.frames);
    },

    getThreadStream: async (req) => {
      const started = await service.threadStream.joinStream(
        requireParam(req.params, "thread_id"),
        afterSeqFrom(req),
      );
      return sse(started.runId, started.frames);
    },

    postThreadCommands: async (req) => {
      const started = await service.threadStream.command(
        requireParam(req.params, "thread_id"),
        parse(commandBodySchema, req.body ?? {}) as CommandInput,
      );
      return sse(started.runId, started.frames);
    },

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
      return json(await service.store.listNamespaces(body.prefix));
    },
  };
}
