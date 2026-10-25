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

BullMQ 5/ioredis 5 are the tested majors. Producers send version-1 `BullMqCommand` values and configure
bounded BullMQ attempts/backoff. Job return values acknowledge admission; durable outcomes carry
`eventId` equal to the outbox delivery ID. Persist receiver deduplication independently of broker job
retention. `result.get` and `state.get` support bounded digest-checked chunks; native results stay whole.

Read [native access and BullMQ](https://github.com/skein-js/skein-js/blob/main/docs/native-access.md)
for setup, message formats, ownership, errors and reconciliation. Run the external packed consumers
with `pnpm exec nx run test-support:test-native-consumer`.
