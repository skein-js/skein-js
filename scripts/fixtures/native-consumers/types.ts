import {
  createProtocolRuntime,
  type ProtocolDeps,
  type NativeClient,
  type NativeStartInput,
  type NativeResumeInput,
} from "@skein-js/agent-protocol";
import { createBullMqTransport, type BullMqCommand } from "@skein-js/bullmq";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
export function bind(deps: ProtocolDeps) {
  const transport = createBullMqTransport({
    commandQueue: "commands",
    outcomeQueue: new Queue("outcomes", { connection: { host: "localhost" } }),
    connection: new Redis({ lazyConnect: true, maxRetriesPerRequest: null }),
    authenticate: async () => ({}),
  });
  const runtime = createProtocolRuntime({
    ...deps,
    webhookDispatcher: transport.wrapDispatcher(async () => {}),
  });
  const client: NativeClient = runtime.createNativeClient({
    sourceId: "typed-consumer",
    allowedAssistants: ["agent"],
    outcomeTarget: transport.outcomeTarget,
  });
  const input: NativeStartInput = { assistant_id: "agent", input: {} };
  const command: BullMqCommand = { version: 1, commandId: "one", operation: "start", input };
  const resume: NativeResumeInput = {
    assistant_id: "agent",
    thread_id: "thread",
    expected: {
      runId: "run",
      checkpoint: {
        thread_id: "thread",
        checkpoint_id: "checkpoint",
        checkpoint_ns: "",
        checkpoint_map: null,
      },
    },
    resume: "approve",
  };
  void command;
  void resume;
  return { client, transport };
}
