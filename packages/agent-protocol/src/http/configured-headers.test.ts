import { SkeinHttpError, type AuthEngine } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import type { ProtocolRequest } from "../create-handlers.js";
import type { AgentGraph } from "../graphs/agent-graph.js";
import { createProtocolRuntime } from "../runtime.js";

async function fixture() {
  const values = new Map<string, Record<string, unknown>>();
  const graph: AgentGraph = {
    async *stream(_input, options) {
      const config = options as { configurable: Record<string, unknown> };
      values.set(String(config.configurable["thread_id"]), config.configurable);
      yield ["values", config.configurable];
    },
    async getState(config) {
      return {
        values: values.get(String(config.configurable?.["thread_id"])) ?? {},
        next: [],
        tasks: [],
      };
    },
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const auth: AuthEngine = {
    enabled: true,
    studioAuthDisabled: true,
    async authenticate(request) {
      if (request.headers.get("x-user") !== "alice")
        throw SkeinHttpError.unauthorized("Missing credentials");
      return {
        user: { identity: "alice", display_name: "Alice", is_authenticated: true, permissions: [] },
        scopes: [],
      };
    },
    async authorize({ value }) {
      return { value };
    },
    matchesFilters: () => true,
  };
  const deps = createFixtureDeps({
    graphs: { ids: ["report"], load: async () => graph, schemas: async () => ({}) },
    auth,
    logger,
    configurableHeaders: { includes: ["x-*", "langgraph_*"], excludes: ["x-secret"] },
    loggingHeaders: { includes: ["*"] },
  });
  const runtime = createProtocolRuntime(deps);
  await runtime.service.assistants.registerGraphAssistants();
  const request = (body: unknown, headers = {}): ProtocolRequest => ({
    method: "POST",
    url: "http://localhost/runs/wait",
    body,
    headers: { "x-user": "alice", ...headers },
    params: {},
    query: {},
  });
  return { runtime, deps, request, logger };
}

describe("configured headers through authorized admission", () => {
  it("uses explicit body values and authenticated identity ahead of selected caller headers", async () => {
    const f = await fixture();
    const body = {
      assistant_id: "report",
      input: {},
      config: { configurable: { "x-tenant": "body", langgraph_auth_user_id: "spoof" } },
    };
    const response = await f.runtime.handlers.createWaitRun(
      f.request(body, {
        "X-Tenant": "header",
        "x-secret": "excluded",
        langgraph_auth_user_id: "spoof",
      }),
    );
    expect(response.kind).toBe("json");
    if (response.kind !== "json") return;
    expect(response.body).toMatchObject({ "x-tenant": "body", langgraph_auth_user_id: "alice" });
    expect(response.body).not.toHaveProperty("x-secret");
    expect(body.config.configurable).toEqual({
      "x-tenant": "body",
      langgraph_auth_user_id: "spoof",
    });
  });

  it("fingerprints forwarded configuration and logs authenticated replays with secrets redacted", async () => {
    const f = await fixture();
    const body = { assistant_id: "report", input: {} };
    const headers = {
      "idempotency-key": "same",
      "x-tenant": "one",
      authorization: "private-value",
      "x-api-key": "private-value",
    };
    const first = await f.runtime.handlers.createWaitRun(f.request(body, headers));
    const replay = await f.runtime.handlers.createWaitRun(f.request(body, headers));
    expect(replay.headers?.["idempotent-replay"]).toBe("true");
    expect(replay).toMatchObject({ body: first.kind === "json" ? first.body : undefined });
    await expect(
      f.runtime.handlers.createWaitRun(f.request(body, { ...headers, "x-tenant": "two" })),
    ).rejects.toThrow(/different|mismatch|reused/i);
    expect(f.logger.info).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(f.logger.info.mock.calls)).not.toContain("private-value");
    expect(JSON.stringify(f.logger.info.mock.calls)).toContain("[redacted]");
  });

  it("preserves public discovery and never logs rejected credentials", async () => {
    const f = await fixture();
    await expect(
      f.runtime.handlers.createWaitRun(f.request({ assistant_id: "report" }, { "x-user": "bob" })),
    ).rejects.toThrow("Missing credentials");
    expect(f.logger.info).not.toHaveBeenCalled();
    expect(
      (await f.runtime.handlers.getServerInfo(f.request(undefined, { "x-user": "bob" }))).status,
    ).toBe(200);
  });

  it("persists selected headers on every batch item without changing its original body", async () => {
    const f = await fixture();
    const body = [
      { assistant_id: "report", input: {} },
      { assistant_id: "report", input: {} },
    ];
    const response = await f.runtime.handlers.createRunBatch(
      f.request(body, { "x-tenant": "batch" }),
    );
    if (response.kind !== "json") throw new Error("Expected JSON");
    for (const run of response.body as { run_id: string }[])
      expect((await f.deps.store.runs.getKwargs(run.run_id))?.config?.configurable).toMatchObject({
        "x-tenant": "batch",
      });
    expect(body).toEqual([
      { assistant_id: "report", input: {} },
      { assistant_id: "report", input: {} },
    ]);
  });

  it.each(["legacy", "protocol"])(
    "forwards headers through the %s thread-command shape",
    async (generation) => {
      const deps = createFixtureDeps({ configurableHeaders: { includes: ["x-tenant"] } });
      const runtime = createProtocolRuntime(deps);
      await runtime.service.assistants.registerGraphAssistants();
      const thread = await runtime.service.threads.create();
      await runtime.service.runs.createWait({
        thread_id: thread.thread_id,
        assistant_id: "interrupting",
        input: {},
      });
      const pending = Object.values(
        (await runtime.service.threads.get(thread.thread_id)).interrupts ?? {},
      ).flat();
      const body =
        generation === "legacy"
          ? { resume: "yes" }
          : {
              id: 1,
              method: "input.respond",
              params: { interrupt_id: pending[0]!.id, response: "yes" },
            };
      const response = await runtime.handlers.postThreadCommands({
        method: "POST",
        url: `http://localhost/threads/${thread.thread_id}/commands`,
        params: { thread_id: thread.thread_id },
        query: {},
        headers: { "X-Tenant": "command" },
        body,
      });
      if (response.kind === "sse")
        for await (const _event of response.events) {
          /* drain execution */
        }
      const runs = await deps.store.runs.listByThread(thread.thread_id);
      expect(runs).toHaveLength(2);
      const resumed = runs.find((run) => run.status === "pending" || run.status === "success")!;
      expect((await deps.store.runs.getKwargs(resumed.run_id))?.config?.configurable).toMatchObject(
        { "x-tenant": "command" },
      );
      expect(body).not.toHaveProperty("config");
    },
  );
});
