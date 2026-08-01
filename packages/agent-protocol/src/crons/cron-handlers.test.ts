// The cron HTTP surface, focused on the places where the wire contract is *not* what you would
// naturally write — each one breaks the official `@langchain/langgraph-sdk` client if you get it
// wrong, and each one is invisible to a test that only checks the service layer.

import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import {
  createProtocolHandlers,
  type ProtocolHandlers,
  type ProtocolRequest,
} from "../create-handlers.js";
import { createRouteMatcher, skeinRoutes } from "../http/routes.js";
import { createProtocolServiceFromContext } from "../service.js";

function request(overrides: Partial<ProtocolRequest> = {}): ProtocolRequest {
  return {
    method: "post",
    url: "http://localhost/",
    params: {},
    query: {},
    body: {},
    headers: {},
    ...overrides,
  };
}

async function handlersWithAssistant(): Promise<{
  handlers: ProtocolHandlers;
  assistantId: string;
}> {
  const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
  await service.assistants.registerGraphAssistants();
  const [assistant] = await service.assistants.search({});
  return {
    handlers: createProtocolHandlers(service),
    assistantId: assistant?.assistant_id as string,
  };
}

async function createCron(handlers: ProtocolHandlers, assistantId: string, body = {}) {
  const response = await handlers.createCron(
    request({ body: { assistant_id: assistantId, schedule: "0 9 * * *", ...body } }),
  );
  if (response.kind !== "json") throw new Error("expected a JSON response");
  return response.body as { cron_id: string };
}

describe("cron handlers", () => {
  // 200 with a JSON body, NOT 204 and not an empty 200. The SDK's `BaseClient` skips
  // `response.json()` only for 202 and 204, so a 200 with no body makes the official client throw
  // `SyntaxError: Unexpected end of JSON input` on a delete that actually succeeded.
  it("answers DELETE with 200 and a parseable JSON body", async () => {
    const { handlers, assistantId } = await handlersWithAssistant();
    const cron = await createCron(handlers, assistantId);

    const response = await handlers.deleteCron(
      request({ method: "delete", params: { cron_id: cron.cron_id } }),
    );

    expect(response.kind).toBe("json");
    expect(response.status).toBe(200);
    // The body has to survive `JSON.parse`; `null` does, an empty string does not.
    expect(() =>
      JSON.parse(JSON.stringify(response.kind === "json" ? response.body : undefined)),
    ).not.toThrow();
  });

  // A bare integer, not `{ count }` — what the OpenAPI spec declares and what `crons.count()` reads.
  it("answers count with a bare integer", async () => {
    const { handlers, assistantId } = await handlersWithAssistant();
    await createCron(handlers, assistantId);
    await createCron(handlers, assistantId);

    const response = await handlers.countCrons(request({ body: {} }));

    expect(response.kind).toBe("json");
    expect(response.kind === "json" ? response.body : undefined).toBe(2);
  });

  it("returns the full Cron from create, get, search, and update", async () => {
    const { handlers, assistantId } = await handlersWithAssistant();
    const created = await createCron(handlers, assistantId);

    const get = await handlers.getCron(
      request({ method: "get", params: { cron_id: created.cron_id } }),
    );
    const search = await handlers.searchCrons(request({ body: {} }));
    const update = await handlers.updateCron(
      request({ method: "patch", params: { cron_id: created.cron_id }, body: { enabled: false } }),
    );

    // Every endpoint answers the same shape — the narrower `CronCreateResponse` legacy types are
    // satisfied structurally by the full row.
    for (const body of [
      get.kind === "json" ? get.body : undefined,
      (search.kind === "json" ? (search.body as unknown[]) : [])[0],
      update.kind === "json" ? update.body : undefined,
    ]) {
      expect(body).toMatchObject({
        cron_id: created.cron_id,
        assistant_id: assistantId,
        schedule: "0 9 * * *",
      });
      expect(body).toHaveProperty("next_run_date");
      expect(body).toHaveProperty("enabled");
    }
  });

  it("reports the total on search, like assistants and threads", async () => {
    const { handlers, assistantId } = await handlersWithAssistant();
    await createCron(handlers, assistantId);
    await createCron(handlers, assistantId);

    const response = await handlers.searchCrons(request({ body: { limit: 1 } }));

    expect(response.kind === "json" ? response.body : []).toHaveLength(1);
    expect(response.headers?.["x-pagination-total"]).toBe("2");
  });

  it("accepts and ignores a select projection", async () => {
    const { handlers, assistantId } = await handlersWithAssistant();
    await createCron(handlers, assistantId);

    const response = await handlers.searchCrons(request({ body: { select: ["cron_id", "now"] } }));

    // Validated (a typo would 400) but not applied — skein always returns the full row.
    expect(response.status).toBe(200);
    expect((response.kind === "json" ? (response.body as unknown[]) : [])[0]).toHaveProperty(
      "schedule",
    );
  });

  it("400s an unknown select field rather than ignoring it silently", async () => {
    const { handlers } = await handlersWithAssistant();

    await expect(
      handlers.searchCrons(request({ body: { select: ["nonsense"] } })),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("folds the path thread_id into a thread-scoped create", async () => {
    const service = createProtocolServiceFromContext(createContext(createFixtureDeps()));
    await service.assistants.registerGraphAssistants();
    const [assistant] = await service.assistants.search({});
    const handlers = createProtocolHandlers(service);
    const thread = await service.threads.create();

    // What `copyThreadIdIntoBody` hands the handler on the thread-scoped route.
    const response = await handlers.createCron(
      request({
        params: { thread_id: thread.thread_id },
        body: {
          assistant_id: assistant?.assistant_id,
          schedule: "0 9 * * *",
          thread_id: thread.thread_id,
        },
      }),
    );

    expect(response.kind === "json" ? response.body : undefined).toMatchObject({
      thread_id: thread.thread_id,
    });
  });
});

describe("cron routes", () => {
  const match = createRouteMatcher(skeinRoutes);

  // Table order IS specificity. `/runs` is anchored so it cannot shadow `/runs/crons`, but the two
  // literal sub-paths compete with `/runs/crons/:cron_id`, which would happily swallow them.
  it("matches the literal cron sub-paths before the :cron_id parameter", () => {
    expect(match("post", "/runs/crons/search")?.binding.handler).toBe("searchCrons");
    expect(match("post", "/runs/crons/count")?.binding.handler).toBe("countCrons");
    expect(match("post", "/runs/crons")?.binding.handler).toBe("createCron");
  });

  it("routes each cron verb to its handler", () => {
    expect(match("get", "/runs/crons/abc")?.binding.handler).toBe("getCron");
    expect(match("get", "/runs/crons/abc")?.params).toEqual({ cron_id: "abc" });
    expect(match("patch", "/runs/crons/abc")?.binding.handler).toBe("updateCron");
    expect(match("delete", "/runs/crons/abc")?.binding.handler).toBe("deleteCron");
  });

  it("routes the thread-scoped create and folds the thread id", () => {
    const found = match("post", "/threads/t1/runs/crons");

    expect(found?.binding.handler).toBe("createCron");
    expect(found?.binding.foldThreadIdIntoBody).toBe(true);
    expect(found?.params).toEqual({ thread_id: "t1" });
  });

  // The cron paths sit above `/runs` in the table, so this guards against them being reordered into
  // a position where the run routes shadow them.
  it("does not let the run routes shadow the cron routes", () => {
    expect(match("post", "/runs")?.binding.handler).toBe("createStatelessRun");
    expect(match("post", "/threads/t1/runs")?.binding.handler).toBe("createBackgroundRun");
  });

  it("puts every cron route in the crons group, so disable_crons switches them all off", () => {
    const cronRoutes = skeinRoutes.filter((binding) => binding.path.includes("/crons"));

    expect(cronRoutes).toHaveLength(7);
    for (const binding of cronRoutes) expect(binding.group).toBe("crons");
  });
});
