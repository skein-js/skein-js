import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { isSkeinHttpError } from "@skein-js/core";
import { embedSqliteGraphs } from "@skein-js/local";

import { approvalGraph } from "./approval.js";
import { commandId, sqlitePath } from "./settings.js";

await mkdir(dirname(sqlitePath), { recursive: true });
const local = await embedSqliteGraphs({ approval: approvalGraph }, { sqlitePath });
const runtime = createProtocolRuntime(local.deps, { scheduler: { enabled: false } });
try {
  await runtime.service.assistants.registerGraphAssistants();
  const client = runtime.createNativeClient({
    sourceId: "embedded-example",
    allowedAssistants: ["approval"],
  });
  runtime.worker.start();
  // Re-running this process recovers this receipt, including after a process died after admission.
  const receipt = await client.start(
    { assistant_id: "approval", input: { request: "Publish the release notes" } },
    { idempotencyKey: commandId },
  );
  let run = await client.getRun(receipt.runId);
  while (run.status === "pending" || run.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 20));
    run = await client.getRun(receipt.runId);
  }
  let result: unknown;
  try {
    result = await client.getResult(receipt.runId);
  } catch (error) {
    if (!isSkeinHttpError(error) || error.code !== "run_result_unavailable") throw error;
    result = { unavailable: error.code };
  }
  console.log(JSON.stringify({ receipt, status: run.status, result }, null, 2));
  // Interrupted runs stay interrupted across restart. Answer through client.resume with their
  // exact current checkpoint. Abandoned running attempts fail without automatically replaying input.
} finally {
  await runtime.worker.stop();
  await local.dispose();
}
