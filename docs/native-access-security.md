---
title: Native access security and operations
description: Configure trusted native callers and BullMQ producers, understand projection and retained-data boundaries, and operate cancellation, deadlines and recovery safely.
---

# Native access security and operations

Native and BullMQ access compose existing authorization, admission, execution and outbox guarantees.
The host supplies verified identity and policy. Start with the
[runnable approval example](https://github.com/skein-js/skein-js/tree/main/examples/native-transports)
and the [API guide](./native-access.md).

## Authority at the boundary

Construct native clients in trusted code. Keep `sourceId`, `allowedAssistants` and `outcomeTarget`
stable and outside caller-controlled input. With authentication enabled, supply verified
`authContext` on every operation. A principal, scopes or destination in metadata or a queue payload
does not authenticate anyone. Receipt replay and reads recheck current authorization and ownership.

For BullMQ, `authenticate(job)` must verify the producer using the host's credential arrangement or
bind a queue restricted to one trusted backend to a server-owned principal. Trusting `job.data.userId`
would let a producer impersonate another user. The example uses one trusted backend and loopback HTTP
with a demonstration token. Replace that identity policy for deployment. Authentication-disabled
deployments preserve existing unauthenticated behavior.

An allowlist accepts assistant or graph IDs and limits operations for that source. It does **not**
partition data inside a shared thread: other authorized assistants/transports may have written its
checkpoints. Use separate threads and ownership rules for data isolation. Revocation prevents future
authorized reads; it cannot retract values already returned or copied to Redis.

Strict resume accepts the expected interrupted run/checkpoint, optional interrupt IDs and answer.
Runtime validation rejects separate checkpoint, status or concurrency overrides, including JSON
fields TypeScript excludes. The execution lease protects validation and invocation; atomic reservation
prevents replicas consuming the same interrupt.
Each supplied `checkpoint_map` entry must also name the current checkpoint in that namespace for the
authorized thread. A valid root ID cannot redirect a child to an older checkpoint. This check runs
at admission and before invocation, using the existing checkpointer contract without interpreting
LangGraph's internal metadata. Valid nested coordinates retain LangGraph's own execution semantics.

Native state reads authorize a resolved target, then hold the execution lease while constructing
its graph and reading checkpoints. They can wait behind execution. `native_state_changed` asks the
caller to retry if the target changes during authorization or lease acquisition. Pending admissions
cannot switch the graph mid-read. Factories retain the selected run's sanitized configuration and
use the **requesting** principal.

## Projection and broker storage

`projectResult` applies to outcomes and `result.get`. It does not redact `state.get` snapshots or
`run.get` metadata. Reject raw query operations in `authenticate` or `route` when a producer must
see only projected output; both existing callbacks can throw `SkeinHttpError`. Apply corresponding
policy to HTTP and other sources available to that principal. Native `getResult` returns the whole
retained result and belongs behind the host's trust boundary.

BullMQ stores inputs and return values in Redis. Queue names/prefixes organize keys; they are not
tenant access controls. Redis readers can inspect values without Skein authorization. Restrict
credentials, network access and ACLs, and configure TLS. Avoid secrets in commands/results; use
application-managed encryption when needed. Follow
[BullMQ's production guidance](https://docs.bullmq.io/guide/going-to-production) and
[Redis security guidance](https://redis.io/docs/latest/operate/oss_and_stack/management/security/).

Set retention for completed/failed commands, query return values, outcomes and receiver inboxes.
Skein run/thread deletion and outbox expiry do **not** erase external copies. Automatic job removal
does not replace receiver deduplication: persist `eventId` with application database effects before
acknowledging. Keep destination queue identity stable across restart so existing outbox obligations
continue reaching it.

Chunk digests detect changes between reads; they do not authenticate the broker or encrypt output.
Each chunk request reauthorizes. Bound total reassembly size for your application, verify offsets,
size and digest, and restart retrieval on a changed digest. Truncated outcomes leave whole retained
results available through reconciliation.

## Cancellation, recovery and resource use

Acknowledgement, terminal status and confirmed execution stop are separate facts. `wait: true`
reports `stopped: true` after acquiring valid execution rights. A failed stop check returns retryable
`execution_stop_unconfirmed` (503) while
the accepted receipt remains recoverable. Waiting can queue behind other work on that thread.
If an abort channel is configured without a cross-instance execution gate, waiting cancellation is
rejected before admission with `execution_stop_unsupported` (501); a local mutex cannot prove remote
execution stopped. Supported Postgres assembly supplies both capabilities.
Tools must honor abort signals; status changes cannot undo arbitrary external effects.

Redis pub/sub has [at-most-once delivery](https://redis.io/docs/latest/develop/pubsub/). Recovery
retries failed cancellation publication before acknowledging its intent. Successful publication
cannot prove reception. Native executions, and executions with both an abort channel and atomic
admission capability, also observe durable status once per second with one read in flight per
execution. For N active eligible executions, budget approximately N reads/second. Read failures are
logged and retried. Observed terminal status aborts local control without rebroadcasting. Ordinary
single-process runs without these capabilities retain their existing path.

Native rollback retains the admitted run, receipt and stored result for reconciliation. Explicit
deletion still removes them. Cleanup does not revert a later run that advanced the thread. Legacy
runs retain established rollback deletion behavior.

Expired trusted `deadlineAt` is rejected after authorization and immediately before admission. Once
accepted, the original deadline/route remain authoritative. Execution uses the earlier of remaining
budget and configured timeout. This is cooperative admission cancellation, not a database clock
fence or a promise to stop external effects at an exact instant.

Memory is process-local. SQLite requires one file owner, records process loss as failure and never
automatically replays abandoned input. Postgres recovery leases bounded batches of owned dispatches
and reconstructs lost queue jobs with original run IDs. It does not adopt unrelated runs. Observe
dispatch warnings, outbox depth, failed jobs, capacity and receiver lag; reconcile by receipt/run ID.

## Dependency review

The October 25, 2026 review updated compatible Vite, body-parser, follow-redirects and multer patches.
The production dependency audit fell from ten advisories to one high advisory:
[Zod collection validation resource consumption](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The published fix is Zod 4.6.6; this workspace and LangChain dependencies use Zod 3. A forced
transitive major replacement is not a compatible fix. This PR does not claim a clean dependency audit.

Enforce request byte limits, **pre-validation** collection limits and rate/concurrency budgets at
host boundaries, including user-facing bridges into native calls. Array `.max()` inside an affected
validator is not sufficient early rejection. BullMQ's message cap helps bound input but is not a
general resource-exhaustion guarantee. A compatible upstream fix or separately reviewed Zod migration
remains required; audit the actual deployed lockfile again.
