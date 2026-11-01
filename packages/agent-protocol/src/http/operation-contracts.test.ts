import type {
  Assistant,
  Checkpoint,
  Cron,
  Run,
  Thread,
  ThreadState,
  ThreadTask,
  Interrupt,
} from "@skein-js/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import { createProtocolHandlers, type ProtocolRequest } from "../create-handlers.js";
import { createOpenApiDocument } from "../meta/openapi.js";
import type * as wire from "../meta/response-schemas.js";
import { createProtocolServiceFromContext } from "../service.js";

import { operationContracts } from "./operation-contracts.js";
import { skeinRoutes, filterSkeinRoutes } from "./routes.js";

describe("shared operation contracts", () => {
  it("covers every SDK-backed resource field, including optional additions", () => {
    expectTypeOf<
      Exclude<keyof Assistant, keyof typeof wire.assistant.shape>
    >().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof Thread, keyof typeof wire.thread.shape>>().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof Run, keyof typeof wire.run.shape>>().toEqualTypeOf<never>();
    expectTypeOf<
      Exclude<keyof Checkpoint, keyof typeof wire.checkpoint.shape>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Exclude<keyof ThreadState, keyof typeof wire.state.shape>
    >().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof ThreadTask, keyof typeof wire.task.shape>>().toEqualTypeOf<never>();
    expectTypeOf<
      Exclude<keyof Interrupt, keyof typeof wire.interrupt.shape>
    >().toEqualTypeOf<never>();
    expectTypeOf<Exclude<keyof Cron, keyof typeof wire.cron.shape>>().toEqualTypeOf<never>();
  });
  it("uses the same changed body validator in execution and the next generated document", async () => {
    const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
    const handlers = createProtocolHandlers(service);
    const schema = operationContracts.createThread.body;
    const previous = schema.shape.thread_id;
    schema.shape.thread_id = z.string().min(10).optional();
    try {
      const req: ProtocolRequest = {
        method: "POST",
        url: "http://localhost/threads",
        params: {},
        query: {},
        headers: {},
        body: { thread_id: "short" },
      };
      await expect(handlers.createThread(req)).rejects.toMatchObject({ status: 400 });
      const response = await handlers.createThread({
        ...req,
        body: { thread_id: "long-enough-id" },
      });
      expect(response.kind).toBe("json");
      expect(
        operationContracts.createThread.response.safeParse(
          response.kind === "json" ? response.body : undefined,
        ).success,
      ).toBe(true);
      const spec = createOpenApiDocument(skeinRoutes, handlers) as {
        paths: Record<
          string,
          Record<
            string,
            { requestBody: { content: Record<string, { schema: { properties: object } }> } }
          >
        >;
      };
      expect(
        spec.paths["/threads"]!.post!.requestBody.content["application/json"]!.schema.properties,
      ).toHaveProperty("thread_id", expect.objectContaining({ minLength: 10 }));
    } finally {
      schema.shape.thread_id = previous;
    }
  });
  it("matches mounted operations and documents real empty versus JSON statuses", () => {
    const handlers = createProtocolHandlers(
      createProtocolServiceFromContext(createContext(createFixtureDeps())),
      { getOpenApi: async () => ({ kind: "json", status: 200, body: {} }) },
    );
    const routes = filterSkeinRoutes(skeinRoutes, { crons: true });
    const spec = createOpenApiDocument(routes, handlers) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    for (const route of routes) {
      if (!handlers[route.handler]) continue;
      const path = route.path.replace(/:([A-Za-z_]+)/g, "{$1}");
      expect(spec.paths[path]?.[route.method]).toBeDefined();
    }
    expect(Object.keys(spec.paths).some((path) => path.includes("crons"))).toBe(false);
    expect(spec.paths["/threads/{thread_id}"]!.delete!.responses).toHaveProperty("204");
    expect(spec.paths["/threads/{thread_id}"]!.delete!.responses).not.toHaveProperty("200");
    expect(spec.paths["/threads"]!.post!.responses).not.toHaveProperty("204");
  });
});

it("validates actual resource responses without rewriting their payloads", async () => {
  const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
  await service.assistants.registerGraphAssistants();
  const thread = await service.threads.create();
  const run = await service.runs.createBackground(thread.thread_id, {
    assistant_id: "echo",
    input: { value: "contract" },
  });
  const handlers = createProtocolHandlers(service);
  const req: ProtocolRequest = {
    method: "POST",
    url: "http://localhost/",
    params: { thread_id: thread.thread_id, assistant_id: "echo", run_id: run.run_id },
    query: {},
    body: {},
    headers: {},
  };
  for (const name of [
    "getAssistant",
    "searchAssistants",
    "listAssistantVersions",
    "getThread",
    "listThreads",
    "getRun",
    "listThreadRuns",
    "getThreadState",
    "getThreadHistory",
    "countThreads",
    "countAssistants",
    "getServerInfo",
  ] as const) {
    const response = await handlers[name](req);
    expect(response.kind).toBe("json");
    expect(response.status).toBe(operationContracts[name].status);
    if (response.kind === "json")
      expect(operationContracts[name].response.safeParse(response.body), name).toMatchObject({
        success: true,
      });
  }
  const storeRequest = {
    ...req,
    body: { namespace: ["contract"], key: "one", value: { kept: "verbatim" } },
  };
  const stored = await handlers.putStoreItem(storeRequest);
  if (stored.kind === "json")
    expect(operationContracts.putStoreItem.response.parse(stored.body)).toMatchObject({
      value: { kept: "verbatim" },
    });
  const cron = await service.crons.create({ assistant_id: "echo", schedule: "0 * * * *" });
  const cronResponse = await handlers.getCron({ ...req, params: { cron_id: cron.cron_id } });
  if (cronResponse.kind === "json")
    expect(operationContracts.getCron.response.safeParse(cronResponse.body)).toMatchObject({
      success: true,
    });
  const removed = await handlers.deleteCron({ ...req, params: { cron_id: cron.cron_id } });
  expect(removed).toEqual({ kind: "json", status: 200, body: null, headers: undefined });
});
