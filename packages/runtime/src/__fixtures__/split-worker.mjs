import process from "node:process";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedPostgresGraphs } from "@skein-js/runtime";

import { buildSplitGraph } from "./split-graph.ts";

const embedded = await embedPostgresGraphs({ split: buildSplitGraph() });
const runtime = createProtocolRuntime(embedded.deps, { worker: { shutdownGraceMs: 50 } });
await runtime.service.assistants.registerGraphAssistants();
runtime.worker.start();
process.send?.("ready");
process.on("message", async (message) => {
  if (typeof message === "object" && message?.cancel) {
    await runtime.service.runs.cancel(message.cancel);
    return;
  }
  if (message !== "stop") return;
  await runtime.worker.stop();
  await embedded.dispose();
  process.send?.("stopped");
  process.disconnect();
});
