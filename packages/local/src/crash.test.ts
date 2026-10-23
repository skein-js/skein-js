import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Annotation, StateGraph } from "@langchain/langgraph";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { expect, it } from "vitest";

import { embedSqliteGraphs } from "./index.js";

it("retains a real graph checkpoint after SIGKILL without replaying its input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "skein-graph-kill-"));
  const filename = join(directory, "state.sqlite");
  const counter = join(directory, "executions.txt");
  const graphModule = pathToFileURL(
    createRequire(import.meta.url)
      .resolve("@langchain/langgraph")
      .replace(/\.cjs$/, ".js"),
  ).href;
  const localModule = new URL("../dist/index.js", import.meta.url).href;
  const protocolModule = new URL("../../agent-protocol/dist/index.js", import.meta.url).href;
  const childFile = join(directory, "child.mjs");
  await writeFile(
    childFile,
    `import {appendFile} from 'node:fs/promises';
    import {Annotation,StateGraph} from ${JSON.stringify(graphModule)};
    import {embedSqliteGraphs} from ${JSON.stringify(localModule)};
    import {createProtocolRuntime} from ${JSON.stringify(protocolModule)};
    setInterval(()=>{},1000);
    const state=Annotation.Root({value:Annotation({reducer:(_p,n)=>n})});
    let thread;
    const graph=new StateGraph(state).addNode('save',async()=>{await appendFile(${JSON.stringify(counter)},'executed\\n');return {value:'checkpointed'};})
      .addNode('blocked',async()=>{process.send({threadId:thread.thread_id});await new Promise(()=>{});return {};})
      .addEdge('__start__','save').addEdge('save','blocked').addEdge('blocked','__end__').compile();
    const local=await embedSqliteGraphs({proof:graph},{sqlitePath:${JSON.stringify(filename)}});
    const runtime=createProtocolRuntime(local.deps);await runtime.service.assistants.registerGraphAssistants();
    thread=await runtime.service.threads.create();runtime.worker.start();
    await runtime.service.runs.createBackground(thread.thread_id,{assistant_id:'proof',input:{value:'original'}});`,
  );
  const child = fork(childFile, [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "";
  child.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  try {
    const [message] = (await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error(errors || "Graph child exited early");
      }),
    ])) as [{ threadId: string }];
    child.kill("SIGKILL");
    await once(child, "exit");
    const state = Annotation.Root({ value: Annotation<string>() });
    const graph = new StateGraph(state)
      .addNode("save", () => {
        throw new Error("Input must not replay");
      })
      .addNode("blocked", () => ({}))
      .addEdge("__start__", "save")
      .addEdge("save", "blocked")
      .addEdge("blocked", "__end__")
      .compile();
    const local = await embedSqliteGraphs({ proof: graph }, { sqlitePath: filename });
    const runtime = createProtocolRuntime(local.deps);
    try {
      expect((await runtime.service.threads.getState(message.threadId)).values).toEqual({
        value: "checkpointed",
      });
      const runs = await runtime.service.runs.listByThread(message.threadId);
      expect(runs[0]?.status).toBe("error");
      expect(runs[0]?.error?.name).toBe("ProcessLostError");
      runtime.worker.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await runtime.worker.stop();
      expect(await readFile(counter, "utf8")).toBe("executed\n");
    } finally {
      await runtime.worker.stop();
      await local.dispose();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
