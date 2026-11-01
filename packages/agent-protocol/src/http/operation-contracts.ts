// Internal operation contracts are consumed by handlers and OpenAPI, never exported as a plugin API.
import { z, type ZodTypeAny } from "zod";

import type { ProtocolHandlers, ProtocolResponse } from "../create-handlers.js";
import * as wire from "../meta/response-schemas.js";
import {
  threadEventFilterSchema,
  threadCommandEnvelopeSchema,
} from "../threads/thread-protocol-service.js";
import * as schemas from "../validation/schemas.js";

import * as query from "./query-schemas.js";

const opaqueObject = z.object({}).passthrough();
// Store reads and deletes accept either a body target or query parameters. Invalid body fields
// retain their established fallback-to-query behavior; the resolved target is still required.
const storeTargetBody = z
  .object({
    namespace: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .catch(undefined),
    key: z.string().optional().catch(undefined),
  })
  .passthrough();
const replayHeaders = z.object({ "last-event-id": z.string().optional() });
const delivery = z.object({
  delivery_id: z.string(),
  run_id: z.string(),
  thread_id: z.string(),
  url: z.string(),
  payload: z.unknown(),
  payload_truncated: z.boolean(),
  run_status: wire.run.shape.status,
  status: z.enum(["pending", "delivering", "delivered", "dead"]),
  attempt: z.number(),
  next_attempt_at: z.string(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
});
interface OperationContract {
  /** The provider/official SDK owns the wire response, including its status. */
  external?: boolean;
  query?: z.AnyZodObject;
  headers?: z.AnyZodObject;
  body?: ZodTypeAny;
  response: ZodTypeAny;
  kind: "json" | "empty" | "sse" | "mixed";
  status: number;
}
function createJsonContract<R extends ZodTypeAny, B extends ZodTypeAny | undefined = undefined>(
  response: R,
  body?: B,
) {
  return { response, body: body as B, kind: "json" as const, status: 200 as const };
}
function createStreamContract<B extends ZodTypeAny | undefined = undefined>(body?: B) {
  return { response: z.string(), body: body as B, kind: "sse" as const, status: 200 as const };
}
const emptyContract = { response: z.never(), kind: "empty" as const, status: 204 as const };
/** Every built-in handler has a contract; adding a handler fails typecheck until it is described. */
export const operationContracts = {
  handleMcp: {
    external: true,
    response: z.unknown(),
    kind: "mixed" as const,
    status: 200,
    body: z.unknown(),
  },
  handleA2a: {
    external: true,
    response: z.unknown(),
    kind: "mixed" as const,
    status: 200,
    body: z.unknown(),
  },
  getAssistant: createJsonContract(wire.assistant),
  searchAssistants: createJsonContract(
    z.array(wire.assistant.partial()),
    schemas.assistantSearchSchema,
  ),
  countAssistants: createJsonContract(z.number(), schemas.assistantCountSchema),
  getAssistantSchemas: createJsonContract(opaqueObject),
  createAssistant: createJsonContract(wire.assistant, schemas.assistantCreateSchema),
  updateAssistant: createJsonContract(wire.assistant, schemas.assistantUpdateSchema),
  deleteAssistant: { ...emptyContract, query: z.object({ delete_threads: query.booleanFlag }) },
  listAssistantVersions: createJsonContract(
    z.array(wire.assistant.omit({ updated_at: true })),
    schemas.assistantVersionsSchema,
  ),
  setAssistantLatestVersion: createJsonContract(wire.assistant, schemas.assistantSetLatestSchema),
  getAssistantGraph: {
    ...createJsonContract(opaqueObject),
    query: z.object({ xray: query.graphDepth }),
  },
  getAssistantSubgraphs: {
    ...createJsonContract(opaqueObject),
    query: z.object({ namespace: query.stringQuery, recurse: query.booleanFlag }),
  },
  createThread: createJsonContract(wire.thread, schemas.threadCreateSchema),
  getThread: createJsonContract(wire.thread),
  getThreadStorage: createJsonContract(wire.storage),
  listThreads: createJsonContract(z.array(wire.thread.partial()), schemas.threadSearchSchema),
  countThreads: createJsonContract(z.number(), schemas.threadCountSchema),
  pruneThreads: createJsonContract(
    z.object({ pruned_count: z.number() }),
    schemas.threadPruneSchema,
  ),
  copyThread: createJsonContract(wire.thread),
  patchThread: createJsonContract(wire.thread, schemas.threadPatchSchema),
  deleteThread: emptyContract,
  getThreadHistory: {
    ...createJsonContract(z.array(wire.state), schemas.threadHistorySchema),
    query: z.object({ limit: query.pageInteger }),
  },
  getThreadState: {
    ...createJsonContract(wire.state),
    query: z.object({ subgraphs: query.booleanFlag }),
  },
  getThreadStateAtCheckpoint: createJsonContract(wire.state),
  getThreadStateAtCheckpointFromBody: createJsonContract(
    wire.state,
    schemas.threadStateCheckpointSchema,
  ),
  updateThreadState: createJsonContract(
    z.object({ checkpoint: wire.checkpoint }),
    schemas.threadStateUpdateSchema,
  ),
  createWaitRun: createJsonContract(z.unknown(), schemas.runCreateSchema),
  createStreamRun: createStreamContract(schemas.runCreateSchema),
  createBackgroundRun: createJsonContract(wire.run, schemas.runCreateSchema),
  createStatelessRun: createJsonContract(wire.run, schemas.runCreateSchema),
  createRunBatch: createJsonContract(z.array(wire.run), schemas.runBatchCreateSchema),
  getRun: createJsonContract(wire.run),
  listRunDeliveries: {
    ...createJsonContract(
      z.object({
        deliveries: z.array(delivery.omit({ payload: true }).extend({ replayable: z.boolean() })),
      }),
    ),
    query: z.object({
      limit: query.pageInteger,
      offset: query.pageInteger,
      status: query.deliveryStatus,
    }),
  },
  replayRunDelivery: createJsonContract(delivery),
  listThreadRuns: {
    ...createJsonContract(z.array(wire.run)),
    query: z.object({
      limit: query.pageInteger,
      offset: query.pageInteger,
      status: query.runStatus,
    }),
  },
  joinRunStream: {
    ...createStreamContract(),
    headers: replayHeaders,
    query: z.object({ cancel_on_disconnect: query.cancelFlag }),
  },
  joinRun: createJsonContract(z.unknown()),
  cancelRun: {
    ...createJsonContract(wire.run),
    query: z.object({ action: query.cancelAction, wait: query.cancelFlag }),
  },
  cancelManyRuns: {
    ...createJsonContract(
      z.object({
        cancelled_count: z.number(),
        cancelled_run_ids: z.array(z.string()),
        truncated: z.boolean(),
      }),
      schemas.cancelManySchema,
    ),
    query: z.object({ action: query.cancelAction, wait: query.cancelFlag }),
  },
  deleteRun: emptyContract,
  createCron: createJsonContract(wire.cron, schemas.cronCreateSchema),
  getCron: createJsonContract(wire.cron),
  searchCrons: createJsonContract(z.array(wire.cron.partial()), schemas.cronSearchSchema),
  countCrons: createJsonContract(z.number(), schemas.cronCountSchema),
  updateCron: createJsonContract(wire.cron, schemas.cronUpdateSchema),
  deleteCron: createJsonContract(z.null()),
  postThreadStream: createStreamContract(schemas.threadStreamSchema),
  getThreadStream: {
    ...createStreamContract(),
    headers: replayHeaders,
    query: z.object({ stream_mode: query.repeatedStringQuery }),
  },
  postThreadCommands: {
    ...createJsonContract(
      z.object({
        id: z.union([z.string(), z.number(), z.null()]),
        result: z.unknown().optional(),
        error: z.unknown().optional(),
      }),
      schemas.commandBodySchema.or(threadCommandEnvelopeSchema),
    ),
    kind: "mixed" as const,
  },
  postThreadEvents: createStreamContract(threadEventFilterSchema),
  getServerInfo: createJsonContract(
    z.object({
      version: z.string().optional(),
      langgraph_js_version: z.string().optional(),
      context: z.literal("js"),
      flags: z.object({
        assistants: z.boolean(),
        crons: z.boolean(),
        langsmith: z.boolean(),
        per_run_timeout: z.boolean().optional(),
      }),
    }),
  ),
  getOpenApi: createJsonContract(
    z
      .object({
        openapi: z.string(),
        info: z.object({ title: z.string(), version: z.string() }),
        paths: z.record(z.unknown()),
      })
      .passthrough(),
  ),
  listChannels: createJsonContract(z.object({ channels: z.array(opaqueObject) })),
  handleInboundEvent: {
    external: true,
    response: z.unknown(),
    kind: "mixed" as const,
    status: 200,
    body: z.string(),
  },
  putStoreItem: createJsonContract(wire.item.nullable(), schemas.storePutSchema),
  getStoreItem: {
    ...createJsonContract(wire.item.nullable(), storeTargetBody),
    query: z.object({
      namespace: query.repeatedStringQuery,
      key: query.stringQuery,
      refresh_ttl: z.enum(["true", "false"]).optional(),
    }),
  },
  deleteStoreItem: {
    ...emptyContract,
    body: storeTargetBody,
    query: z.object({ namespace: query.repeatedStringQuery, key: query.stringQuery }),
  },
  searchStoreItems: createJsonContract(
    z.object({ items: z.array(wire.item) }),
    schemas.storeSearchSchema,
  ),
  listStoreNamespaces: createJsonContract(
    z.object({ namespaces: z.array(z.array(z.string())) }),
    schemas.listNamespacesSchema,
  ),
} satisfies Record<keyof ProtocolHandlers, OperationContract>;

// Zod passthrough objects include an index signature, whereas SDK interfaces need not.
// Check their declared fields recursively while leaving passthrough serialization intact.
type KnownResponse<T> = T extends (infer E)[]
  ? KnownResponse<E>[]
  : T extends object
    ? {
        [K in keyof T as string extends K ? never : number extends K ? never : K]: KnownResponse<
          T[K]
        >;
      }
    : T;

/** Compile-time response checking only: serialization must preserve graph/SDK payloads verbatim. */
export function createOperationJson<N extends keyof typeof operationContracts>(
  name: N,
  body: KnownResponse<z.input<(typeof operationContracts)[N]["response"]>>,
  headers?: Record<string, string>,
): ProtocolResponse {
  return { kind: "json", status: operationContracts[name].status, body, headers };
}
export function createOperationEmpty(name: keyof typeof operationContracts): ProtocolResponse {
  return { kind: "empty", status: operationContracts[name].status };
}
