---
title: Native access validation
description: Reproducible packed-consumer and storage checks for native admission, strict resume, settlement, BullMQ reconciliation and SQLite process loss.
---

# Native access validation

Implementation base: refreshed `main` at `a2e1a8e` (PR #63), in managed worktree
`issue-64-native-transports`. Existing result storage, migrations through Postgres `0014_run_results`
and SQLite version 3, copy/snapshot behavior and A2A/MCP implementations are reused.

## Existing public API gap

`scripts/fixtures/native-consumers/baseline.mjs` uses only the preserved baseline APIs, through packed
packages and package-root imports in a temporary directory outside the workspace. It calls:

1. `store.idempotency.claim(...)`.
2. `runtime.service.runs.createBackground(threadId, input)`.
3. The missing next operation would be `store.idempotency.record(...)`.

Immediately after step 2, SQLite has a committed run/job but the claim has no linked run. The fixture
models a caller lost at that boundary. Once the original claim expires, its retry creates another
run, even after the first interrupted successfully. These existing methods are intentionally still
available; the fixture bypasses the new admission capability to reproduce their separate-commit
behavior. It is an existing-surface reproduction against the implementation's packed artifacts,
not a claim that those artifacts were built from the untouched baseline commit.

The library addition is the missing transaction and supported native composition. Business approval,
credential verification, routing policy and durable receiver deduplication remain application code.
The result model, protocol registry, workflow engine and artifact service were not duplicated.

## External consumers

Run `pnpm exec nx run test-support:test-native-consumer` with Docker available. The target builds
packages, packs them, installs an npm consumer outside the workspace, typechecks package-root imports
without workspace aliases, and runs:

| Consumer                  | Contract exercised                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing-surface baseline | The exact gap between run/job admission and receipt recording                                                                                                                                                                   |
| SQLite daemon             | Native admission, SIGKILL during execution, reopen, receipt/status/result reconciliation without HTTP; no replay of abandoned input; fresh result survives another reopen                                                       |
| Backend approval worker   | One graph over actual HTTP and BullMQ, shared authorized thread, strict expected checkpoint, duplicate receipt after broker job removal, stale answer rejection, pending cancellation, chunk offsets/digest and complete output |
| Outcome receiver          | SQLite unique event IDs persisted across receiver reopen; publication-before-outbox-ack retry after broker job removal retains the same event ID                                                                                |

The shared native input/client types are compiled in `types.ts`. Broker-specific schemas live only
in `@skein-js/bullmq`. The transport's async permanent-rejection handling was corrected after the
packed consumer exposed a missing `await` inside its classification boundary.

## Storage and compatibility checks

The shared store conformance suite now exercises concurrent key admission, changed-input conflicts,
leased dispatch reclamation after acknowledgement and queue loss, stale-token acknowledgement,
terminal-to-running guards, expected-target reservation independent
of receipt expiry, atomic terminal/result/delivery settlement and malformed-payload rollback.
Memory, SQLite and real PostgreSQL run the same cases.

Real runtime integration uses separate Postgres/Redis assemblies to race two answers to one expected
interrupt and recover the original admission after producer enqueue failure. Another case abandons an
acknowledged in-memory queue job and recovers it from Postgres without adopting unrelated pending work.
Repeated execution checks terminal status before rollback, and observed lease loss prevents subsequent
checkpoint effects. Local recovery waiters cannot suppress cancellation broadcasts to a remote owner.
Competing state writes and resume admission also share the real Postgres execution gate; an answer
blocked behind a checkpoint update is rejected before admission. Postgres backend
termination checks that a lost execution lease raises its signal and another connection acquires the
thread. SQLite subprocess tests inspect persisted receipts and process-loss outbox obligations.
The optional admission signal was separately audited as a cooperative pre-COMMIT guard. Tests abort
before admission, during authorization and before Postgres COMMIT dispatch; a deferred trigger also
checks that abort racing an already-dispatched COMMIT preserves the accepted receipt.

Existing HTTP, official SDK, browser, MCP and A2A regressions remain required. Shared validators stay
below adapter-specific mapping. Native additions do not require inline/waiting/streaming callers to
accept queued receipts, and optional capabilities preserve existing third-party-driver behavior.

These consumers demonstrate correctness and API usability for two concrete hosts. They do not
establish broad adoption, global ordering or exactly-once external effects. Memory is process-local;
retention/deletion limit deduplication, and tool cancellation remains cooperative.

## Pre-PR code review

The review covered the public exports and optional driver capabilities, per-operation authorization,
receipt replay, dispatch leases, strict resume, atomic result/outbox settlement, snapshot restoration,
broker chunking and connection ownership. An additional lease-loss gap was found in rollback
cancellation: it held an execution claim but did not pass its loss signal to checkpoint replacement.
The cancellation path now passes that signal and retains the run row when rollback cannot complete;
its regression checks that observed lease loss causes no checkpoint erasure or replay.
The A2A wrapper also now maps only stale-target conflicts from shared validation, preserving
infrastructure failures rather than misclassifying storage outages as stale answers. Both cases have
regression coverage.

## Goal and security audit follow-up

The later audit reproduced five gaps with executable probes: a runtime resume checkpoint override,
state target changes during authorization, stop confirmation after swallowed rollback failure,
cancel dispatch acknowledgement after failed publication, and expiration during authorization.
Permanent native regressions now reject the override, freeze state resolution under the execution
lease, require positive stop proof, retain failed publication for retry and recheck admission deadlines.
They also exercise missed successful publications and native rollback receipt retention.
An additional probe reproduced a forged child `checkpoint_map` that replayed a preparation node
despite a correct root checkpoint. Native validation now checks every supplied namespace's current
tip at both boundaries. Memory tests include two levels of subgraphs, valid official nested pointers,
missing/foreign/stale coordinates and a map changed after admission. SQLite reopen and real Postgres
tests also reject the older child pointer and resume the original root without replaying preparation.

The real Postgres/Redis test cancels a service/HTTP-origin run from another replica while the owner's
pub/sub subscriber misses publication. Durable status observation stops execution, then the remote
execution gate confirms it. Existing third-party capability and ordinary cancellation behavior remain
covered. No new public method, interface requirement or configuration key was needed for these fixes.

The maintained `examples/native-transports` project is generated through Nx and imports public package
roots. Its integration target runs built entrypoints as separate processes, reopens SQLite, makes a
real HTTP request, exercises BullMQ start/resume/result retrieval, restarts both backend and receiver,
and verifies receipts/results and the durable event inbox. It complements the externally installed
packed consumers; it does not establish external adoption.

See [security and operations](./native-access-security.md) for the authority and data-retention review,
projection limits, cancellation observation cost and the remaining Zod dependency advisory. Compatible
dependency patches reduce the production audit from ten advisories to one high advisory; no claim of
a clean audit is made.

The original native-access PR addresses #64 and workstreams #65–#70. The compatibility follow-up
for #47 is recorded below.

## BullMQ and ioredis compatibility

On 26 October 2026, the following uncached installations passed locally on Node 24.15.0 and
Node 26.12.1. Node 26 ran in an isolated checkout with its own native dependencies. The
[raw dependency-resolution records](https://github.com/skein-js/skein-js/blob/main/packages/runtime-redis/compatibility-results.json)
are committed alongside the implementation; CI repeats the same nine legs on Linux.

| BullMQ | Direct ioredis | Node 24 | Node 26                             |
| ------ | -------------- | ------- | ----------------------------------- |
| 5.80.2 | 5.10.1         | Pass    | Pass                                |
| 5.80.2 | 6.0.0          | Pass    | Pass                                |
| 6.4.1  | 5.10.1         | Pass    | Pass                                |
| 6.4.1  | 6.0.0          | Pass    | Pass                                |
| 6.0.0  | 6.0.0          | Pass    | Minimum-release leg runs on Node 24 |

Each leg selects only the three direct dependency owners: Redis, the native BullMQ adapter and its
maintained example. BullMQ 5 retains its own ioredis 5.10.1 dependency even when the application's
direct client is ioredis 6. The runner asserts those resolved versions and restores manifests, the
lockfile and installed links after each selection.

The gates include lint/typecheck/unit/build, Redis and runtime integration, external command/outcome
behavior, native example subprocesses and an externally installed npm consumer. The consumer
typechecks a borrowed client without application casts, performs HTTP/BullMQ admission, strict resume,
receipt/result reconciliation, cancellation and digest-checked retrieval, and confirms that stopping
the adapter leaves its borrowed client and outcome queue usable. Redis coverage includes delivery
retries, pub/sub replay, thread events, abort publication and unused/startup/shutdown ownership.

Two compatibility adaptations are exercised: sorted-set indexes use string wire arguments accepted
by both ioredis majors, and the adapter's existing connection input additively accepts the directly
installed Redis client type. BullMQ 5's nominal connector types are adapted at the vendor boundary;
the application does not need a cast. The deterministic acknowledgement-startup regression uses
BullMQ 6's public backend status operation and retains its v5 barrier.

Run a selection with:

```sh
pnpm exec nx run test-support:test-redis-compatibility --bullmq=6.4.1 --ioredis=6.0.0
```

See [the testing guide](./testing.md#redis-dependency-compatibility) for matrix lifecycle and artifacts.

### Review regressions

The follow-up review reproduced a scheduling error with an existing BullMQ job: a 2,500 ms native
retry backoff was shortened to about 1,000 ms by partition reconciliation. Promotion now consumes a
marker for a specific Skein-parked dequeue attempt, leaving genuine retries to BullMQ. The regression
checks the original backoff floor and successor order against real Redis.

A fresh packed pnpm consumer also reproduced a declaration failure for a borrowed ioredis 6 `Cluster`
with BullMQ 5. The additive connection input now covers both `Redis` and `Cluster`. Packed declaration
checks and a real single-node Redis Cluster test cover command admission and borrowed-client/queue
ownership after shutdown; the latter does not claim cluster failover coverage.

A host-only BullMQ major upgrade exposed another declaration problem: pnpm can retain the adapter's
v5 dependency while the application's borrowed outcome queue is v6. The adapter now requires only
the queue's publishing operations, while `BullMqTransportOptions` keeps its original complete Queue
type as the default. A packed consumer retains its pnpm lockfile through the major upgrade, then
typechecks and exercises command acknowledgements, outcome publication and borrowed-client ownership
across the installed versions.

Additional regressions exercise two consumers sharing a partition, legacy queue fallback,
cancellation during claim acquisition, both execution paths losing ownership during checkpoint
reads/graph loading, and permanent rejection of oversized commands or caller-supplied authority
before native admission. LangGraph still owns graph execution, commands and checkpoint handling;
the review adds no graph runtime or wire fields. The production dependency audit still reports the
previously documented Zod advisory, so this is not a clean dependency-security audit.

Review of the modified Postgres gate also reproduced a pre-existing process-crash path: a TCP drop
during an unlock query emitted an unhandled client error after the gate had detached its listener.
The listener now stays attached through cleanup and is removed immediately before pool handoff or
discard. Subprocess tests fault the actual TCP connection during release for both claim methods;
both exited unsuccessfully before the fix and cleanly afterward.
