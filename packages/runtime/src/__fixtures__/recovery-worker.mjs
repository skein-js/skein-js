import process from "node:process";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedPostgresGraphs } from "@skein-js/runtime";

import { buildRecoveryGraph } from "./recovery-graph.ts";

const graph = buildRecoveryGraph(
  () => embedded.deps,
  async () => {
    process.send?.("checkpointed");
    await new Promise(() => {});
  },
);
const embedded = await embedPostgresGraphs({ recovery: graph });
const runtime = createProtocolRuntime(embedded.deps, { scheduler: { enabled: false } });
runtime.worker.start();
