import type { AuthEngine } from "@skein-js/core";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { ProtocolHandlers } from "../create-handlers.js";
import type { RouteBinding } from "../http/routes.js";
import {
  threadEventFilterSchema,
  threadCommandEnvelopeSchema,
} from "../threads/thread-protocol-service.js";
import * as schemas from "../validation/schemas.js";
import { responseSchemas } from "./response-schemas.js";

/** The validators actually used by each body-bearing handler, kept internal. */
const requests: Partial<Record<keyof ProtocolHandlers, ZodTypeAny>> = {
  createWaitRun: schemas.runCreateSchema,
  createStreamRun: schemas.runCreateSchema,
  createBackgroundRun: schemas.runCreateSchema,
  createStatelessRun: schemas.runCreateSchema,
  createRunBatch: schemas.runBatchCreateSchema,
  cancelManyRuns: schemas.cancelManySchema,
  createThread: schemas.threadCreateSchema,
  patchThread: schemas.threadPatchSchema,
  listThreads: schemas.threadSearchSchema,
  countThreads: schemas.threadCountSchema,
  pruneThreads: schemas.threadPruneSchema,
  getThreadHistory: schemas.threadHistorySchema,
  getThreadStateAtCheckpointFromBody: schemas.threadStateCheckpointSchema,
  updateThreadState: schemas.threadStateUpdateSchema,
  createAssistant: schemas.assistantCreateSchema,
  updateAssistant: schemas.assistantUpdateSchema,
  searchAssistants: schemas.assistantSearchSchema,
  countAssistants: schemas.assistantCountSchema,
  listAssistantVersions: schemas.assistantVersionsSchema,
  setAssistantLatestVersion: schemas.assistantSetLatestSchema,
  createCron: schemas.cronCreateSchema,
  updateCron: schemas.cronUpdateSchema,
  searchCrons: schemas.cronSearchSchema,
  countCrons: schemas.cronCountSchema,
  putStoreItem: schemas.storePutSchema,
  searchStoreItems: schemas.storeSearchSchema,
  listStoreNamespaces: schemas.listNamespacesSchema,
  postThreadStream: schemas.threadStreamSchema,
  postThreadCommands: schemas.commandBodySchema.or(threadCommandEnvelopeSchema),
  postThreadEvents: threadEventFilterSchema,
};

const streams = new Set<keyof ProtocolHandlers>([
  "createStreamRun",
  "postThreadStream",
  "getThreadStream",
  "joinRunStream",
  "postThreadEvents",
]);

export function createOpenApiDocument(
  routes: readonly RouteBinding[],
  handlers: ProtocolHandlers,
  auth?: AuthEngine,
  version = "unknown",
): object {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    if (!handlers[route.handler]) continue;
    const path = route.path.replace(/:([A-Za-z_]+)/g, "{$1}");
    const parameters: object[] = [...route.path.matchAll(/:([A-Za-z_]+)/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (route.method === "get" && route.handler === "listThreadRuns")
      parameters.push(
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1 } },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0 } },
        { name: "status", in: "query", schema: { type: "string" } },
      );
    if (["getThreadStream", "joinRunStream"].includes(route.handler))
      parameters.push({ name: "Last-Event-ID", in: "header", schema: { type: "string" } });
    if (route.handler === "getThreadStream")
      parameters.push({
        name: "stream_modes",
        in: "query",
        schema: { type: "array", items: { type: "string" } },
        style: "form",
        explode: true,
      });
    const validator = requests[route.handler];
    const requestSchema = validator
      ? zodToJsonSchema(validator, { target: "openApi3", $refStrategy: "none" })
      : undefined;
    const streaming = streams.has(route.handler);
    const responseSchema = responseSchemas[route.handler];
    const jsonSchema = responseSchema
      ? zodToJsonSchema(responseSchema, { target: "openApi3", $refStrategy: "none" })
      : {};
    const content = streaming
      ? { "text/event-stream": { schema: { type: "string" } } }
      : {
          "application/json": { schema: jsonSchema },
          ...(route.handler === "postThreadCommands" ||
          route.handler === "handleMcp" ||
          route.handler === "handleA2a"
            ? { "text/event-stream": { schema: { type: "string" } } }
            : {}),
        };
    const operation = {
      operationId: `${route.handler}_${route.method}_${route.path.replace(/[^A-Za-z0-9]+/g, "_")}`,
      tags: [route.group ?? "custom"],
      parameters,
      ...(requestSchema
        ? {
            requestBody: {
              required: !validator!.safeParse({}).success,
              content: { "application/json": { schema: requestSchema } },
            },
          }
        : {}),
      ...(route.retainRawBody
        ? { requestBody: { content: { "*/*": { schema: { type: "string" } } } } }
        : {}),
      ...(route.handler === "getServerInfo" ? { security: [] } : {}),
      ...(auth && route.handler !== "getServerInfo"
        ? {
            description:
              "Requires deployment authentication and the resource authorization policy.",
          }
        : {}),
      responses: {
        "200": { description: "Success", content },
        "204": { description: "No content" },
        "400": { description: "Invalid request" },
        "401": { description: "Authentication required" },
        "403": { description: "Permission denied" },
        "404": { description: "Resource not found" },
        "409": { description: "Conflict" },
        "422": { description: "Unsupported operation or state" },
        "501": { description: "Deployment capability unavailable" },
      },
    };
    (paths[path] ??= {})[route.method] = operation;
  }
  if (routes.some((route) => route.handler === "getOpenApi"))
    paths["/docs"] = {
      get: {
        summary: "API reference",
        responses: {
          "200": {
            description: "HTML API reference",
            content: { "text/html": { schema: { type: "string" } } },
          },
        },
      },
    };
  if (routes.some((route) => route.group === "meta"))
    paths["/metrics"] = {
      get: {
        summary: "Collect host OpenTelemetry metrics",
        parameters: [
          { name: "format", in: "query", schema: { type: "string", enum: ["prometheus", "json"] } },
        ],
        responses: {
          "200": {
            description: "Collected metrics",
            content: {
              "text/plain": { schema: { type: "string" } },
              "application/json": { schema: { type: "object" } },
            },
          },
          "501": { description: "No host collector configured" },
        },
      },
    };
  return {
    openapi: "3.0.3",
    info: { title: "Skein Agent Server", version },
    paths,
    ...(auth?.openapi?.security ? { security: auth.openapi.security } : {}),
    components: { securitySchemes: auth?.openapi?.securitySchemes ?? {} },
    "x-skein-authentication": {
      enabled: auth !== undefined,
      described: auth?.openapi !== undefined,
    },
  };
}

/** Offline reference UI: its route/schema inventory is fetched from this server's actual document. */
export function apiDocsHtml(): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Skein API reference</title><style>body{font:16px system-ui;max-width:1100px;margin:3rem auto;padding:0 1rem;color:#17212b}summary{cursor:pointer;padding:1rem;background:#f1f5f9}details{margin:1rem 0;border:1px solid #cbd5e1}pre{overflow:auto;padding:1rem}a{color:#185bbb}</style><h1>Skein Agent Server API</h1><p><a href="./openapi.json">OpenAPI document</a></p><p id="auth"></p><main id="routes"></main><script>fetch(new URL('./openapi.json',location.href)).then(r=>{if(!r.ok)throw Error('OpenAPI request failed: '+r.status);return r.json()}).then(spec=>{document.getElementById('auth').textContent=spec['x-skein-authentication'].enabled?'This deployment requires authentication.':'';for(const [path,methods]of Object.entries(spec.paths)){for(const [method,operation]of Object.entries(methods)){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=method.toUpperCase()+' '+path;pre.textContent=JSON.stringify(operation,null,2);details.append(summary,pre);document.getElementById('routes').append(details)}}}).catch(error=>{document.getElementById('routes').textContent=error.message});</script></html>`;
}
