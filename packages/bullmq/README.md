# @skein-js/bullmq

Optional BullMQ access to Skein's native client. External command/outcome queues share the runtime's
authorization, atomic admission, retained results and outbox. Skein's internal execution and delivery
queues remain in charge.

```ts
import { createBullMqTransport } from "@skein-js/bullmq";

const access = createBullMqTransport({
  commandQueue: "commands",
  outcomeQueue, // borrowed BullMQ Queue
  connection,
  authenticate: async (job) => ({ authContext: await verifyCaller(job) }),
});
// Compose access.wrapDispatcher(existingDispatcher) into ProtocolDeps.webhookDispatcher.
// Bind access.outcomeTarget on runtime.createNativeClient({sourceId, allowedAssistants, ...}).
await access.start(nativeClient);
// ... shutdown:
await access.stop(); // closes owned workers, preserves borrowed connections/queues
```

BullMQ 5/6 and ioredis 5/6 are supported. Producers send version-1 `BullMqCommand` values and configure
bounded BullMQ attempts/backoff. Job return values acknowledge admission; durable outcomes carry
`eventId` equal to the outbox delivery ID. Persist receiver deduplication independently of broker job
retention. `result.get` and `state.get` support bounded digest-checked chunks; native results stay whole.

`projectResult` projects outcomes and `result.get`, not full `run.get` metadata or `state.get` snapshots.
Reject unwanted raw queries in the host's `authenticate`/`route` callbacks. Redis readers can inspect
job inputs and return values outside native authorization; configure credentials, ACLs, TLS and job
retention. Skein deletion does not purge external broker copies.

The [runnable approval example](https://github.com/skein-js/skein-js/tree/main/examples/native-transports)
shows explicit lifecycle, a host-bound principal, projected results, chunk verification and durable
receiver deduplication. See [security and operations](https://github.com/skein-js/skein-js/blob/main/docs/native-access-security.md).

Read [native access and BullMQ](https://github.com/skein-js/skein-js/blob/main/docs/native-access.md)
for setup, message formats, ownership, errors and reconciliation. Run the external packed consumers
with `pnpm exec nx run test-support:test-native-consumer`.

The package supplies its runtime ioredis dependency, including when BullMQ 6 resolves ioredis through
its optional peer. The adapter accepts connection options or a borrowed supported ioredis `Redis` or
`Cluster` client.
For mixed BullMQ 5/ioredis 6 installs, give upstream BullMQ queues and workers connection options so
they use BullMQ's own client; the maintained example demonstrates this without application casts.
The adapter keeps borrowed clients and the outcome queue usable after `stop()`.
Borrowed outcome queues can come from a different supported BullMQ major than the adapter's worker.
Use `BullMqTransportOptions<typeof outcomeQueue>` when explicitly annotating options for that queue;
existing annotations retain the full upstream Queue type by default.
