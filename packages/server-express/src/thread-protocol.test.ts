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
  it("returns extracted values inside the SDK envelope without replacing thread identity", async () => {
    running = await startEchoServer();
    const client = new Client({ apiUrl: running.baseUrl });
    const thread = await client.threads.create({ metadata: { title: "extracted label" } });
    const results = await client.threads.search({
      select: ["thread_id"],
      extract: { label: "metadata.title", thread_id: "metadata.title" },
    });
    expect(results).toEqual([
      {
        thread_id: thread.thread_id,
        extracted: { label: "extracted label", thread_id: "extracted label" },
      },
    ]);
    expect(results[0]?.extracted?.["label"]).toBe("extracted label");
  });

  it("replays official lifecycle and state categories and reconnects across later runs", async () => {
    running = await startEchoServer();
    const client = new Client({ apiUrl: running.baseUrl });
    const thread = await client.threads.create();
    const run = (turn: number) =>
      client.runs.wait(thread.thread_id, "echo", {
        input: { messages: [{ role: "user", content: `category ${turn}` }] },
      });
    await run(1);
    await run(2);
    let cursor: string | undefined;
    for (const turns of [[1, 2], [3]]) {
      const controller = new AbortController();
      const iterator = client.threads
        .joinStream(thread.thread_id, {
          streamMode: ["lifecycle", "state_update"],
          lastEventId: cursor ?? "0",
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();
      try {
        if (cursor) {
          const before = (await client.runs.list(thread.thread_id)).length;
          const reading = iterator.next();
          await run(3);
          const started = (await reading).value;
          expect(started).toMatchObject({ event: "metadata", data: { attempt: 1 } });
          expect((await iterator.next()).value).toMatchObject({
            event: "metadata",
            data: { run_id: started.data.run_id, status: "run_done" },
          });
          const state = (await iterator.next()).value;
          expect(state).toMatchObject({
            event: "state_update",
            data: {
              thread_id: thread.thread_id,
              state: { checkpoint: { thread_id: thread.thread_id } },
            },
          });
          expect(state.data.state.values.messages.at(-1).content).toBe("echo: category 3");
          expect(await client.runs.list(thread.thread_id)).toHaveLength(before + 1);
        } else {
          for (const turn of turns) {
            const started = (await iterator.next()).value;
            const done = (await iterator.next()).value;
            const state = (await iterator.next()).value;
            expect(started).toMatchObject({ event: "metadata", data: { attempt: 1 } });
            expect(done).toMatchObject({
              event: "metadata",
              data: { run_id: started.data.run_id, status: "run_done" },
            });
            expect(state.event).toBe("state_update");
            expect(state.data.state.values.messages.at(-1).content).toBe(`echo: category ${turn}`);
            cursor = state.id;
          }
        }
      } finally {
        controller.abort();
        await iterator.return(undefined).catch(() => undefined);
      }
    }
  }, 15_000);

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

  it("follows later turns through threads.joinStream without replaying earlier runs", async () => {
    running = await startEchoServer();
    const client = new Client({ apiUrl: running.baseUrl });
    const thread = await client.threads.create();
    const takeTurn = (turn: number) =>
      client.runs.wait(thread.thread_id, "echo", {
        input: { messages: [{ role: "user", content: `turn ${turn}` }] },
      });
    await takeTurn(1);

    const controller = new AbortController();
    const events = client.threads
      .joinStream(thread.thread_id, { streamMode: "run_modes", signal: controller.signal })
      [Symbol.asyncIterator]();
    try {
      const firstEvent = events.next();
      // The SDK hides the subscription acknowledgement, so keep taking turns until the stream is live.
      let received: Awaited<typeof firstEvent> | undefined;
      for (let turn = 2; turn <= 6 && !received; turn++) {
        await takeTurn(turn);
        received = await Promise.race([
          firstEvent,
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
        ]);
      }
      expect(received?.done).toBe(false);
      let event = received!.value;
      while (event.event !== "values") event = (await events.next()).value;
      // Turn 1's frames hold at most two messages; anything later carries its history plus a new turn.
      const { messages } = event.data as { messages: unknown[] };
      expect(messages.length).toBeGreaterThanOrEqual(3);
    } finally {
      controller.abort();
      await events.return?.(undefined).catch(() => undefined);
    }
  }, 15_000);

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
