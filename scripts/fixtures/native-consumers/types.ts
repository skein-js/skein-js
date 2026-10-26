import {
  createProtocolRuntime,
  type ProtocolDeps,
  type NativeClient,
  type NativeStartInput,
  type NativeResumeInput,
} from "@skein-js/agent-protocol";
import {
  createBullMqTransport,
  type BullMqCommand,
  type BullMqTransportOptions,
} from "@skein-js/bullmq";
import { Queue } from "bullmq";
import { Cluster, Redis } from "ioredis";
export function bind(deps: ProtocolDeps) {
  const outcomeQueue = new Queue("outcomes", { connection: { host: "localhost" } });
  const options: BullMqTransportOptions<typeof outcomeQueue> = {
    commandQueue: "commands",
    outcomeQueue,
    connection: new Redis({ lazyConnect: true, maxRetriesPerRequest: null }),
    authenticate: async () => ({}),
  };
  const transport = createBullMqTransport(options);
  const clusterTransport = createBullMqTransport({
    commandQueue: "cluster-commands",
    outcomeQueue: new Queue("{outcomes}", { connection: { host: "localhost" } }),
    connection: new Cluster([], {
      lazyConnect: true,
      redisOptions: { maxRetriesPerRequest: null },
    }),
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
  const input: NativeStartInput = { assistant_id: "agent", input: {}, timeout_ms: 1000 };
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
    timeout_ms: 1000,
  };
  void command;
  void resume;
  return { client, transport, clusterTransport };
}

// Existing explicitly annotated options retain the complete upstream Queue type by default.
export async function inspectBorrowedQueue(options: BullMqTransportOptions) {
  return options.outcomeQueue.getJobs(["waiting"]);
}

export async function inspectFactoryQueue(options: Parameters<typeof createBullMqTransport>[0]) {
  return options.outcomeQueue.getJobs(["waiting"]);
}
