import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateGraph, Annotation } from "@langchain/langgraph";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { expect, it } from "vitest";

import { embedSqliteGraphs } from "./index.js";

it("reconciles a killed native execution and its receipt/outcome without replaying input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-native-crash-"));
  const filename = join(directory, "state.sqlite");
  const childFile = join(directory, "child.mjs");
  const localEntry = new URL("../dist/index.js", import.meta.url).href;
  const agentEntry = new URL("../../agent-protocol/dist/index.js", import.meta.url).href;
  const graphEntry = new URL("../node_modules/@langchain/langgraph/dist/index.js", import.meta.url)
    .href;
  await writeFile(
    childFile,
    `import {embedSqliteGraphs} from ${JSON.stringify(localEntry)};
    import {createProtocolRuntime} from ${JSON.stringify(agentEntry)};
    import {Annotation,StateGraph} from ${JSON.stringify(graphEntry)};
    const graph=new StateGraph(Annotation.Root({answer:Annotation()})).addNode('wait',async()=>{process.send({executing:true});await new Promise(()=>{});return {};}).addEdge('__start__','wait').addEdge('wait','__end__').compile();
    const local=await embedSqliteGraphs({agent:graph},{sqlitePath:${JSON.stringify(filename)}});
    const runtime=createProtocolRuntime(local.deps,{scheduler:{enabled:false}});await runtime.service.assistants.registerGraphAssistants();
    const client=runtime.createNativeClient({sourceId:'daemon',allowedAssistants:['agent'],outcomeTarget:'https://receiver.example/native'});
    const receipt=await client.start({assistant_id:'agent',input:{}},{idempotencyKey:'work'});process.send({receipt});runtime.worker.start();setInterval(()=>{},1000);`,
  );
  const child = fork(childFile, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  try {
    const receipt = await new Promise<{ runId: string; threadId: string; idempotencyKey: string }>(
      (resolve, reject) => {
        let accepted: { runId: string; threadId: string; idempotencyKey: string };
        child.on("message", (message: { receipt?: typeof accepted; executing?: boolean }) => {
          if (message.receipt) accepted = message.receipt;
          if (message.executing) resolve(accepted);
        });
        child.once("exit", () => reject(new Error(errors || "Child exited before executing")));
      },
    );
    child.kill("SIGKILL");
    await once(child, "exit");
    let executions = 0;
    const graph = new StateGraph(Annotation.Root({ answer: Annotation<string> }))
      .addNode("wait", () => {
        executions++;
        return { answer: "unexpected" };
      })
      .addEdge("__start__", "wait")
      .addEdge("wait", "__end__")
      .compile();
    const local = await embedSqliteGraphs({ agent: graph }, { sqlitePath: filename });
    const runtime = createProtocolRuntime(local.deps, { scheduler: { enabled: false } });
    const client = runtime.createNativeClient({ sourceId: "daemon", allowedAssistants: ["agent"] });
    try {
      expect(await client.getReceipt("work")).toEqual(receipt);
      expect(await client.getRun(receipt.runId)).toMatchObject({
        status: "error",
        error: { name: "ProcessLostError" },
      });
      await expect(client.getResult(receipt.runId)).rejects.toMatchObject({
        code: "run_result_unavailable",
      });
      const deliveries = await local.deps.store.deliveries!.listByRun(receipt.runId);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        run_status: "error",
        payload: { command_id: "work", result_unavailable: true },
      });
      runtime.worker.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(executions).toBe(0);
    } finally {
      await runtime.worker.stop();
      await local.dispose();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
