import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolHandlers } from "../create-handlers.js";
import { skeinRoutes } from "../http/routes.js";
import { createProtocolServiceFromContext } from "../service.js";

import { createOpenApiDocument } from "./openapi.js";
import { responseSchemas } from "./response-schemas.js";

describe("optional run and retention API contract", () => {
  it("documents the duration boundary and retention projections without requiring them", () => {
    const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
    const document = createOpenApiDocument(skeinRoutes, createProtocolHandlers(service)) as {
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody?: {
              content: Record<
                string,
                { schema: { properties: Record<string, unknown>; required?: string[] } }
              >;
            };
            responses: Record<
              string,
              {
                content: Record<
                  string,
                  { schema: { properties: Record<string, unknown>; required?: string[] } }
                >;
              }
            >;
          }
        >
      >;
    };
    const request = document.paths["/runs"]!.post!.requestBody!.content["application/json"]!.schema;
    expect(request.properties.timeout_ms).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 2147483647,
    });
    expect(request.required ?? []).not.toContain("timeout_ms");
    const thread =
      document.paths["/threads/{thread_id}"]!.get!.responses["200"]!.content["application/json"]!
        .schema;
    expect(thread.properties).toHaveProperty("ttl");
    expect(thread.properties).toHaveProperty("expires_at");
    expect(thread.required ?? []).not.toContain("ttl");
    const item =
      document.paths["/store/items"]!.get!.responses["200"]!.content["application/json"]!.schema;
    expect(item.properties).toHaveProperty("expires_at");
  });

  it("accepts legacy custom-driver projections and explicit no-expiry metadata", () => {
    const legacy = {
      thread_id: "thread",
      status: "idle",
      created_at: "now",
      updated_at: "now",
      metadata: {},
      values: {},
    };
    expect(responseSchemas.getThread!.parse(legacy)).toEqual(legacy);
    expect(
      responseSchemas.getThread!.parse({
        ...legacy,
        ttl: null,
        expires_at: null,
        ttl_strategy: "keep_latest",
      }),
    ).toMatchObject({ ttl: null, expires_at: null });
  });
});
