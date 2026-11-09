import { createServer } from "node:http";
import { once } from "node:events";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createExpressServer } from "@skein-js/express";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedInMemoryGraphs } from "@skein-js/server-kit";
import { createDeepAgent, LangSmithSandbox } from "deepagents";
import { createAgent, humanInTheLoopMiddleware, tool } from "langchain";
import { expect, it } from "vitest";
import { z } from "zod";

import { FixtureModel } from "./fixture-model.mjs";

it("answers real upstream per-call review through the official modern MCP client", async () => {
  const sent = [];
  const send = tool(
    async ({ to }) => {
      sent.push(to);
      return "Sent";
    },
    { name: "send_email", description: "Send fixture email", schema: z.object({ to: z.string() }) },
  );
  const graph = createAgent({
    model: new FixtureModel([{ name: "send_email", args: { to: "original@example.com" } }]),
    tools: [send],
    middleware: [
      humanInTheLoopMiddleware({
        interruptMode: "per_call",
        interruptOn: { send_email: { allowedDecisions: ["approve", "edit", "reject"] } },
      }),
    ],
  });
  const server = await createExpressServer({ deps: embedInMemoryGraphs({ agent: graph }) });
  const listener = await server.listen(0, "127.0.0.1");
  const client = new Client(
    { name: "candidate-per-call", version: "1" },
    { versionNegotiation: { mode: "auto" }, capabilities: { elicitation: { form: {} } } },
  );
  let questions = 0;
  client.setRequestHandler("elicitation/create", () => {
    questions++;
    return { action: "accept", content: { decision: "edit", args: '{"to":"edited@example.com"}' } };
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.address().port}/mcp`)),
    );
    const result = await client.callTool({
      name: "agent",
      arguments: { messages: [{ role: "user", content: "Send it" }] },
    });
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(questions).toBe(1);
    expect(sent).toEqual(["edited@example.com"]);
  } finally {
    await client.close();
    await server.close();
  }
});

it("uses the upstream remote sandbox backend and leaves provisioning/disposal with its host", async () => {
  const requests = [];
  const provider = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push(JSON.parse(text));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ stdout: "REMOTE_SANDBOX_RESULT", stderr: "", exit_code: 0 }));
  }).listen(0, "127.0.0.1");
  await once(provider, "listening");
  let deleted = false;
  const sandbox = new LangSmithSandbox({
    sandbox: {
      name: "fixture-provider",
      run: async (command, options) => {
        const response = await fetch(`http://127.0.0.1:${provider.address().port}/execute`, {
          method: "POST",
          body: JSON.stringify({ command, options }),
        });
        return response.json();
      },
      delete: async () => {
        deleted = true;
      },
    },
  });
  const runtime = createProtocolRuntime(
    embedInMemoryGraphs({
      agent: createDeepAgent({
        model: new FixtureModel([{ name: "execute", args: { command: "fixture-command" } }]),
        backend: sandbox,
      }),
    }),
  );
  try {
    await runtime.service.assistants.registerGraphAssistants();
    const { result } = await runtime.service.runs.createWait({
      assistant_id: "agent",
      input: { messages: [{ role: "user", content: "Execute remotely" }] },
    });
    expect(result.__error__).toBeUndefined();
    expect(JSON.stringify(result.messages)).toContain("REMOTE_SANDBOX_RESULT");
    expect(requests).toEqual([{ command: "fixture-command", options: { timeout: 1800 } }]);
    await runtime.worker.stop();
    expect(deleted).toBe(false);
    await sandbox.close();
    expect(deleted).toBe(true);
  } finally {
    await runtime.worker.stop();
    provider.close();
    await once(provider, "close");
  }
});

it.skipIf(process.env["SKEIN_TEST_LIVE_SANDBOX"] !== "1")(
  "connects to an explicitly opted-in live LangSmith sandbox",
  async () => {
    const snapshotId = process.env["SKEIN_TEST_SANDBOX_SNAPSHOT"];
    if (!snapshotId) throw new Error("Set SKEIN_TEST_SANDBOX_SNAPSHOT for the opted-in live test.");
    const sandbox = await LangSmithSandbox.create({ snapshotId });
    try {
      expect(await sandbox.execute("printf SKEIN_LIVE_SANDBOX_OK")).toMatchObject({
        exitCode: 0,
        output: "SKEIN_LIVE_SANDBOX_OK",
      });
    } finally {
      await sandbox.close();
    }
  },
);
