// A provider's request reaching a channel route over real HTTP.
//
// The trap this pins is mount order, and it fails *silently*: `skeinRouter` installs `express.json()`
// with `router.use`, which consumes the stream for **every** request routed into it — not only the
// ones whose content type it matches. A body parser registered after that finds nothing left, so a
// channel would see an empty body, fail to verify a signature it cannot compute, and answer 401 for a
// request that was perfectly valid. Nothing about that reads as a mount-order problem from the
// outside, which is why it is worth a test rather than a doc note.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createExpressServer, type SkeinExpressServer } from "./create-express-server.js";

let running: { server: SkeinExpressServer; close: () => Promise<void> } | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** A project whose channel echoes back exactly what it was handed, so the test can see the body. */
async function projectWithChannel(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skein-express-channel-"));
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
    `export const channel = {
       name: "twilio",
       // Verification is what actually depends on the body surviving: this one refuses unless it can
       // read a field out of the form, exactly as a signature check would need the bytes.
       verify: (request) =>
         request.form()["MessageSid"] ? { identity: "channel:twilio:" + request.form()["From"] } : false,
       parseEvent: (request) => ({
         kind: "respond",
         status: 200,
         body: { seen: request.form(), text: request.text() },
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

async function start(configPath: string): Promise<string> {
  const server = await createExpressServer({ config: configPath });
  const httpServer = await server.listen(0, "127.0.0.1");
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  running = {
    server,
    close: async () => {
      await server.runtime.worker.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
  return `http://127.0.0.1:${address.port}`;
}

describe("a form-encoded provider request over Express", () => {
  it("reaches the channel with its body intact", async () => {
    const base = await start(await projectWithChannel());

    const response = await fetch(`${base}/channels/twilio`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "From=whatsapp%3A%2B254712345678&Body=I+want+a+refund&MessageSid=SM-1",
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      seen: { From: "whatsapp:+254712345678", Body: "I want a refund", MessageSid: "SM-1" },
      text: "From=whatsapp%3A%2B254712345678&Body=I+want+a+refund&MessageSid=SM-1",
    });
  });

  it("hands over the bytes as sent, not a re-serialization", async () => {
    // A signature covers the exact bytes. `JSON.stringify(req.body)` does not reproduce them — key
    // order, whitespace and number formatting are not guaranteed to round-trip — so a channel that
    // verified a re-serialized body would refuse every genuine request.
    const base = await start(await projectWithChannel());
    const body = "MessageSid=SM-2&Body=%E2%9C%93+unicode+%26+symbols&From=x";

    const response = await fetch(`${base}/channels/twilio`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });

    expect(((await response.json()) as { text: string }).text).toBe(body);
  });

  it("still refuses a request the channel cannot verify", async () => {
    const base = await start(await projectWithChannel());

    const response = await fetch(`${base}/channels/twilio`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "From=x",
    });

    expect(response.status).toBe(401);
  });

  it("leaves ordinary JSON routes parsing JSON", async () => {
    // The regression that would matter most: the text parser is scoped to routes that asked for it,
    // so every other route on the server behaves exactly as before.
    const base = await start(await projectWithChannel());

    const response = await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata: { via: "test" } }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { metadata: unknown }).metadata).toMatchObject({
      via: "test",
    });
  });
});
