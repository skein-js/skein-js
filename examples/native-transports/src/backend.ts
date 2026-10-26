import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { createBullMqTransport } from "@skein-js/bullmq";
import { SkeinHttpError, type AuthContext, type AuthEngine } from "@skein-js/core";
import { createExpressServer, type SkeinExpressServer } from "@skein-js/express";
import { embedSqliteGraphs, type EmbeddedSqliteRuntime } from "@skein-js/local";
import { Queue } from "bullmq";

import { approvalGraph } from "./approval.js";
import {
  commandQueueName,
  connectRedis,
  outcomeQueueName,
  resolveRedisConnectionOptions,
  sqlitePath,
  token,
} from "./settings.js";

// This example has one host-controlled principal. The command queue must be restricted to that
// trusted backend producer. Browser/end-user claims in job payloads are never authentication.
const principal: AuthContext = {
  user: {
    identity: "approval-backend",
    display_name: "Approval backend",
    is_authenticated: true,
    permissions: [],
  },
  scopes: [],
};
const auth: AuthEngine = {
  enabled: true,
  studioAuthDisabled: false,
  authenticate: async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      throw SkeinHttpError.unauthorized("Invalid bearer token.");
    return principal;
  },
  authorize: async ({ context, value }) => {
    if (context?.user.identity !== principal.user.identity)
      throw SkeinHttpError.forbidden("Unknown principal.");
    return { value, filters: { owner: context.user.identity } };
  },
  matchesFilters: (metadata, filters) => metadata?.["owner"] === filters?.["owner"],
};
await mkdir(dirname(sqlitePath), { recursive: true });
const connection = connectRedis();
const outcomes = new Queue(outcomeQueueName, {
  connection: resolveRedisConnectionOptions(),
  defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100 },
});
const transport = createBullMqTransport({
  commandQueue: commandQueueName,
  outcomeQueue: outcomes,
  connection,
  maxMessageBytes: 2048,
  authenticate: async (job) => {
    // Projection only covers result.get and outcomes. Deny raw run metadata for this producer.
    if (job.data.operation === "run.get")
      throw SkeinHttpError.forbidden("Raw run queries are disabled.");
    return { authContext: principal };
  },
  projectResult: (result) => ({
    decision: (result.values as { decision?: string }).decision,
    checkpoint: result.checkpoint,
  }),
});
let local: EmbeddedSqliteRuntime | undefined;
let server: SkeinExpressServer | undefined;
let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= (async () => {
    const errors: unknown[] = [];
    for (const dispose of [
      () => transport.stop(),
      () => server?.close(),
      () => local?.dispose(),
      () => outcomes.close(),
      () => connection.quit(),
    ]) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Example shutdown failed.");
  })());
try {
  local = await embedSqliteGraphs(
    { approval: approvalGraph },
    {
      sqlitePath,
      overrides: {
        auth,
        webhookDispatcher: transport.wrapDispatcher(async () => {
          throw new Error("Unconfigured destination.");
        }),
      },
    },
  );
  server = await createExpressServer({ deps: local.deps, scheduler: { enabled: false } });
  const client = server.runtime.createNativeClient!({
    sourceId: "approval-queue-example", // Stable queue identity and source ID across restart.
    allowedAssistants: ["approval"],
    outcomeTarget: transport.outcomeTarget,
  });
  await transport.start(client);
  const listener = await server.listen(Number(process.env["PORT"] ?? 2024), "127.0.0.1");
  const address = listener.address();
  console.log(
    JSON.stringify({ ready: true, port: typeof address === "object" ? address?.port : undefined }),
  );
} catch (error) {
  await close();
  throw error;
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
