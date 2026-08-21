// A form-encoded provider request reaching a channel route on Fastify.
//
// Fastify ships parsers for `application/json` and `text/plain` and nothing else, and an unmatched
// content type is `FST_ERR_CTP_INVALID_MEDIA_TYPE` — a **415 raised before any handler runs**. So a
// Twilio webhook (form-encoded) could not reach a skein channel on this adapter at all: not a
// misparse, an outright rejection at the transport. This pins the catch-all parser that fixes it, and
// the scoping that keeps it from changing anything else.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFastifyServer } from "./create-fastify-server.js";

let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function projectWithChannel(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skein-fastify-channel-"));
  await writeFile(
    path.join(dir, "graph.ts"),
    `import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
     export const graph = new StateGraph(MessagesAnnotation)
       .addNode("noop", () => ({ messages: [] }))
       .addEdge("__start__", "noop")
       .addEdge("noop", "__end__")
       .compile();`,
  );
  await writeFile(
    path.join(dir, "channel.ts"),
    `function safeJson(request) {
       try {
         return request.json();
       } catch {
         return undefined;
       }
     }
     export const channel = {
       name: "twilio",
       // Accepts either shape, the way a real channel would: form for Twilio, JSON for Slack.
       verify: (request) => {
         const id = request.form()["MessageSid"] ?? safeJson(request)?.MessageSid;
         return id ? { identity: "channel:twilio" } : false;
       },
       parseEvent: (request) => ({
         kind: "respond",
         status: 200,
         body: { seen: request.form(), raw: request.text() },
       }),
     };`,
  );
  const configPath = path.join(dir, "langgraph.json");
  await writeFile(
    configPath,
    JSON.stringify({
      graphs: { support: "./graph.ts:graph" },
      skein: { channels: { twilio: { path: "./channel.ts:channel", assistant: "support" } } },
    }),
  );
  return configPath;
}

describe("a form-encoded provider request over Fastify", () => {
  it("reaches the channel instead of being refused 415", async () => {
    const server = await createFastifyServer({ config: await projectWithChannel() });
    close = async () => {
      await server.runtime.worker.stop();
      await server.close();
    };

    const response = await server.app.inject({
      method: "POST",
      url: "/channels/twilio",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "From=whatsapp%3A%2B254&Body=hi&MessageSid=SM-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json() as unknown).toMatchObject({
      seen: { From: "whatsapp:+254", Body: "hi", MessageSid: "SM-1" },
    });
  });

  it("reaches a JSON-bodied channel with its bytes intact", async () => {
    // Slack, GitHub and Stripe all send JSON, and a more specific content-type parser always wins in
    // Fastify — so the catch-all above does not cover them. Without a carve-out they arrived parsed,
    // with nothing left to verify, and every genuine event answered 401. Only form-encoded providers
    // worked, which is precisely what the first test happened to cover.
    const server = await createFastifyServer({ config: await projectWithChannel() });
    close = async () => {
      await server.runtime.worker.stop();
      await server.close();
    };
    const payload = JSON.stringify({ MessageSid: "SM-9", From: "slack:U1", Body: "hi" });

    const response = await server.app.inject({
      method: "POST",
      url: "/channels/twilio",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(response.statusCode).toBe(200);
    // The channel read it as text and parsed it itself, byte for byte.
    expect((response.json() as { raw: string }).raw).toBe(payload);
  });

  it("leaves JSON routes parsing JSON", async () => {
    // The catch-all is less specific than the JSON parser, so it never takes a request the JSON
    // parser would have handled.
    const server = await createFastifyServer({ config: await projectWithChannel() });
    close = async () => {
      await server.runtime.worker.stop();
      await server.close();
    };

    const response = await server.app.inject({
      method: "POST",
      url: "/threads",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ metadata: { via: "test" } }),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { metadata: unknown }).metadata).toMatchObject({ via: "test" });
  });
});
