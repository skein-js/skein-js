// Existing application configuration must keep the same meaning as streaming gains subgraphs.
import {
  Annotation,
  type CompiledGraph,
  type LangGraphRunnableConfig,
  StateGraph,
} from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { createFixtureDeps, createFixtureResolver } from "../__fixtures__/deps.js";
import { fixtureLangGraphAgent } from "../__fixtures__/lang-graph-binding.js";
import { createContext } from "../context.js";
import type { GraphSchemas } from "../deps.js";
import { createProtocolServiceFromContext } from "../service.js";

const ReportState = Annotation.Root({
  seen: Annotation<Record<string, unknown>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
});

async function harness(authenticated = false) {
  const factoryCalls: Array<Record<string, unknown> | undefined> = [];
  const compiled = new StateGraph(ReportState)
    .addNode("report", (_state, config: LangGraphRunnableConfig) => ({
      seen: config.configurable ?? {},
    }))
    .addEdge("__start__", "report")
    .addEdge("report", "__end__")
    .compile();
  const resolver = {
    ...createFixtureResolver(),
    ids: ["reporting"],
    load: async () => (config: { configurable?: Record<string, unknown> }) => {
      factoryCalls.push(config.configurable);
      return fixtureLangGraphAgent(compiled as unknown as CompiledGraph<string>);
    },
    schemas: async (): Promise<GraphSchemas> =>
      ({ reporting: { graph_id: "reporting" } }) as unknown as GraphSchemas,
  };
  const context = createContext(createFixtureDeps({ graphs: resolver }));
  if (authenticated)
    context.authUser = {
      identity: "alice",
      display_name: "Alice",
      is_authenticated: true,
      permissions: [],
    };
  const service = createProtocolServiceFromContext(context);
  await service.assistants.registerGraphAssistants();
  return { service, factoryCalls, context };
}

describe("run configuration compatibility", () => {
  it("keeps legacy assistant/graph keys and the same factory config on state reconstruction", async () => {
    const { service, factoryCalls } = await harness(true);
    const thread = await service.threads.create();
    const configurable = {
      assistant_id: "application-routing-id",
      graph_id: "application-graph-id",
      keep: "me",
    };
    const { result } = await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "reporting",
      input: {},
      config: {
        configurable: {
          ...configurable,
          thread_id: "spoof",
          run_id: "spoof",
          langgraph_auth_user_id: "spoof",
        },
      },
    });
    expect((result as { seen: unknown }).seen).toMatchObject({
      ...configurable,
      thread_id: thread.thread_id,
      langgraph_auth_user_id: "alice",
    });
    const expected = {
      ...configurable,
      langgraph_auth_user: {
        identity: "alice",
        display_name: "Alice",
        is_authenticated: true,
        permissions: [],
      },
      langgraph_auth_user_id: "alice",
      langgraph_auth_permissions: [],
    };
    await service.threads.getState(thread.thread_id);
    expect(factoryCalls[0]).toEqual(expected);
    expect(factoryCalls.at(-1)).toEqual(expected);
  });

  it("rebuilds a factory for a state read as the requester, never as whoever ran last", async () => {
    const { service, factoryCalls, context } = await harness(true);
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "reporting",
      input: {},
      config: { configurable: { keep: "me" } },
    });

    // Another principal reads the thread. The run's config shapes the graph; Alice does not.
    const bob = { identity: "bob", display_name: "Bob", is_authenticated: true, permissions: [] };
    const asBob = createProtocolServiceFromContext({
      ...context,
      authUser: bob,
      authScopes: ["read"],
    });
    await asBob.threads.getState(thread.thread_id);
    expect(factoryCalls.at(-1)).toEqual({
      keep: "me",
      langgraph_auth_user: bob,
      langgraph_auth_user_id: "bob",
      langgraph_auth_permissions: ["read"],
    });

    // And a read with no principal builds with none, rather than inheriting Alice's.
    const { authUser: _alice, authScopes: _aliceScopes, ...anonymousContext } = context;
    const anonymous = createProtocolServiceFromContext(anonymousContext);
    await anonymous.threads.getState(thread.thread_id);
    expect(factoryCalls.at(-1)).toEqual({ keep: "me" });
  });

  it("keeps empty unauthenticated factory configurable undefined on execution and state reads", async () => {
    const { service, factoryCalls } = await harness();
    const thread = await service.threads.create();
    await service.runs.createWait({
      thread_id: thread.thread_id,
      assistant_id: "reporting",
      input: {},
    });
    await service.threads.getState(thread.thread_id);
    expect(factoryCalls.length).toBeGreaterThanOrEqual(2);
    expect(factoryCalls.every((configurable) => configurable === undefined)).toBe(true);
  });
});
