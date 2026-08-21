// Wiring `skein.channels` into a running server.
//
// The two properties under test pull in opposite directions and both matter: a configured channel has
// to actually serve, and an unconfigured one has to leave *no trace at all* — no route, no import of
// `@skein-js/channels`, nothing a deployment could trip over. The second is what "entirely optional"
// means in practice, and it is easy to lose to a stray static import.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveProtocolRuntime } from "./resolve-runtime.js";

/** A throwaway project with one graph, plus whatever `langgraph.json` extras a case needs. */
async function project(extra: Record<string, unknown>, channelSource?: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skein-channels-"));
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
