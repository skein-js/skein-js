import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Annotation, interrupt, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  Client,
  StreamableHTTPClientTransport,
  type InputRequiredResult,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { SkeinHttpError, type AuthEngine } from "@skein-js/core";
import { openSqliteStorage } from "@skein-js/storage-sqlite";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { fixtureLangGraphAgent } from "../__fixtures__/lang-graph-binding.js";
import type { ProtocolDeps } from "../deps.js";
import { createProtocolRuntime } from "../runtime.js";

const state = Annotation.Root({
  left: Annotation<unknown>,
  right: Annotation<unknown>,
});

async function harness(
  overrides: Partial<ProtocolDeps> = {},
  capability: "both" | "form" | "none" = "both",
  callerHeaders: () => Record<string, string> = () => ({}),
) {
  let effects = 0;
  const parallel = new StateGraph(state)
    .addNode("askLeft", () => ({ left: interrupt("Left?") }))
    .addNode("askRight", () => ({ right: interrupt("Right?") }))
    .addNode("finish", () => {
      effects++;
      return {};
    })
    .addEdge("__start__", "askLeft")
    .addEdge("__start__", "askRight")
    .addEdge(["askLeft", "askRight"], "finish")
    .addEdge("finish", "__end__")
    .compile();
  const relay = new StateGraph(state)
    .addNode("relay", () => ({
      left: interrupt({
        type: "mcp_elicitation",
        requests: {
          name: {
            message: "Name?",
            requestedSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
          connect: { mode: "url", message: "Connect", url: "https://example.com/connect" },
        },
      }),
    }))
    .addEdge("__start__", "relay")
    .addEdge("relay", "__end__")
    .compile();
  const review = new StateGraph(state)
    .addNode("review", () => ({
      left: interrupt({
        actionRequests: [{ name: "send_email", args: { to: "ada@example.com" } }],
        reviewConfigs: [
          { actionName: "send_email", allowedDecisions: ["approve", "edit", "reject", "respond"] },
        ],
      }),
    }))
    .addEdge("__start__", "review")
    .addEdge("review", "__end__")
    .compile();
  const ordinary = new StateGraph(state)
    .addNode("answer", () => ({ left: "ordinary" }))
    .addEdge("__start__", "answer")
    .addEdge("answer", "__end__")
    .compile();
  const cancellable = new StateGraph(state)
    .addNode("wait", async (_state, config) => {
      if (!config.signal) throw new Error("Missing run signal");
      const stopped = AbortSignal.any([config.signal, AbortSignal.timeout(3000)]);
      await new Promise<void>((_resolve, reject) => {
        if (stopped.aborted) reject(stopped.reason);
        else stopped.addEventListener("abort", () => reject(stopped.reason), { once: true });
      });
      return {};
    })
    .addEdge("__start__", "wait")
    .addEdge("wait", "__end__")
    .compile();
  const graphs = { parallel, relay, review, ordinary, cancellable };
  const deps = createFixtureDeps({
    graphs: {
      ids: Object.keys(graphs),
      load: async (id) => fixtureLangGraphAgent(graphs[id as keyof typeof graphs]),
      schemas: async () => ({}),
    },
    ...overrides,
  });
  const runtime = createProtocolRuntime(deps);
  await runtime.service.assistants.registerGraphAssistants();
  const requests: unknown[] = [];
  const responses: { status: number; body: unknown }[] = [];
  const client = new Client(
    { name: "elicitation-proof", version: "1" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities:
        capability === "none"
          ? {}
          : { elicitation: capability === "form" ? { form: {} } : { form: {}, url: {} } },
      inputRequired: { autoFulfill: false },
    },
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: async (input, init) => {
      const native = new Request(input, init);
      for (const [key, value] of Object.entries(callerHeaders())) native.headers.set(key, value);
      const body = native.method === "POST" ? await native.json() : undefined;
      requests.push(body);
      const response = await runtime.handlers.handleMcp!({
        method: native.method,
        url: native.url,
        headers: Object.fromEntries(native.headers),
        body,
        params: {},
        query: {},
        signal: native.signal,
      });
      if (response.kind === "sse") throw new Error("Expected stateless JSON");
      const output = response.kind === "json" ? response.body : undefined;
      responses.push({ status: response.status, body: output });
      return new Response(output === undefined ? null : JSON.stringify(output), {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  await client.connect(transport);
  const call = (name: string, extra: Record<string, unknown> = {}, args = {}) =>
    client.request(
      { method: "tools/call", params: { name, arguments: args, ...extra } },
      { allowInputRequired: true },
    ) as Promise<CallToolResult | InputRequiredResult>;
  return { deps, runtime, client, call, requests, responses, effects: () => effects };
}

function paused(result: CallToolResult | InputRequiredResult): InputRequiredResult {
  if (!("resultType" in result)) throw new Error(JSON.stringify(result));
  return result as InputRequiredResult;
}

describe("official modern MCP elicitation", () => {
  it("cancels an executing inline run when the official client aborts its request", async () => {
    const f = await harness();
    const controller = new AbortController();
    try {
      const pending = f.client.request(
        { method: "tools/call", params: { name: "cancellable", arguments: {} } },
        { allowInputRequired: true, signal: controller.signal },
      );
      const completed = pending.then(
        () => ({ rejected: false }),
        () => ({ rejected: true }),
      );
      const latest = async () => {
        const thread = (await f.runtime.service.threads.list())[0];
        return thread ? f.deps.store.runs.latestForThread(thread.thread_id) : null;
      };
      await expect.poll(async () => (await latest())?.status).toBe("running");
      controller.abort();
      expect(await completed).toEqual({ rejected: true });
      await expect.poll(async () => (await latest())?.status).toBe("cancelled");
      expect(f.effects()).toBe(0);
    } finally {
      controller.abort();
      await f.client.close();
    }
  });
  it("honors actual thread expiry even when later writes changed updated_at before collection", async () => {
    let now = new Date();
    const f = await harness({ clock: () => now });
    try {
      const first = paused(await f.call("parallel"));
      const thread = (await f.runtime.service.threads.list())[0]!;
      await f.runtime.service.threads.patch(thread.thread_id, { ttl: 1 });
      now = new Date(now.getTime() + 120_000);
      const get = f.deps.store.threads.get.bind(f.deps.store.threads);
      vi.spyOn(f.deps.store.threads, "get").mockImplementation(async (id) => {
        const current = await get(id);
        return current ? { ...current, updated_at: now.toISOString() } : null;
      });
      await expect(f.call("parallel", { requestState: first.requestState })).rejects.toMatchObject({
        code: -32602,
      });
      expect(f.effects()).toBe(0);
    } finally {
      await f.client.close();
    }
  });
  it("reopens a pending round from SQLite and replays the accepted answer without re-execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skein-mcp-round-"));
    let storage = await openSqliteStorage({ filename: join(directory, "round.sqlite") });
    const overrides = () => ({
      store: storage.store,
      queue: storage.queue,
      checkpointer: new SqliteSaver(storage.database),
    });
    let f = await harness(overrides());
    try {
      const first = paused(await f.call("parallel"));
      const answers = Object.fromEntries(
        Object.keys(first.inputRequests!).map((key) => [
          key,
          { action: "accept", content: { response: "durable" } },
        ]),
      );
      await f.client.close();
      await f.runtime.worker.stop();
      await storage.dispose();
      storage = await openSqliteStorage({ filename: join(directory, "round.sqlite") });
      f = await harness(overrides());
      const reply = await f.call("parallel", {
        requestState: first.requestState,
        inputResponses: answers,
      });
      expect(reply).toMatchObject({
        isError: false,
        structuredContent: { left: "durable", right: "durable" },
      });
      expect(
        await f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
      ).toEqual(reply);
      expect(f.effects()).toBe(1);
    } finally {
      await f.client.close();
      await f.runtime.worker.stop();
      await storage.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts valid first-call answers through the official client's inputResponses contract", async () => {
    const f = await harness();
    try {
      const template = paused(await f.call("parallel"));
      const answers = Object.fromEntries(
        Object.keys(template.inputRequests!).map((key) => [
          key,
          { action: "accept", content: { response: "pre-supplied" } },
        ]),
      );
      expect(await f.call("parallel", { inputResponses: answers })).toMatchObject({
        isError: false,
        structuredContent: { left: "pre-supplied", right: "pre-supplied" },
      });
      expect(f.effects()).toBe(1);
    } finally {
      await f.client.close();
    }
  });
  it.each(["failed erasure", "late record"])(
    "does not replay output from a deleted resumed run after %s",
    async (failure) => {
      const f = await harness();
      try {
        const first = paused(await f.call("parallel"));
        const answers = Object.fromEntries(
          Object.keys(first.inputRequests!).map((key) => [
            key,
            { action: "accept", content: { response: "private output" } },
          ]),
        );
        vi.spyOn(f.deps.store.idempotency, "deleteByRun").mockRejectedValue(
          new Error("unavailable"),
        );
        if (failure === "late record") {
          const record = f.deps.store.idempotency.record.bind(f.deps.store.idempotency);
          vi.spyOn(f.deps.store.idempotency, "record").mockImplementation(
            async (scope, key, claimId, response) => {
              if (scope.endsWith(" answers") && response.run_id)
                await f.runtime.service.runs.delete(response.run_id);
              await record(scope, key, claimId, response);
            },
          );
        }
        expect(
          await f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
        ).toMatchObject({ isError: false });
        if (failure === "failed erasure") {
          const thread = (await f.runtime.service.threads.list())[0]!;
          const resumed = await f.deps.store.runs.latestForThread(thread.thread_id);
          await f.runtime.service.runs.delete(resumed!.run_id);
        }
        await expect(
          f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
        ).rejects.toThrow();
        expect(f.effects()).toBe(1);
      } finally {
        await f.client.close();
      }
    },
  );
  it("binds state to the caller and reauthorizes completed replays after revocation", async () => {
    let caller = "alice";
    let revoked = false;
    const auth: AuthEngine = {
      enabled: true,
      studioAuthDisabled: true,
      async authenticate(request) {
        const identity = request.headers.get("x-user");
        if (!identity) throw SkeinHttpError.unauthorized("No caller");
        return {
          user: { identity, display_name: identity, is_authenticated: true, permissions: [] },
          scopes: [],
        };
      },
      async authorize({ resource, context, value }) {
        if (resource === "threads" && revoked) throw SkeinHttpError.forbidden("Access revoked");
        return {
          value,
          ...(resource === "threads" ? { filters: { owner: context!.user.identity } } : {}),
        };
      },
      matchesFilters: (metadata, filters) => metadata?.["owner"] === filters?.["owner"],
    };
    const f = await harness({ auth }, "both", () => ({ "x-user": caller }));
    try {
      const first = paused(await f.call("parallel"));
      const answers = Object.fromEntries(
        Object.keys(first.inputRequests!).map((key) => [
          key,
          { action: "accept", content: { response: "owned" } },
        ]),
      );
      caller = "bob";
      await expect(
        f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
      ).rejects.toMatchObject({ code: -32602 });
      caller = "alice";
      expect(
        await f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
      ).toMatchObject({ isError: false });
      revoked = true;
      await expect(
        f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
      ).rejects.toThrow();
      expect(f.effects()).toBe(1);
    } finally {
      await f.client.close();
    }
  });

  it("does not revive a cancelled round or a superseded checkpoint", async () => {
    const f = await harness();
    try {
      const first = paused(await f.call("parallel"));
      const cancelled = Object.fromEntries(
        Object.keys(first.inputRequests!).map((key) => [key, { action: "cancel" }]),
      );
      expect(
        await f.call("parallel", { requestState: first.requestState, inputResponses: cancelled }),
      ).toMatchObject({ isError: true });
      const answers = Object.fromEntries(
        Object.keys(first.inputRequests!).map((key) => [
          key,
          { action: "accept", content: { response: "ok" } },
        ]),
      );
      await expect(
        f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
      ).rejects.toMatchObject({ code: -32602 });
      const oldThreads = new Set(
        (await f.runtime.service.threads.list()).map((thread) => thread.thread_id),
      );
      const second = paused(await f.call("parallel"));
      const latest = (await f.runtime.service.threads.list()).find(
        (entry) => !oldThreads.has(entry.thread_id),
      )!;
      await f.runtime.service.threads.updateState(latest.thread_id, {
        values: { left: "externally changed" },
      });
      await expect(
        f.call("parallel", { requestState: second.requestState, inputResponses: answers }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(f.effects()).toBe(0);
    } finally {
      await f.client.close();
    }
  });
  it.each(["none", "form"] as const)(
    "reports missing elicitation capability for a %s client",
    async (capability) => {
      const f = await harness({}, capability);
      try {
        await expect(f.call("relay")).rejects.toMatchObject({ code: -32021 });
        expect(f.responses.at(-1)?.status).toBe(400);
      } finally {
        await f.client.close();
      }
    },
  );

  it.each(["neither", "read-only", "write-only"])(
    "preserves ordinary calls and diagnoses a %s result capability pair",
    async (capability) => {
      const f = await harness();
      if (capability !== "write-only") f.deps.store.runs.recordResult = undefined;
      if (capability !== "read-only") f.deps.store.runs.getResult = undefined;
      try {
        expect(await f.call("ordinary")).toMatchObject({
          isError: false,
          structuredContent: { left: "ordinary" },
        });
        expect(await f.call("parallel")).toMatchObject({
          isError: true,
          content: [expect.objectContaining({ text: expect.stringContaining("cannot retain") })],
        });
        expect(f.effects()).toBe(0);
      } finally {
        await f.client.close();
      }
    },
  );

  it("arbitrates concurrent answers and rejects a changed answer after acceptance", async () => {
    const f = await harness();
    try {
      const first = paused(await f.call("parallel"));
      const answers = Object.fromEntries(
        Object.keys(first.inputRequests!).map((key) => [
          key,
          { action: "accept", content: { response: "ok" } },
        ]),
      );
      const attempts = await Promise.allSettled([
        f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
        f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
      ]);
      expect(attempts.some((attempt) => attempt.status === "fulfilled")).toBe(true);
      expect(
        await f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
      ).toMatchObject({ isError: false });
      expect(f.effects()).toBe(1);
      const changed = Object.fromEntries(
        Object.keys(answers).map((key) => [
          key,
          { action: "accept", content: { response: "changed" } },
        ]),
      );
      await expect(
        f.call("parallel", { requestState: first.requestState, inputResponses: changed }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await f.client.close();
    }
  });
  it("asks parallel questions together, reasks missing answers and resumes/replays once", async () => {
    const f = await harness();
    try {
      const first = paused(await f.call("parallel"));
      const keys = Object.keys(first.inputRequests!);
      expect(keys).toHaveLength(2);
      const answers = Object.fromEntries(
        keys.map((key) => {
          const question = first.inputRequests![key]!;
          if (question.method !== "elicitation/create") throw new Error("Expected elicitation");
          return [
            key,
            {
              action: "accept",
              content: { response: question.params.message === "Left?" ? "left" : "right" },
            },
          ];
        }),
      );
      expect(
        await f.call("parallel", {
          requestState: first.requestState,
          inputResponses: { [keys[0]!]: answers[keys[0]!] },
        }),
      ).toEqual(first);
      const reply = await f.call("parallel", {
        requestState: first.requestState,
        inputResponses: answers,
      });
      expect(reply).toMatchObject({
        structuredContent: { left: "left", right: "right" },
        isError: false,
      });
      expect(
        await f.call("parallel", { requestState: first.requestState, inputResponses: answers }),
      ).toEqual(reply);
      expect(f.effects()).toBe(1);
      expect(await f.runtime.service.threads.list()).toHaveLength(1);
    } finally {
      await f.client.close();
    }
  });

  it("relays form and URL answers with original keys and validates before resuming", async () => {
    const f = await harness();
    try {
      const first = paused(await f.call("relay"));
      expect(Object.keys(first.inputRequests!)).toEqual(["name", "connect"]);
      await expect(
        f.call("relay", {
          requestState: first.requestState,
          inputResponses: {
            name: { action: "accept", content: { name: 3 } },
            connect: { action: "accept" },
          },
        }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(f.responses.at(-1)?.status).toBe(400);
      const answers = {
        name: { action: "accept", content: { name: "Ada" } },
        connect: { action: "accept" },
      };
      expect(
        await f.call("relay", { requestState: first.requestState, inputResponses: answers }),
      ).toMatchObject({ structuredContent: { left: { responses: answers } } });
    } finally {
      await f.client.close();
    }
  });

  it.each(["approve", "edit", "reject", "respond"])(
    "translates a %s tool review without changing its tool name",
    async (decision) => {
      const f = await harness();
      try {
        const first = paused(await f.call("review"));
        const key = Object.keys(first.inputRequests!)[0]!;
        const response = await f.call("review", {
          requestState: first.requestState,
          inputResponses: {
            [key]: {
              action: "accept",
              content: {
                decision,
                ...(decision === "edit" ? { args: '{"to":"grace@example.com"}' } : {}),
                ...(decision === "respond" ? { message: "Already sent" } : {}),
              },
            },
          },
        });
        expect(response).toMatchObject({
          structuredContent: {
            left: {
              decisions: [
                {
                  type: decision,
                  ...(decision === "edit"
                    ? { editedAction: { name: "send_email", args: { to: "grace@example.com" } } }
                    : {}),
                },
              ],
            },
          },
        });
      } finally {
        await f.client.close();
      }
    },
  );

  it("refuses modified state, another tool/arguments, expired state and erased threads", async () => {
    let now = new Date("2026-11-09T00:00:00Z");
    const f = await harness({ clock: () => now });
    try {
      const first = paused(await f.call("parallel"));
      for (const [tool, stateValue, args] of [
        ["parallel", first.requestState + "x", {}],
        ["relay", first.requestState, {}],
        ["parallel", first.requestState, { changed: true }],
      ] as const)
        await expect(f.call(tool, { requestState: stateValue }, args)).rejects.toMatchObject({
          code: -32602,
        });
      now = new Date(now.getTime() + 25 * 3_600_000);
      await expect(f.call("parallel", { requestState: first.requestState })).rejects.toMatchObject({
        code: -32602,
      });
      const oldThreads = new Set(
        (await f.runtime.service.threads.list()).map((thread) => thread.thread_id),
      );
      const second = paused(await f.call("parallel"));
      const threads = await f.runtime.service.threads.list();
      await f.runtime.service.threads.delete(
        threads.find((thread) => !oldThreads.has(thread.thread_id))!.thread_id,
      );
      await expect(f.call("parallel", { requestState: second.requestState })).rejects.toMatchObject(
        { code: -32602 },
      );
    } finally {
      await f.client.close();
    }
  });
});
