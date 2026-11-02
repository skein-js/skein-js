# Testing your project

Use the [console](./console.md) to explore your graph, then save important cases as automated tests.
Test graph behavior directly and use a separate smoke test to check that your application can call
the running skein-js server.

## Run the generated tests

A scaffolded project includes Vitest and `src/echo-graph.test.ts`. From that project's directory:

```bash
npm test
```

The keyless echo tests should pass without starting a server or configuring a model. Run them after
editing the graph. A failure should show which expected output changed.

If your project uses pnpm, Yarn, or Nx, use its existing test command. The commands used to develop
the skein-js repository are not prerequisites for testing your own application.

## Assert graph behavior

The generated test invokes the exported graph and checks its result:

```ts
// src/echo-graph.test.ts
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { graph } from "./echo-graph.js";

describe("echo graph", () => {
  it("echoes the last human message", async () => {
    const result = await graph.invoke({ messages: [new HumanMessage("hello")] });
    expect(result.messages.at(-1)?.content).toBe("echo: hello");
  });

  it("handles an empty conversation", async () => {
    const result = await graph.invoke({ messages: [] });
    expect(result.messages.at(-1)?.content).toBe("echo: ");
  });
});
```

Adapt the input and assertions to your graph's contract: required structured fields, routing choices,
tool arguments, expected failures, and state changes. Keep routine tests deterministic by supplying
controlled model/tool responses through your graph's existing dependencies. Test live providers
separately so credentials, network availability, and model variation do not determine every test run.

Choose assertions from the promise your application makes:

| Real-world case                       | Useful assertion                                                     |
| ------------------------------------- | -------------------------------------------------------------------- |
| A customer reports a duplicate charge | The ticket is routed to billing with the correct order reference     |
| A reviewer rejects a proposed refund  | The refund tool is not called                                        |
| A user says “use Celsius”             | The preference is written to the intended user's memory namespace    |
| An order service is unavailable       | The agent reports the failure without claiming the order was updated |

For model-backed output, assert the decision, structured fields, or tool effect you need rather than
one exact sentence. Keep exact text assertions for deterministic behavior such as the echo graph.

A direct graph test checks your graph logic. It does not check server configuration, authentication,
SDK calls, or deployment persistence.

## Check the running server

Use this smoke test in a scaffolded project to check the entire request path. It requires the
registered **echo** graph. For another project, change the Assistant ID, input, and expected result.

Install the standard client if your project does not already declare it:

```bash
npm install @langchain/langgraph-sdk
```

Save this as `src/server-smoke.test.ts`. It runs only when `SKEIN_TEST_API_URL` is set, so ordinary
`npm test` still works without a server:

```ts
import { Client } from "@langchain/langgraph-sdk";
import { expect, it } from "vitest";

const apiUrl = process.env.SKEIN_TEST_API_URL;

it.skipIf(!apiUrl)(
  "serves the echo graph",
  async () => {
    const client = new Client({
      apiUrl,
      apiKey: process.env.SKEIN_TEST_API_KEY,
    });
    const thread = await client.threads.create();

    try {
      const result = await client.runs.wait(thread.thread_id, "echo", {
        input: { messages: [{ role: "user", content: "hello" }] },
      });
      expect(result).toMatchObject({
        messages: [
          expect.objectContaining({ content: "hello" }),
          expect.objectContaining({ content: "echo: hello" }),
        ],
      });

      const state = await client.threads.getState(thread.thread_id);
      expect(state.values).toEqual(result);
    } finally {
      await client.threads.delete(thread.thread_id);
    }
  },
  30_000,
);
```

Start `npm run dev` in one terminal. In another, run the smoke test against the server's API URL:

```bash
# macOS / Linux
SKEIN_TEST_API_URL=http://localhost:2024 npm test -- src/server-smoke.test.ts
```

```powershell
# PowerShell
$env:SKEIN_TEST_API_URL = "http://localhost:2024"
npm test -- src/server-smoke.test.ts
```

Expect **one passing smoke test**, rather than a skipped test. It creates a thread, checks both the
run result and saved state, and deletes its thread afterward. Use a test server and test credentials;
your authentication policy must allow those operations. Set `SKEIN_TEST_API_KEY` if required.

If it fails, check the API URL, graph registration, input schema, permissions, and server logs. A
successful `/ok` response establishes liveness, but it does not establish that your graph can run.

## Check state across turns and restarts

When your application relies on persistence:

1. Run two turns on the same thread and assert that the second sees the first turn's state.
2. Use a new thread and check that conversation state starts fresh.
3. With your intended storage configuration, stop and restart the server, then read the original
   thread and its checkpoints. Compare with the values recorded before stopping.
4. If you use long-term memory, read the saved item from another thread in the same authorized
   namespace.

The smoke test above deletes its thread; use a separate fixture for a restart test and clean it up
once verification finishes. For durable deployment, test [SQLite](./local-deployment.md) or
[Postgres](./storage.md) as configured in your application. `skein dev` restores development snapshots;
that is different from proving a production deployment's durability. SQLite marks abandoned attempts
as failures and leaves recovery decisions to your application.

## Check interrupt and resume

If your graph calls `interrupt()`, use a fresh test thread to reach that pause, assert the requested
value, and resume with the response your graph expects. Verify both approval and rejection paths on
separate threads. See the [interrupt/resume example](./human-in-the-loop.md#resume-it) for the SDK calls.

Check that reopening the conversation does not execute the paused action, and that resuming performs
the intended action only when authorized. Use controlled tools or test destinations for side effects.

## Before you ship

Run graph tests on each change, the server smoke test against your built application, and the
[deployment verification](./deploy.md#verify-a-deployment) against your test deployment. Keep live-model
quality checks separate from these functional checks; use your evaluation tooling for variable
model output.
