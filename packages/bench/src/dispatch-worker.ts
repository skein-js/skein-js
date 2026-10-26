import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedPostgresGraphs } from "@skein-js/runtime";

const workload = Annotation.Root({ jobId: Annotation<string>(), durationMs: Annotation<number>() });
const graph = new StateGraph(workload)
  .addNode("work", async (state, config) => {
    const threadId = config.configurable?.["thread_id"] as string;
    process.send?.({ kind: "started", jobId: state.jobId, threadId, at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, state.durationMs));
    process.send?.({ kind: "finished", jobId: state.jobId, threadId, at: Date.now() });
    return {};
  })
  .addEdge(START, "work")
  .addEdge("work", END)
  .compile();

const embedded = await embedPostgresGraphs(
  { agent: graph },
  {
    postgresUri: process.env["DISPATCH_POSTGRES_URI"],
    redisUri: process.env["DISPATCH_REDIS_URI"],
  },
);
const runtime = createProtocolRuntime(embedded.deps, {
  worker: { maxConcurrency: 4 },
  scheduler: { enabled: false },
});
await runtime.service.assistants.registerGraphAssistants();
let sampler: ReturnType<typeof setInterval> | undefined;

interface Command {
  id: number;
  operation: "thread" | "enqueue" | "start" | "stop" | "dispose";
  threadId?: string;
  jobId?: string;
  durationMs?: number;
}

process.on("message", (command: Command) => {
  void (async () => {
    switch (command.operation) {
      case "thread":
        return (await runtime.service.threads.create()).thread_id;
      case "enqueue": {
        const run = await runtime.service.runs.createBackground(command.threadId!, {
          assistant_id: "agent",
          input: { jobId: command.jobId, durationMs: command.durationMs },
          multitask_strategy: "enqueue",
        });
        return Date.parse(run.created_at);
      }
      case "start":
        runtime.worker.start();
        sampler = setInterval(() => {
          process.send?.({ kind: "slots", count: runtime.worker.inFlightRunCount });
        }, 10);
        return;
      case "stop":
        clearInterval(sampler);
        await runtime.worker.stop();
        return;
      case "dispose":
        clearInterval(sampler);
        await runtime.worker.stop();
        await embedded.dispose();
        return;
    }
  })().then(
    (result) => process.send?.({ kind: "reply", id: command.id, result }),
    (error: unknown) => process.send?.({ kind: "reply", id: command.id, error: String(error) }),
  );
});
process.send?.({ kind: "ready" });
