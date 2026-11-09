# Scale API serving and background workers separately

Run an API owner and one or more background owners against the same Postgres and Redis databases.
Use this when queued work needs a different process or replica count from HTTP serving. Wait and
stream submissions still execute inline in the API process; this recipe does not move them to workers.

Use the same graph exports, credentials, dependency versions and backend configuration in each process.
Start with [Postgres and Redis setup](../deploy.md). The code below uses published exports; there is
no additional CLI role.

## API owner

Create the runtime, register graph assistants, and mount its handler table without starting its worker:

```ts
import express from "express";
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { createHandlerRouter } from "@skein-js/express";
import { embedPostgresGraphs } from "@skein-js/runtime";
import { graph } from "./agent.js";
import { authEngine } from "./auth-engine.js";

const embedded = await embedPostgresGraphs({ agent: graph }, { overrides: { auth: authEngine } });
const api = createProtocolRuntime(embedded.deps);
await api.service.assistants.registerGraphAssistants();
const app = express();
app.use(createHandlerRouter(api.handlers, { handleRequest: api.handleRequest }));
const listener = app.listen(2024);

process.once("SIGTERM", () => {
  void (async () => {
    const drained = new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await api.worker.stop();
    await drained;
    await embedded.dispose();
  })();
});
```

`authEngine` is your existing resolved authentication/authorization engine; see
[authentication](./authentication.md). Keep it on the API owner. Background runs persist the
authenticated execution context at admission; worker processes do not infer identity from task IDs.

## Background owner

Assemble the same drivers and graphs, then start the worker lifecycle:

```ts
import { createProtocolRuntime } from "@skein-js/agent-protocol";
import { embedPostgresGraphs } from "@skein-js/runtime";
import { graph } from "./agent.js";

const embedded = await embedPostgresGraphs({ agent: graph });
const runtime = createProtocolRuntime(embedded.deps, { worker: { maxConcurrency: 10 } });
await runtime.service.assistants.registerGraphAssistants();
runtime.worker.start();
process.once("SIGTERM", () => {
  void runtime.worker.stop().then(() => embedded.dispose());
});
```

The API process owns its listener, inline requests and subscriptions. The worker lifecycle owns
background consumption, cron scheduling, thread TTL, idempotency sweeping and delivery retries.
Cancellation subscriptions start at runtime assembly, including on API-only owners, and close through
`worker.stop()`. That stop operation stops the loops, drains/aborts active work, and must
finish before driver disposal. Multiple background owners use the existing distributed execution and
cron claims; they do not strengthen the documented enqueue-order guarantee.

This example configures no store-item TTL. `embedPostgresGraphs(graphs, {ttl: ...})` starts that separate
store sweeper per assembly, independently of `worker.start()`. If you require a single store-sweep
owner, compose `PostgresSkeinStore` and its existing `store.sweepExpired()` primitive in your host
instead. Preserve the same TTL policy on writers. See [storage](../storage.md).

Drain inline requests before disposing the API's drivers. Choose a shutdown deadline appropriate to
your graph, and cancel unfinished runs through the existing run service when your host requires a
bounded drain. Observe cancellation to completion before closing storage.

## Verify the composition

Submit a background run through the authenticated API, keep its thread/run IDs, and join its stream.
It should execute on a background owner. Reconnect with the last event ID; Redis replays retained
frames. Cancel through another API instance and inspect the original run until it settles. A caller
without thread access must be unable to read, cancel or join that run.

Submit a wait run to verify that it executes in the API process. Stop a background owner during work
and check its settled cancellation before teardown; a hard process loss follows the separate
[checkpoint-recovery contract](../runs-and-redis.md#recover-after-a-worker-exits). Keep external
effects idempotent and retain the existing stream-history limits.
