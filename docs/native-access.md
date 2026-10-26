---
title: Native and BullMQ access to LangGraph.js agents
description: Admit agent work from embedded TypeScript applications or BullMQ with durable receipts, strict resume targets, retained results and existing authorization.
---

# Native access and BullMQ

Use `runtime.createNativeClient` when a trusted host admits work without HTTP and needs a receipt
that survives retries. It uses the same assistants, threads, authorization, run engine and storage
as HTTP. The optional `@skein-js/bullmq` package connects external command and outcome queues to
that client. It does not replace Skein's internal execution or delivery queues.

The [runnable approval example](https://github.com/skein-js/skein-js/tree/main/examples/native-transports)
includes an embedded SQLite client and an HTTP/BullMQ backend with a durable outcome inbox.
Read [security and operations](./native-access-security.md) before exposing a producer to real data.

## Embedded applications

```ts
import { embedSqliteGraphs } from "@skein-js/local";
import { createProtocolRuntime } from "@skein-js/agent-protocol";

const local = await embedSqliteGraphs(
  { agent: graph },
  {
    sqlitePath: "/absolute/application-data/agents.sqlite",
  },
);
const runtime = createProtocolRuntime(local.deps);
await runtime.service.assistants.registerGraphAssistants();
const client = runtime.createNativeClient({
  sourceId: "desktop-approval-worker", // stable across restarts
  allowedAssistants: ["agent"], // assistant IDs or graph IDs; required, empty permits none
});
runtime.worker.start();

const receipt = await client.start(
  { assistant_id: "agent", input: {} },
  {
    idempotencyKey: "approval-42",
    correlationId: "request-42",
  },
);
// Admission has committed; execution may still be pending.
const run = await client.getRun(receipt.runId);
const recovered = await client.getReceipt("approval-42");
// Once terminal: client.getResult(receipt.runId) returns the whole retained RunResult.

await runtime.worker.stop();
await local.dispose();
```

The constructor is guaranteed on `createProtocolRuntime`'s concrete return and optional on the
`ProtocolRuntime` interface for compatibility with third-party implementations. There is no separate
native constructor. The existing `runtime.service` remains useful for trusted administrative work;
it does not add native authorization, receipts or admission guarantees to independently composed calls.

Sources and caller identity are host configuration. When authentication is enabled, every native call
requires the host's verified `authContext`. The client calls the existing authorizer with canonical
resource IDs and applies its ownership filters. It does not authenticate arbitrary broker claims or
turn graph metadata into authority. HTTP and native sources can use the same authorized thread when
the host maps their credentials to the same principal.

Keys are scoped by stable source and principal. Omit a key to generate one and receive it in
`{ idempotencyKey, threadId, runId }`. Identical retries return the original receipt; changed input
returns `idempotency_key_reused`. Receipt replay and reads recheck current authorization. Access
revocation takes effect immediately. Retention, expiry and resource deletion bound replay guarantees.
Keep a returned generated key before retrying; a new key means a new mutation.

Trusted adapters that derive a run from a command may set `idempotencyInput` to the **original**
command, including all caller-controlled meaning. This keeps retry identity stable if host routing
or start/resume selection changes. Do not set it to a constant or let a caller choose a reduced
fingerprint. The first admission retains its route, execution identity and deadline.

## Interrupts, cancellation and deadlines

After a run reaches `interrupted`, read its state and submit an answer with that exact checkpoint:

```ts
const state = await client.getState(receipt.threadId);
const answer = await client.resume(
  {
    thread_id: receipt.threadId,
    assistant_id: "agent",
    expected: {
      runId: receipt.runId,
      checkpoint: state.checkpoint,
      // interruptIds: ["expected-interrupt-id"], // optional additional precondition
    },
    resume: "approved", // also accepts LangGraph's resume map
  },
  { idempotencyKey: "answer-42", authContext: verifiedContext },
);

const cancelled = await client.cancel(answer.runId, {
  idempotencyKey: "cancel-42",
  authContext: verifiedContext,
  wait: true,
  // action: "rollback", // existing cancellation semantics
});
```

Only one admitted resume can consume an expected interrupted run/checkpoint. Admission and invocation
validate it under the thread execution lease. A stale target returns `stale_resume`; fetch current
state before submitting a new answer. Checkpoint updates use the same lease. Resuming an already
accepted key recovers its receipt even after execution advanced the checkpoint.
Separate checkpoint, status and concurrency overrides are rejected at runtime. Strict resume
validates every supplied `checkpoint_map` namespace against its current checkpoint before admission
and invocation; a current root ID cannot authorize an older nested checkpoint. Native state reads
hold the execution lease and can wait behind active work. Retry `native_state_changed` if a target
changes during authorization or lease acquisition.

Cancellation returns `{ receipt, status, stopped }`. A terminal status records the authoritative
decision; `stopped` separately confirms execution has stopped. Without waiting, a remote execution
may still be unwinding. Repeated cancellation with `wait: true` still waits for a cancelled execution.
Graphs and tools must honor cancellation signals. Lease loss aborts protected execution after it is
observed; this does not fence arbitrary external effects from tools that ignore their signal.

`deadlineAt` is a trusted absolute ISO timestamp in call options. Expired commands are rejected before
admission. An accepted command keeps its receipt and uses the earlier of its remaining absolute budget
and `runTimeoutMs`; retries cannot extend it. `after_seconds` retains its first absolute eligibility
time. Result reads return `run_result_pending` while active and `run_result_unavailable` if no output
was retained, including cancellation before execution and unserializable output. Serialization failure
does not rewrite a successful execution as a failed run or invent replacement output.

## Durable outcomes

Bind an optional trusted `outcomeTarget` on the source and compose `ProtocolDeps.webhookDispatcher`
to handle it. This opts in to durable terminal accounting for success, error, timeout, interruption,
pending cancellation/displacement and SQLite process loss. Without it native results remain available,
but no callback is owed. Legacy HTTP/channel callback defaults are unchanged.

The existing outbox records the outcome atomically with terminal status and optional retained result.
The dispatcher receives the existing `deliveryId` and `attempt`; channel and routed destination
callbacks now also receive those fields as optional context. Receiver deduplication must persist
`deliveryId` before acknowledging. Delivery is at least once, including a crash after publication
but before outbox acknowledgement. A removed BullMQ job cannot serve as a durable deduplication record.

Outcomes use existing payload/retention limits. Large outcomes carry run references and a truncation
marker. **Stored results remain whole**, independent of delivery truncation and checkpoint pruning.
Results follow existing run/thread deletion. Snapshot import and thread copy retain results but
exclude live native receipt, dispatch and delivery obligations.

Memory guarantees last only for that process. SQLite keeps atomic run/job admission and marks
abandoned attempts `ProcessLostError` on reopen; it does not automatically replay their input.
Postgres recovery drains bounded leased dispatch intents for explicitly admitted background work.
Acknowledging enqueue keeps ownership until run deletion: an active run becomes eligible again when
its lease expires, so a lost queue job can be reconstructed with the same run ID. Terminal runs are
skipped under the execution lease before checkpoint effects. Ordinary inline runs and unrelated
producers' rows are not adopted. Explicit cancellation, displacement, deletion and shutdown grace
expiry broadcast abort requests even when a local registration is only waiting for a remote executor.
Failed cancellation publication remains recoverable. Eligible execution owners also observe durable
terminal status to stop after a missed pub/sub notification. Native rollback preserves the admitted
run and receipt; explicit resource deletion still removes them.

## BullMQ access transport

```sh
npm install @skein-js/bullmq bullmq@^5 ioredis@^5
```

```ts
import { Queue } from "bullmq";
import { createBullMqTransport } from "@skein-js/bullmq";
import { createProtocolRuntime } from "@skein-js/agent-protocol";

const outcomes = new Queue("agent-outcomes", { connection });
const access = createBullMqTransport({
  commandQueue: "agent-commands",
  outcomeQueue: outcomes, // borrowed
  connection, // options or borrowed supported ioredis connection
  authenticate: async (job) => ({ authContext: await verifyQueueCaller(job) }),
  // route: command => mapToAllowedGraph(command),
  // projectResult: (result, runId) => applicationProjection(result, runId),
});
const runtime = createProtocolRuntime({
  ...deps,
  webhookDispatcher: access.wrapDispatcher(existingDispatcher),
});
await runtime.service.assistants.registerGraphAssistants();
const native = runtime.createNativeClient({
  sourceId: "backend-queue",
  allowedAssistants: ["agent"],
  outcomeTarget: access.outcomeTarget,
});
runtime.worker.start();
await access.start(native); // creating the transport consumes nothing

// Shutdown consumption before the runtime and storage.
await access.stop();
await runtime.worker.stop();
await outcomes.close(); // host owns this queue/connection
```

Workers own their blocking connection and are closed by `stop`; borrowed queues/connections remain
open. Keep the outcome queue name and Redis prefix stable across restart. Host-controlled
authentication, routing, deadlines, destinations and output projection are functions/configuration,
not authority accepted from message fields. HTTP remains available independently.
`projectResult` covers outcomes and `result.get`; `state.get` and `run.get` remain full authorized
reads. Deny raw operations in the host's existing callbacks if a producer should see only projections.
Redis credentials also grant access to stored job payloads/return values; configure ACLs, TLS and
separate retention for those copies. See [the security guide](./native-access-security.md).

The adapter owns the following versioned wire format, exposed as `BullMqCommand`:

```ts
await commands.add(
  "skein.command.v1",
  {
    version: 1,
    commandId: "work-42",
    operation: "start",
    input: { assistant_id: "agent", input: {} },
  },
  { attempts: 5, backoff: { type: "exponential", delay: 1000 } },
);
```

| Operation     | Fields beyond `version`, `commandId`, optional `correlationId` | Job return value             |
| ------------- | -------------------------------------------------------------- | ---------------------------- |
| `start`       | `input: NativeStartInput`                                      | Admission receipt            |
| `resume`      | `input: NativeResumeInput`                                     | Admission receipt            |
| `cancel`      | `runId`, optional `action`, `wait`                             | Cancellation response        |
| `run.get`     | `runId`, optional `offset`, `digest`                           | Bounded chunk of current run |
| `state.get`   | `threadId`, optional `offset`, `digest`                        | Bounded chunk                |
| `result.get`  | `runId`, optional `offset`, `digest`                           | Bounded chunk                |
| `receipt.get` | `idempotencyKey`                                               | Receipt                      |

`commandId` becomes the native idempotency key. Mutations acknowledge durable acceptance. The first
admission keeps its diagnostic correlation ID; changing only `correlationId` on a retry does not
change command meaning. Execution
completion arrives as a `BullMqOutcome` (`version: 1`, `operation: "run.settled"`) on the outcome queue.
`eventId` is the outbox delivery ID, with `commandId`, resource IDs, status and a `resultRef`. Small
outcomes may include projected output; oversized ones omit it and set `truncated: true`.
One run has one authoritative terminal outcome; outcomes for different runs may arrive out of order.
Persist receiver deduplication by `eventId` and compare `runId` with the receipt for the turn your
application is displaying before changing that turn's state. Reconcile through `run.get`/`state.get`
when needed; checkpoint coordinates and chunk digests identify the snapshot being read. Arrival order
does not establish thread order.

BullMQ handles retries according to the producer's bounded `attempts`/`backoff`. Validation,
authorization, stale answers and unsupported capabilities fail with `UnrecoverableError`; its JSON
message includes the stable code and status. Admission contention, pending results and infrastructure
failures use normal retry behavior. Default BullMQ attempts remain one unless the producer sets them.
For command acknowledgement waiters, start `QueueEvents` with a retained cursor such as
`lastEventId: "0-0"`, as the runnable example does. Connection readiness alone does not prove that
event consumption has begun; a fast completion can otherwise fall between the waiter's status check
and its first stream read. If acknowledgement times out, recover admission by its stable command key.

Each run/state/result request reauthorizes and returns a base64 byte chunk with SHA-256 `digest`, `offset`,
`nextOffset` and `totalBytes`. Start at offset zero, then supply the returned digest and next offset.
Concatenate decoded bytes and verify the digest before parsing JSON. `result_digest_mismatch` means
the value/projection changed; restart retrieval. No HTTP is needed to reconcile missed or truncated
outcomes. Native `getResult` always returns the whole result. `maxMessageBytes` defaults to the
existing 256 KiB payload cap and can be reduced to 1 KiB. The supported dependency majors are BullMQ 5/6 and ioredis 5/6. The
[validation record](./native-access-validation.md#bullmq-and-ioredis-compatibility) describes the installed
consumer matrix. In mixed BullMQ 5/ioredis 6 installations, pass connection options to BullMQ queues
and workers so BullMQ retains its own client; the Skein transport also accepts a borrowed ioredis 6
client. No casts are needed in application code.

## Custom drivers and verification

Native writes explicitly require optional `SkeinStore.admission` and `RunRepo.settle`/`getResult`;
missing guarantees return `native_admission_unsupported` instead of emulating transactions with CRUD.
`admitRun` commits the scoped key/fingerprint, guarded run/displacements, receipt, resume reservation
and dispatch intent together. `admitCancel` does the corresponding cancellation transaction.
`claimDispatches` leases bounded batches; `markDispatched` only acknowledges the matching token.
Run intents remain recoverable while pending/running after acknowledgement; cancel intents stop after
acknowledgement. Retain admission ownership until run deletion, and atomically refuse a transition
from terminal to running for owned runs, returning the effective row unchanged.
`settle` atomically records the first terminal status, first matching result and optional identified
delivery, returning the effective rows. Existing `recordResult`, `getResult`, `finalizeWithDelivery`
and third-party-driver paths remain supported. Postgres leases may provide an optional loss signal.
New `settle` deliveries start pending at attempt zero; the delivery worker starts attempt one.
Legacy `finalizeWithDelivery` keeps its inline attempt and existing defaults.

`RunAdmission.signal` is an optional ephemeral `AbortSignal`. Drivers observe it before mutations and
at their pre-COMMIT boundary and roll back when it is aborted before COMMIT dispatch. It is never
stored in kwargs, keys or snapshots. Abort can race a COMMIT already sent: a committed receipt remains
authoritative and is recovered by key. This is cooperative admission cancellation, not database fencing.

The packed consumers run outside the workspace with package-root imports:
`pnpm exec nx run test-support:test-native-consumer`. They include an existing-API gap reproduction,
an HTTP/BullMQ approval worker on Postgres/Redis, durable receiver deduplication after job removal,
and a SQLite daemon killed and reopened without HTTP. See [the implementation evidence](./native-access-validation.md).

Existing MCP and A2A endpoints keep their protocol-specific identity, state and transport behavior.
This boundary adds no protocol endpoints, SDK dependency, workflow engine, artifact service or
exactly-once external-effect guarantee.
