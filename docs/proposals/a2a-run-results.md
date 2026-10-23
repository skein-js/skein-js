# Durable A2A task results: implementation amendment

Audited on 23 October 2026 against the approved LangGraph compatibility plan. All six independent
`audit-plan` dimensions passed after the commitments below were added. This is an additive
persistence amendment; it adds no task database, scheduler, deployment policy or Agent Protocol Run
wire field.

## Gate before adding surface

First build an official-client A2A adapter against existing authorized execution/resource records.
Send a task, start another turn in the same context, prune history with `keep_latest`, and retrieve
the first task, including after SQLite reopening. Compare its original artifact parts. If that
passes, omit the result primitive and keep the projection-only adapter. Do not introduce an adapter
cache, Store.items mirror or after-settlement output capture to make the baseline pass.

The verified premise is that Run rows store status/error and execution kwargs, while final values,
interrupts and declared reply exist only in the immediate engine outcome. Delivery payloads are
cleared after delivery; event replay expires; pruning removes earlier checkpoints. These records
cannot be assumed to retain the first task’s output.

## Narrow persistence contract if the gate fails

- Export `RunResult` through core’s existing root surface. Reuse `DefaultValues`, `Interrupt` and
  `Checkpoint`: `{ values, interrupts?, reply?, checkpoint? }`. Share it with engine outcome and
  settlement payloads. Status/error remain on Run.
- Add optional `RunRepo.recordResult(runId, result): Promise<void>` and
  `getResult(runId): Promise<RunResult | null>`. Writes to unknown/deleted runs are no-ops; missing
  results read as null. Writes are atomic first-write-wins and reads/writes use defensive,
  wire-normalized JSON copies. Serialization failure fails capture before terminal success.
- Capture only server-marked A2A runs before the terminal status write. The marker, task lineage and
  body-to-input transfer stay internal. JSON extras cannot request capture. Rendering follows the
  effective terminal status so a cancellation winner never appears completed.
- Store results beside existing runs in memory, SQLite and Postgres. Keep schema upgrades additive;
  regenerate the compiled Postgres migration asset through Nx. Ordinary run serialization excludes
  results.
- Optional snapshot result entries tolerate old snapshots, ignore orphan results, attach only to
  existing/imported runs and never replace an existing first-written result. Run/thread erasure
  cascades results. Thread copy reattaches results to new run IDs and remaps lineage/checkpoint
  thread coordinates.
- Preserve optional-method absence through wrappers. A2A admission requires both methods before
  creating any thread/run. Result access requires the same scoped run read/write as other run
  operations; private lineage grants no authority.
- Keep the first run ID as task ID. Continuations use existing run admission, queue and cancellation.
  Resume validates the exact persisted checkpoint and current interrupted run under existing
  `withThreadExecution`, using existing saver lookup and checkpoint projection. Reject stale or
  pruned checkpoints; result values cannot resurrect them.

## Evidence and validation

The ownership/reuse audits inspected `RunRepo`, `RunOutcome`, checkpoint history/projection,
`@langchain/langgraph-api` public storage declarations, A2A SDK TaskStore/DatabaseTaskStore and the
existing delivery and StoreRepo contracts. SDK task storage introduces another task authority and
uses overwrite semantics; existing kwargs describe execution input. Neither substitutes for this
narrow result contract.

The delivery tranche must include shared conformance on all three stores; SQLite real-file reopen
and subprocess crash; Postgres migrations/container tests; snapshot/hydrate/restore/dev import;
run/thread/rollback erasure and thread copy; scoped result reads/writes; unsupported custom drivers;
settlement reentry and cancellation races. Keep the original official-client failing baseline in
this report before introducing the primitive.

### Baseline gate result

On 23 October 2026 the official `@a2a-js/sdk` 1.3.0 client reproducer failed on both memory and
SQLite after reopening. `GetTask(firstTaskId)` returned `{value: "echo: second"}` where the original
artifact contained `{value: "echo: first"}`. The test used existing run/thread/checkpoint records
only, with no adapter cache or output mirror. Nx command:
`nx test agent-protocol --args='run src/interop/a2a.test.ts'`. Both artifact-equality assertions failed.
The result primitive is therefore retained in the implementation.
