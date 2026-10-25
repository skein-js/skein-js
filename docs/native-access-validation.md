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

The PR closes #64 and workstreams #65–#70. BullMQ/ioredis 6 compatibility remains #47.
