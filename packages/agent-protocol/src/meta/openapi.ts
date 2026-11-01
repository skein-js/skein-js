import type { AuthEngine } from "@skein-js/core";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { ProtocolHandlers } from "../create-handlers.js";
import { operationContracts } from "../http/operation-contracts.js";
import type { RouteBinding } from "../http/routes.js";
import { pathParameterSchema } from "../validation/parse.js";

import { enabledNativeDiagnostics } from "./native-diagnostics.js";

export function createOpenApiDocument(
  routes: readonly RouteBinding[],
  handlers: ProtocolHandlers,
  auth?: AuthEngine,
  version = "unknown",
) {
  const paths: Record<string, Record<string, unknown>> = {};
  const convert = (schema: Parameters<typeof zodToJsonSchema>[0]) =>
    zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" });
  for (const route of routes) {
    if (!handlers[route.handler]) continue;
    const contract = operationContracts[route.handler];
    const path = route.path.replace(/:([A-Za-z_]+)/g, "{$1}");
    const parameters: object[] = [...route.path.matchAll(/:([A-Za-z_]+)/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: convert(pathParameterSchema),
    }));
    if ("query" in contract) {
      const querySchema = convert(contract.query) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, schema] of Object.entries(querySchema.properties ?? {}))
        parameters.push({
          name,
          in: "query",
          schema,
          required: querySchema.required?.includes(name) ?? false,
        });
    }
    if ("headers" in contract) {
      const headers = convert(contract.headers) as { properties?: Record<string, unknown> };
      for (const [name, schema] of Object.entries(headers.properties ?? {}))
        parameters.push({ name, in: "header", schema });
    }
    const validator = "body" in contract ? contract.body : undefined;
    const requestSchema = validator ? convert(validator) : undefined;
    const content =
      contract.kind === "empty"
        ? undefined
        : contract.kind === "sse"
          ? { "text/event-stream": { schema: convert(contract.response) } }
          : {
              "application/json": { schema: convert(contract.response) },
              ...(contract.kind === "mixed"
                ? { "text/event-stream": { schema: { type: "string" } } }
                : {}),
            };
    const responses = {
      ...("external" in contract && contract.external
        ? {}
        : {
            [contract.status]: {
              description: contract.kind === "empty" ? "No content" : "Success",
              ...(content ? { content } : {}),
            },
          }),
      default: {
        description: "Protocol error. The HTTP status and optional code describe the failure.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["status", "message"],
              properties: {
                status: { type: "integer" },
                message: { type: "string" },
                code: { type: "string" },
                details: {},
              },
            },
          },
        },
      },
    };
    (paths[path] ??= {})[route.method] = {
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
      responses:
        "external" in contract && contract.external
          ? {
              default: {
                description:
                  "Response status, headers and payload are supplied by the official SDK or configured channel provider.",
                content: {
                  "application/json": { schema: {} },
                  "text/event-stream": { schema: { type: "string" } },
                },
              },
            }
          : responses,
    };
  }
  for (const diagnostic of enabledNativeDiagnostics(
    routes.filter((route) => Boolean(handlers[route.handler])),
  )) {
    paths[diagnostic.path] = {
      get: {
        summary: diagnostic.summary,
        ...("query" in diagnostic
          ? {
              parameters: Object.entries(
                (convert(diagnostic.query) as { properties: Record<string, unknown> }).properties,
              ).map(([name, schema]) => ({ name, in: "query", schema })),
            }
          : {}),
        responses: {
          [diagnostic.status]: { description: "Success", content: diagnostic.content },
          ...(diagnostic.name === "metrics"
            ? { "501": { description: "No host collector configured" } }
            : {}),
        },
      },
    };
  }
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
