// Wiring `skein.channels` into a running server.
//
// The two properties under test pull in opposite directions and both matter: a configured channel has
// to actually serve, and an unconfigured one has to leave *no trace at all* — no route, no import of
// `@skein-js/channels`, nothing a deployment could trip over. The second is what "entirely optional"
// means in practice, and it is easy to lose to a stray static import.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Auth } from "@langchain/langgraph-sdk/auth";
import { afterAll, describe, expect, it } from "vitest";

import { resolveProtocolRuntime } from "./resolve-runtime.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A throwaway project with one graph, plus whatever `langgraph.json` extras a case needs. */
async function project(extra: Record<string, unknown>, channelSource?: string): Promise<string> {
  // Inside the workspace rather than in `os.tmpdir()`, because a fixture that declares an
  // `auth.path` has to be able to `import "@langchain/langgraph-sdk/auth"` — and node resolution
  // only finds it by walking up to the repo's `node_modules`.
  const dir = await mkdtemp(path.join(process.cwd(), ".tmp-channels-"));
  created.push(dir);
  await writeFile(
    path.join(dir, "graph.ts"),
    `import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
     export const graph = new StateGraph(MessagesAnnotation)
       .addNode("noop", () => ({ messages: [] }))
       .addEdge("__start__", "noop")
       .addEdge("noop", "__end__")
       .compile();`,
  );
  if (channelSource) await writeFile(path.join(dir, "channel.ts"), channelSource);
  const configPath = path.join(dir, "langgraph.json");
  await writeFile(
    configPath,
    JSON.stringify({ graphs: { support: "./graph.ts:graph" }, ...extra }, null, 2),
  );
  return configPath;
}

const echoChannel = `
export const channel = {
  name: "twilio",
  verify: (request) =>
    request.headers["x-secret"] === "shh" ? { identity: "channel:twilio:+254" } : false,
  parseEvent: (request) => ({
    kind: "event",
    event: {
      threadKey: request.form()["From"],
      idempotencyKey: request.form()["MessageSid"],
      input: { messages: [{ role: "human", content: request.form()["Body"] }] },
    },
  }),
};
`;

describe("a configured channel", () => {
  it("adds its route to the table", async () => {
    const configPath = await project(
      { skein: { channels: { twilio: { path: "./channel.ts:channel", assistant: "support" } } } },
      echoChannel,
    );

    const resolved = await resolveProtocolRuntime({ config: configPath });

    expect(resolved.routes).toContainEqual({
      method: "post",
      path: "/channels/twilio",
      handler: "handleInboundEvent",
      // A provider's request is frequently not JSON, and its signature covers the bytes as sent — so
      // the binding asks the adapter for the body as text rather than parsed.
      retainRawBody: true,
    });
  });

  it("carries no route group, so no `http.disable_*` flag has to exist for it", async () => {
    // A `RouteGroup` is a member of a closed union that can never be withdrawn, and it would need a
    // skein-only disable flag in the un-namespaced `http` block to go with it.
    const configPath = await project(
      { skein: { channels: { twilio: { path: "./channel.ts:channel", assistant: "support" } } } },
      echoChannel,
    );

    const resolved = await resolveProtocolRuntime({ config: configPath });
    const channelRoute = resolved.routes.find((route) => route.path === "/channels/twilio");

    expect(channelRoute).not.toHaveProperty("group");
  });

  it("serves an inbound event end to end", async () => {
    const configPath = await project(
      { skein: { channels: { twilio: { path: "./channel.ts:channel", assistant: "support" } } } },
      echoChannel,
    );
    const resolved = await resolveProtocolRuntime({ config: configPath });

    const response = await resolved.runtime.handlers.handleInboundEvent({
      method: "POST",
      url: "http://127.0.0.1:2024/channels/twilio",
      headers: { "x-secret": "shh", "content-type": "application/x-www-form-urlencoded" },
      body: "From=whatsapp%3A%2B254&Body=hi&MessageSid=SM-1",
      params: {},
      query: {},
    });

    expect(response.status).toBe(202);
    // And the run really exists — the ack is not a stub.
    const threads = await resolved.runtime.service.threads.search({});
    expect(threads).toHaveLength(1);
  });

  it("refuses a request the channel does not verify", async () => {
    const configPath = await project(
      { skein: { channels: { twilio: { path: "./channel.ts:channel", assistant: "support" } } } },
      echoChannel,
    );
    const resolved = await resolveProtocolRuntime({ config: configPath });

    const response = await resolved.runtime.handlers.handleInboundEvent({
      method: "POST",
      url: "http://127.0.0.1:2024/channels/twilio",
      headers: {},
      body: "From=whatsapp%3A%2B254&Body=hi&MessageSid=SM-1",
      params: {},
      query: {},
    });

    expect(response.status).toBe(401);
    expect(await resolved.runtime.service.threads.search({})).toHaveLength(0);
  });

  it("fails at boot when `assistant` names no graph", async () => {
    // Not at the first event. Discovering this when a customer texts is the failure it prevents.
    const configPath = await project(
      { skein: { channels: { twilio: { path: "./channel.ts:channel", assistant: "suport" } } } },
      echoChannel,
    );

    await expect(resolveProtocolRuntime({ config: configPath })).rejects.toThrow(
      /not one of this deployment's graphs/,
    );
  });
});

describe("authorization scopes the request it authorized", () => {
  // The finding this pins: the pipeline built an `AuthContext`, authorized against it, and then
  // dropped both the context and the ownership filters — so channel threads and runs were created
  // **unscoped**, and the graph never saw `configurable.langgraph_auth_user`. The docs promised the
  // opposite. Nothing type-checked it, because the pipeline reaches server-kit across an
  // `unknown`-typed dynamic-import boundary.
  /**
   * An `Auth` whose `@auth.on.threads` handler returns ownership filters.
   *
   * Injected through the runtime's own importer seam rather than written to disk: the fixture project
   * lives outside any `node_modules` that resolves `@langchain/langgraph-sdk`, and the seam is there
   * precisely so a caller can supply modules it already holds.
   */
  const withOwnershipAuth = async () => {
    const configPath = await project(
      {
        auth: { path: "./auth.ts:auth" },
        skein: { channels: { twilio: { path: "./channel.ts:channel", assistant: "support" } } },
      },
      echoChannel,
    );
    const auth = new Auth()
      .authenticate(() => ({ identity: "unused-by-channels", permissions: [] }))
      .on("threads", ({ user }) => ({ owner: user.identity }));
    const configDir = path.dirname(configPath);
    return resolveProtocolRuntime({
      config: configPath,
      importModule: async (sourceFile: string) =>
        sourceFile === path.join(configDir, "auth.ts")
          ? { auth }
          : ((await import(pathToFileURL(sourceFile).href)) as Record<string, unknown>),
    });
  };

  const deliver = (resolved: Awaited<ReturnType<typeof resolveProtocolRuntime>>) =>
    resolved.runtime.handlers.handleInboundEvent({
      method: "POST",
      url: "http://127.0.0.1:2024/channels/twilio",
      headers: { "x-secret": "shh", "content-type": "application/x-www-form-urlencoded" },
      body: "From=whatsapp%3A%2B254&Body=hi&MessageSid=SM-1",
      params: {},
      query: {},
    });

  it("stamps the handler's ownership filters onto the thread", async () => {
    // Without this the thread exists but no filtered read can match it — the caller's own
    // conversation becomes invisible to the caller, which is worse than no scoping at all.
    const resolved = await withOwnershipAuth();

    const response = await deliver(resolved);

    expect(response.status).toBe(202);
    const [thread] = await resolved.runtime.service.threads.search({});
    // `owner` comes from the `@auth.on.threads` handler, keyed on the principal the *channel*
    // verified — not on any header the caller could have set.
    expect(thread?.metadata).toMatchObject({ owner: "channel:twilio:+254" });
  });

  it("runs as the principal the channel verified", async () => {
    const resolved = await withOwnershipAuth();

    await deliver(resolved);

    const [thread] = await resolved.runtime.service.threads.search({});
    const [run] = await resolved.runtime.service.runs.listByThread(thread!.thread_id);
    // The same ownership filters stamp the run, which is what a later filtered read matches on — and
    // the run is created through a context carrying the principal, so the graph sees it as
    // `configurable.langgraph_auth_user`.
    expect(run?.metadata).toMatchObject({ owner: "channel:twilio:+254" });
  });
});

describe("no configured channel", () => {
  it("adds no route", async () => {
    const configPath = await project({});

    const resolved = await resolveProtocolRuntime({ config: configPath });

    expect(resolved.routes.some((route) => route.path.startsWith("/channels/"))).toBe(false);
  });

  it("answers 404 if something dispatches into the handler anyway", async () => {
    // The table has no binding, so this is only reachable via a stale route list — which should read
    // as "this path does not exist here", not as "not implemented yet".
    const configPath = await project({});
    const resolved = await resolveProtocolRuntime({ config: configPath });

    await expect(
      resolved.runtime.handlers.handleInboundEvent({
        method: "POST",
        url: "http://127.0.0.1:2024/channels/twilio",
        headers: {},
        body: undefined,
        params: {},
        query: {},
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
