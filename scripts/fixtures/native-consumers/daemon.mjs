import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { Annotation, StateGraph } from "@langchain/langgraph";
import { embedSqliteGraphs } from "@skein-js/local";
import { createProtocolRuntime } from "@skein-js/agent-protocol";

let executions = 0;
const graph = new StateGraph(Annotation.Root({ answer: Annotation() }))
  .addNode("work", async () => {
    executions++;
    if (process.argv[2] === "child") {
      process.send({ executing: true });
      await new Promise(() => {});
    }
    return { answer: "done" };
  })
  .addEdge("__start__", "work")
  .addEdge("work", "__end__")
  .compile();
const open = () => embedSqliteGraphs({ agent: graph }, { sqlitePath: resolve("daemon.sqlite") });
if (process.argv[2] === "child") {
  const local = await open();
  const runtime = createProtocolRuntime(local.deps, { scheduler: { enabled: false } });
  await runtime.service.assistants.registerGraphAssistants();
  const client = runtime.createNativeClient({
    sourceId: "daemon",
    allowedAssistants: ["agent"],
    outcomeTarget: "https://receiver.example/daemon",
  });
  const receipt = await client.start(
    { assistant_id: "agent", input: {} },
    { idempotencyKey: "crashed" },
  );
  process.send({ receipt });
  runtime.worker.start();
  setInterval(() => {}, 1000);
} else {
  const child = fork(new URL(import.meta.url), ["child"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  try {
    const receipt = await new Promise((resolve, reject) => {
      let admitted;
      child.on("message", (message) => {
        if (message.receipt) admitted = message.receipt;
        if (message.executing) resolve(admitted);
      });
      child.once("exit", () => reject(new Error("Child exited early")));
    });
    child.kill("SIGKILL");
    await once(child, "exit");
    const local = await open();
    const runtime = createProtocolRuntime(local.deps, { scheduler: { enabled: false } });
    const client = runtime.createNativeClient({ sourceId: "daemon", allowedAssistants: ["agent"] });
    let success;
    try {
      assert.deepEqual(await client.getReceipt("crashed"), receipt);
      assert.equal((await client.getRun(receipt.runId)).error.name, "ProcessLostError");
      await assert.rejects(
        client.getResult(receipt.runId),
        (error) => error.code === "run_result_unavailable",
      );
      assert.equal((await local.deps.store.deliveries.listByRun(receipt.runId)).length, 1);
      runtime.worker.start();
      success = await client.start(
        { assistant_id: "agent", input: {} },
        { idempotencyKey: "completed" },
      );
      for (let index = 0; (await client.getRun(success.runId)).status !== "success"; index++) {
        assert.ok(index < 500);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(executions, 1);
      assert.deepEqual((await client.getResult(success.runId)).values, { answer: "done" });
    } finally {
      await runtime.worker.stop();
      await local.dispose();
    }
    const reopened = await open();
    const next = createProtocolRuntime(reopened.deps);
    const reads = next.createNativeClient({ sourceId: "daemon", allowedAssistants: ["agent"] });
    try {
      assert.deepEqual(await reads.getReceipt("completed"), success);
      assert.deepEqual((await reads.getResult(success.runId)).values, { answer: "done" });
    } finally {
      await next.worker.stop();
      await reopened.dispose();
    }
    console.log(
      "PACKED_NATIVE_DAEMON_OK: native receipt/status/result after process loss and reopen, no HTTP",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
}
