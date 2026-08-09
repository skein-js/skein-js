// End-to-end proof that human-in-the-loop resume survives the runtime split, over real HTTP.
//
// This is the one path where a break is **silent**. The engine no longer constructs a LangGraph
// `Command` — doing so is a runtime import of `@langchain/langgraph`, which is exactly what would put
// a graph runtime back into `@skein-js/agent-protocol`'s install. Instead it emits a branded envelope
// and `@skein-js/langgraph` translates it back (`langGraphResolver` → `langGraphAgent`). If any link
// in that chain is missing, LangGraph receives an object it does not recognise as a command, treats it
// as ordinary input, and the interrupted run simply *is not resumed*: `POST /runs/wait` still returns
// 200, the thread still reports a status, and only the values are quietly wrong.
//
// Nothing else covers it end to end. `@skein-js/langgraph` unit-tests the translation, and
// `@skein-js/agent-protocol` tests interrupt/resume against a fixture *duplicate* of that translation
// (it cannot depend on the binding — the Nx graph would be circular). So both sides can pass while the
// wiring between them is broken. This test is the join.

import { afterEach, describe, expect, it } from "vitest";

import { startEchoServer, type RunningServer } from "./__fixtures__/echo-server.js";

const jsonHeaders = { "content-type": "application/json" };

let running: RunningServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function createThread(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/threads`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { thread_id: string }).thread_id;
}

async function runWait(baseUrl: string, threadId: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}/threads/${threadId}/runs/wait`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("human-in-the-loop over HTTP", () => {
  it("interrupts, then resumes with the value the client sent", async () => {
    running = await startEchoServer();
    const threadId = await createThread(running.baseUrl);

    // First turn: the graph calls `interrupt()` and the run stops.
    await runWait(running.baseUrl, threadId, {
      assistant_id: "hitl",
      input: { messages: [{ role: "user", content: "please" }] },
    });

    const paused = (await (await fetch(`${running.baseUrl}/threads/${threadId}`)).json()) as {
      status: string;
      interrupts?: Record<string, unknown[]>;
    };
    expect(paused.status).toBe("interrupted");
    expect(Object.keys(paused.interrupts ?? {})).not.toHaveLength(0);

    // Second turn: `command.resume` has to reach `interrupt()`'s return value. This is the assertion
    // the whole envelope→Command chain exists to satisfy — and the one that fails *silently* when it
    // breaks, because the run below still returns 200 either way.
    const resumed = (await runWait(running.baseUrl, threadId, {
      assistant_id: "hitl",
      command: { resume: "yes" },
    })) as { messages?: { content?: unknown }[] };

    expect(resumed.messages?.at(-1)?.content).toBe("approved: yes");

    const settled = (await (await fetch(`${running.baseUrl}/threads/${threadId}`)).json()) as {
      status: string;
    };
    expect(settled.status).toBe("idle");
  });

  // The regression a reviewer caught: the binding used to pick `resume`/`update`/`goto` off the
  // envelope and drop everything else, so `command.graph` — which selects a subgraph — vanished on the
  // way through. Asserted here rather than only in the binding's unit test, because it is the wire
  // contract (`command` is `.passthrough()`) that makes dropping a field wrong.
  it("carries a command's unlisted fields through to the graph", async () => {
    running = await startEchoServer();
    const threadId = await createThread(running.baseUrl);

    await runWait(running.baseUrl, threadId, {
      assistant_id: "hitl",
      input: { messages: [{ role: "user", content: "please" }] },
    });

    // `graph: ""` names the root graph, so this is a resume that also exercises the passthrough field.
    const resumed = (await runWait(running.baseUrl, threadId, {
      assistant_id: "hitl",
      command: { resume: "ok", graph: "" },
    })) as { messages?: { content?: unknown }[] };

    expect(resumed.messages?.at(-1)?.content).toBe("approved: ok");
  });
});
