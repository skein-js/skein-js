import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { FakeStreamingChatModel } from "@langchain/core/utils/testing";
import { interrupt, MemorySaver, MessagesAnnotation, StateGraph } from "@langchain/langgraph";
import { createExpressServer } from "@skein-js/express";
import { cloneLangGraphCheckpoint, langGraphResolver, SkeinBaseStore } from "@skein-js/langgraph";
import {
  MemoryRunEventBus,
  MemoryRunQueue,
  MemorySkeinStore,
  MemoryThreadEventBus,
} from "@skein-js/storage-memory";

type Resolver = Parameters<typeof langGraphResolver>[0];
function buildGraph(kind: string) {
  return new StateGraph(MessagesAnnotation)
    .addNode("research", () => ({
      messages: [
        new AIMessage({
          content: "I'll check the library.",
          tool_calls: [
            { id: "library-call", name: "search_library", args: { query: "agent runtimes" } },
          ],
        }),
      ],
    }))
    .addNode("search_library", () => ({
      messages: [
        new ToolMessage({
          tool_call_id: "library-call",
          name: "search_library",
          content: "Found three relevant documents.",
        }),
      ],
    }))
    .addNode("answer", async (state, config) => {
      if (kind === "failure")
        throw new Error("The document source is unavailable. Try another source.");
      if (kind === "slow") await pause(1500, undefined, { signal: config.signal });
      if (kind === "approval") {
        const response = interrupt({
          question: "Edit the proposed document title",
          expected: { title: "Your title" },
        });
        return { messages: [new AIMessage(`Saved title: ${JSON.stringify(response)}`)] };
      }
      const model = new FakeStreamingChatModel({
        responses: [
          new AIMessage(
            "## Research complete\n\nFound **three documents** about durable agent runtimes.\n\n1. Inspect a run\n2. Review its checkpoints\n3. Continue the thread",
          ),
        ],
        sleep: 2,
      });
      const response = await model.invoke(state.messages, config);
      return { messages: [response] };
    })
    .addEdge("__start__", "research")
    .addEdge("research", "search_library")
    .addEdge("search_library", "answer")
    .addEdge("answer", "__end__")
    .compile();
}
export async function startConsoleFixture(mountPath = "/console") {
  const ids = ["research", "approval", "failure", "slow"];
  const graphs = new Map(ids.map((id) => [id, buildGraph(id)]));
  const input = {
    type: "object",
    properties: { messages: { type: "array", items: { type: "object" } } },
  };
  const resolver: Resolver = {
    ids,
    load: async (id) => {
      const graph = graphs.get(id);
      if (!graph) throw new Error(`Unknown fixture graph ${id}`);
      return graph as unknown as Awaited<ReturnType<Resolver["load"]>>;
    },
    schemas: async (id) =>
      ({
        [id]: { input, state: input, output: input, config: { type: "object" } },
      }) as unknown as Awaited<ReturnType<Resolver["schemas"]>>,
  };
  const store = new MemorySkeinStore({ maxPageSize: 3 });
  const server = await createExpressServer({
    scheduler: { enabled: false },
    deps: {
      store,
      graphs: langGraphResolver(resolver),
      queue: new MemoryRunQueue(),
      bus: new MemoryRunEventBus(),
      threadBus: new MemoryThreadEventBus(),
      checkpointer: new MemorySaver(),
      storeBridge: (repo) => new SkeinBaseStore(repo),
      ephemeralCheckpointer: () => new MemorySaver(),
      cloneCheckpoint: cloneLangGraphCheckpoint,
    },
  });
  const assetRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  server.app.use(async (req, res, next) => {
    if (req.path === mountPath) return res.redirect(302, `${mountPath}/`);
    if (!req.path.startsWith(`${mountPath}/`)) return next();
    const asset = resolve(assetRoot, req.path.slice(mountPath.length + 1) || "index.html");
    if (!asset.startsWith(assetRoot + sep)) return res.sendStatus(404);
    try {
      res.type(extname(asset));
      return res.send(await readFile(asset));
    } catch {
      return res.sendStatus(404);
    }
  });
  const listener = await server.listen(0, "127.0.0.1");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return {
    server,
    store,
    url: `http://127.0.0.1:${address.port}`,
    mountPath,
    close: () => server.close(),
  };
}
