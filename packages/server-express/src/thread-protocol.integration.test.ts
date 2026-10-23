import { randomUUID } from "node:crypto";
import { createServer, request as proxyRequest } from "node:http";

import { AIMessage } from "@langchain/core/messages";
import { MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";
import { langGraphResolver } from "@skein-js/langgraph";
import { RedisRunQueue, RedisThreadEventBus } from "@skein-js/redis";
import { startRedis } from "@skein-js/test-support";
import { expect, it } from "vitest";

import { createEchoDeps, startEchoServer } from "./__fixtures__/echo-server.js";

it("reconnects the official SDK through another API instance while one queued graph executes", async () => {
  const redis = await startRedis();
  const firstBus = new RedisThreadEventBus(redis.url);
  const secondBus = new RedisThreadEventBus(redis.url);
  const queue = new RedisRunQueue(redis.url, { queueName: `protocol-${randomUUID()}` });
  let executions = 0;
  let release!: () => void;
  let started!: () => void;
  const executing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const graph = new StateGraph(MessagesAnnotation)
    .addNode("echo", async () => {
      executions++;
      started();
      await released;
      return { messages: [new AIMessage("one execution")] };
    })
    .addEdge("__start__", "echo")
    .addEdge("echo", "__end__")
    .compile();
  const shared = createEchoDeps();
  shared.queue = queue;
  shared.graphs = langGraphResolver({
    ids: ["echo"],
    load: async () => graph as never,
    schemas: async () => ({ echo: { graph_id: "echo" } }) as never,
  });
  const first = await startEchoServer({ deps: { ...shared, threadBus: firstBus } });
  const second = await startEchoServer({ deps: { ...shared, threadBus: secondBus } });
  let target = first.baseUrl;
  let replicaSubscriptions = 0;
  const proxy = createServer((incoming, outgoing) => {
    if (target === second.baseUrl && incoming.url?.endsWith("/stream/events"))
      replicaSubscriptions++;
    const upstream = proxyRequest(
      new URL(incoming.url ?? "/", target),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 500, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Expected a listening proxy");
  let connected!: () => void;
  const initialConnection = new Promise<void>((resolve) => {
    connected = resolve;
  });
  let reconnected!: () => void;
  const resumed = new Promise<void>((resolve) => {
    reconnected = resolve;
  });
  const client = new Client({ apiUrl: `http://127.0.0.1:${address.port}` });
  const stream = client.threads.stream({
    assistantId: "echo",
    onConnected: ({ kind }) => {
      if (kind === "reconnected") reconnected();
      else connected();
    },
  });
  try {
    await stream.run.start({ input: { messages: [{ role: "user", content: "once" }] } });
    await executing;
    await initialConnection;
    // Break the network stream at the load balancer; the SDK reconnects normally, with no fetch shim.
    target = second.baseUrl;
    proxy.closeAllConnections();
    await resumed;
    release();
    expect(
      ((await stream.output) as { messages: Array<{ content: string }> }).messages.at(-1)?.content,
    ).toBe("one execution");
    expect(replicaSubscriptions).toBeGreaterThan(0);
    expect(executions).toBe(1);
    expect(await client.runs.list(stream.threadId)).toHaveLength(1);
  } finally {
    release();
    await stream.close();
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await Promise.all([first.close(), second.close()]);
    await Promise.all([queue.dispose(), firstBus.dispose(), secondBus.dispose()]);
    await redis.stop();
  }
}, 60_000);
