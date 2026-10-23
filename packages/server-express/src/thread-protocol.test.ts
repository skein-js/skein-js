import { Client } from "@langchain/langgraph-sdk";
import { afterEach, describe, expect, it } from "vitest";

import { startEchoServer, type RunningServer } from "./__fixtures__/echo-server.js";

let running: RunningServer | undefined;
const streams: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(streams.splice(0).map((stream) => stream.close()));
  await running?.close();
  running = undefined;
});

describe("official thread protocol SDK", () => {
  it("starts one queued execution, restores it, and submits a second turn", async () => {
    running = await startEchoServer();
    const client = new Client({ apiUrl: running.baseUrl });
    const stream = client.threads.stream({ assistantId: "echo" });
    streams.push(stream);
    await stream.run.start({ input: { messages: [{ role: "user", content: "first" }] } });
    const output = (await stream.output) as { messages: Array<{ content: string }> };
    expect(output.messages.at(-1)?.content).toBe("echo: first");
    const threadId = stream.threadId;
    expect(await client.runs.list(threadId)).toHaveLength(1);
    await stream.close();

    const restored = client.threads.stream(threadId, { assistantId: "echo" });
    streams.push(restored);
    expect((await client.threads.getState(threadId)).values).toMatchObject({
      messages: expect.any(Array),
    });
    expect(await client.runs.list(threadId)).toHaveLength(1);
    await restored.run.start({ input: { messages: [{ role: "user", content: "second" }] } });
    expect(
      ((await restored.output) as { messages: Array<{ content: string }> }).messages.at(-1)
        ?.content,
    ).toBe("echo: second");
    expect(await client.runs.list(threadId)).toHaveLength(2);
  }, 15_000);

  it("subscribes before a run exists and reopening does not start runs", async () => {
    running = await startEchoServer();
    const client = new Client({ apiUrl: running.baseUrl });
    const thread = await client.threads.create();
    for (let i = 0; i < 2; i++) {
      const controller = new AbortController();
      const response = await fetch(`${running.baseUrl}/threads/${thread.thread_id}/stream/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channels: ["values", "lifecycle"] }),
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      controller.abort();
    }
    expect(await client.runs.list(thread.thread_id)).toHaveLength(0);
  });

  it("interrupts and resumes using the official input response command", async () => {
    running = await startEchoServer();
    const client = new Client({ apiUrl: running.baseUrl });
    const stream = client.threads.stream({ assistantId: "hitl" });
    streams.push(stream);
    await stream.run.start({ input: { messages: [{ role: "user", content: "approve" }] } });
    await stream.output;
    const state = await client.threads.getState(stream.threadId);
    const interrupt = state.tasks.flatMap((task) => task.interrupts ?? [])[0];
    expect(interrupt?.id).toBeTruthy();
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = stream.onEvent((event) => {
        if (
          event.method === "lifecycle" &&
          event.params.namespace.length === 0 &&
          event.params.data.event === "completed"
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
    await stream.input.respond({ namespace: [], interrupt_id: interrupt!.id!, response: "yes" });
    await completed;
    const resumed = await client.threads.getState(stream.threadId);
    expect(
      (resumed.values as { messages: Array<{ content: string }> }).messages.at(-1)?.content,
    ).toBe("approved: yes");
  }, 15_000);
});
