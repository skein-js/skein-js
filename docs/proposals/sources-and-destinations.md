# Proposal — Decoupled sources and destinations

> Audited in the same session as the design discussion it records. Phase 1 passed; any public Phase 2
> surface requires a new audit based on evidence from real consumers.

## Problem

`@skein-js/channels` models one integration object that receives an event and, when the run settles,
delivers the reply. That is the right default for WhatsApp and Slack conversations, but it couples
the inbound provider to the outbound provider.

Two motivating workflows need a different shape:

```text
Garatropic Relay
email | upload | WhatsApp -> classify -> extract -> check -> approve -> ERP | accounting | KRA

Dayweaver
calendar | email | tasks -> prioritize -> ask/approve -> WhatsApp | email | calendar action
```

The application graph must choose the destination after processing. The source must not need the
destination's SDK, credentials or target type.

## Capability inventory

- Prove an inbound email can produce a durable WhatsApp delivery without the email source
  implementing WhatsApp delivery.
- Prove a graph can select a configured destination and provide a structured payload after
  processing.
- Preserve channel request verification, authorization, event deduplication, thread correlation,
  interrupt/resume and durable at-least-once delivery.
- Support a non-conversational business workflow without adding a workflow DSL.
- Record transport-neutral event ingestion as separate future research; the HTTP-only proof does not
  claim to answer it.
- Keep existing `Channel`, `InboundEvent.replyTo` and `replyWith` behavior compatible.
- Add a maintained, offline proof-of-concept example and tests.
- Conditionally add only the smallest public primitive the proof cannot implement correctly.

## Claim ledger

- A `Channel` currently owns `verify`, `parseEvent`, optional `deliver`, optional `signals`, and
  optional `onSignal` in one public interface.
- A channel delivery target currently encodes the originating channel name and
  `InboundEvent.replyTo`.
- The channel dispatcher currently looks up the originating channel and calls that channel's
  `deliver` method.
- `replyWith` lets a graph declare one arbitrary reply value and the run engine includes it in the
  durable delivery payload.
- A run currently has at most one `webhook` delivery target.
- A caller cannot name a `skein+channel://` target through the run-create API.
- The existing outbox records a run callback in the same operation that finalizes the run when the
  store implements `finalizeWithDelivery`.
- Existing public APIs are sufficient to implement a local destination registry behind one composed
  channel's `deliver` method.
- Existing public APIs do not expose the channel pipeline after HTTP verification/parsing as a
  transport-neutral normalized-event ingestion function.
- LangGraph supplies graph control flow, checkpointing and `interrupt`; this proposal does not need a
  second workflow model.
- Provider polling, subscription renewal, credential storage and business routing rules belong to
  application code or provider packages, not Skein core.

## Phase 1 — proof with no published API

Add an offline example, tentatively `examples/decoupled-delivery`, containing:

- `email` and `whatsapp` source objects with only request verification and event parsing;
- independent `email` and `whatsapp` destination objects, deliberately separate from both sources;
- an example-local `composeSourceChannel` adapter that presents the existing `Channel` shape to
  Skein;
- an example-local `declareDestinationDelivery` envelope written through the existing `replyWith`
  helper;
- a LangGraph graph that classifies each event, conditionally routes an inbound email to WhatsApp or
  an inbound WhatsApp instruction to email, and interrupts when approval is required;
- deterministic fake provider clients so the example and its tests require no network or API keys.

The composed channel's `deliver` method reads the graph-declared envelope and dispatches through the
example-local destination registry. The source does not import or reference a destination.

The proof must test:

1. An inbound email settles into a WhatsApp delivery selected by the graph.
2. An inbound WhatsApp instruction settles into an email delivery selected by the same graph.
3. A low-priority email produces no outbound delivery, proving routing is conditional rather than a
   static source-to-destination binding.
4. Retrying the same provider event creates one run and one destination call.
5. An approval-required event parks durably and exposes an approval request.
6. Resuming the same thread produces the approved destination delivery.
7. A missing or malformed graph-declared destination fails visibly rather than silently dropping an
   effect.
8. A destination that fails its first attempt is retried through the real outbox path, receives the
   same `runId` as its idempotency key, and records one eventual external effect.

The approval path is deliberately cross-directional: an inbound email may declare an approval
request for the WhatsApp destination before `interrupt()`. A WhatsApp reply addresses the same
explicit thread id, resumes the graph, and the resumed run may declare an email delivery. An
interrupted run with no declared destination envelope remains visible through the existing
console/API and is not treated as a malformed delivery.

Before extracting any public primitive, repeat one slice in throwaway consumer code outside the
repository example and record the composition line count plus the exact line—if any—where public API
cannot preserve a required correctness property. A local helper's existence or name is not evidence
by itself.

### Kill condition

If all Phase 1 success criteria pass and the external scratch consumer reaches no correctness
boundary, stop after the example and documentation. Do not publish `Source`, `Destination`,
`deliverTo`, a registry or new configuration keys.

## Phase 2 — extract only a demonstrated missing primitive

Phase 2 is not authorized by this proposal merely because a local helper exists. It begins only when
Phase 1 identifies a correctness property application code cannot obtain from the current public
surface.

Candidate A is a graph-declared durable delivery primitive. It is eligible only if the Phase 1
`replyWith` envelope cannot provide the required durability, validation or routing without importing
private internals. The narrowest candidate is one helper that creates a reserved delivery envelope
and one dispatcher wrapper that resolves configured application-owned destinations. Interfaces and
configuration are deferred until two distinct destinations prove their common contract.

Normalized event ingestion is not a Phase 1 deliverable. A later, separate spike must choose a
concrete non-HTTP Dayweaver producer (poller, subscription consumer or embedded scheduler), first try
the existing cron, invoke and idempotent run APIs, and document the exact correctness boundary. Only
then may a separately audited plan consider an in-process function accepting a normalized event plus
an already-authenticated context. Source lifecycle management remains outside Skein.

Any Phase 2 surface receives its own audit after the proof supplies concrete signatures and measured
user code.

## Non-goals

- No visual workflow builder or workflow DSL.
- No provider SDKs, OAuth flows, credential vault or connector marketplace.
- No server-owned business routing, approval policy or identity mapping.
- No polling scheduler or source lifecycle manager; existing crons or external workers drive polls.
- No exactly-once claim for external side effects; destinations remain at-least-once. While the proof
  has one callback per run, it uses the stable `runId` as its idempotency key because the channel
  callback contract does not expose the outbox delivery id.
- No arbitrary URL or unconfigured destination selected from untrusted input.
- No large documents in graph state; examples keep bytes in object storage and carry references.
- No promise of multiple deliveries per run in the first proof.
- No guarantee that an external action whose result the graph needs is a destination; that remains a
  graph node/tool with its own idempotency policy.

## Success criteria

- The source and both destinations have no imports from each other; source modules import no
  destination SDK or destination target type, and receive no destination credentials or routing
  configuration.
- Destination selection occurs in the graph after processing, not in the inbound parser.
- The proof uses the real Skein channel pipeline, run engine and delivery outbox path.
- Reverting event deduplication makes the duplicate-delivery test fail.
- A deterministic destination-fails-once test proves retry through the real outbox path, the same
  `runId` on every attempt, and one eventual external effect. Replacing the durable path with an
  unawaited direct call makes it fail.
- The example passes its Nx `lint`, `typecheck`, `test` and `build` targets where present.
- The example drives the resolved runtime's real channel handler rather than calling the local
  composition helper directly.
- The proof records application glue line count and any inaccessible correctness step before Phase 2
  can be proposed.
- Phase 1 adds no exported package symbol, config key, route, header or wire field.

## Phase 1 result

The proof uses only shipped APIs and adds no package surface. The reusable application-local
composition is 96 lines across `workflow-delivery.ts`, the registry and two five-line channel
wrappers; 79 of those lines are the typed, documented composition helper and Zod boundary. No
correctness step requires a private import.

The proof passes seven end-to-end tests through the resolved runtime's real channel handler:
email-to-WhatsApp, WhatsApp-to-email, conditional no-delivery, inbound deduplication, cross-channel
interrupt/resume, outbound retry and visible unknown-destination failure. No package API is proposed:
keep the composition example-local until Garatropic and Dayweaver provide two real consumers whose
duplicated code demonstrates a narrower shared primitive.

## Phase 1B — multi-party refund approval proof

Extend the same example with a refund request that requires independent decisions from HR, a
manager and Finance. This phase remains application-local: LangGraph owns pause/resume and graph
control flow; the example owns the approval policy, role-to-principal mapping and message wording.

The graph extracts the refund request and fans out to three parallel approval nodes with LangGraph
`Send`. Each node calls `interrupt()` once, so the checkpoint itself is the durable human-task record
and the three simultaneously pending interrupts have independently addressable ids. Replies may
arrive in any order. Each verified WhatsApp sender maps to a server-owned principal and role; a
resume targets only that role's interrupt id, and the graph remains interrupted while any other
approval node is pending. After all three nodes settle, the graph applies its approval policy and
sends the final result by email.

No separate `HumanTask` store, compare-and-set loop or approval service is introduced. Approval
thresholds, required roles, quorum, ordering, delegation and escalation remain graph/application
policy. This proof deliberately uses one simultaneous approval gate per refund thread: upstream
interrupt ids identify parallel pending tasks, but sequential `interrupt()` calls in the same node
may reuse an id and are not a safe business-instance identifier.

The three WhatsApp requests travel in one application-local batch destination envelope and therefore
share one Skein outbox retry unit. Each recipient send uses a stable task-scoped idempotency key so a
partial provider failure followed by retry does not duplicate earlier successful sends. This phase
does not claim three independently replayable Skein delivery records; needing that property activates
the existing Phase 2 boundary for a separately audited multi-delivery primitive.

The proof must test:

1. HR, manager and Finance appear as three simultaneously pending interrupts, may decide in any
   order, and the graph remains interrupted until all required approvals exist.
2. A verified sender cannot decide a task assigned to another principal or role.
3. Retrying the same provider event records one decision.
4. A rejection contributes a rejected decision while the remaining pending tasks can still complete;
   after the fan-in the refund resolves as rejected.
5. Two concurrent approval replies create at most one active resume run and the refused event can be
   retried after the winning run settles.
6. A duplicate reply for a completed parallel interrupt cannot answer another role's pending
   interrupt.
7. The proof uses checkpoint-backed interrupts and documents that production requires a durable
   checkpointer; existing checkpointer integration owns restart durability.
8. Every decision records the server-derived actor, outcome, provider event id and timestamp.
9. A partial WhatsApp batch failure retries with stable per-role idempotency keys and records one
   external effect per approval request.

### Phase 1B kill condition

If parallel LangGraph interrupts plus shipped channel/run guards provide authorization, idempotency,
concurrent resume handling and duplicate-reply isolation, add only the recipe. Stop if the proof
needs conditional store mutation, a sequential-interrupt identity guard, independently replayable
per-recipient delivery records, or a new non-resuming channel action; propose only the narrowest
missing primitive, with its failing consumer test, in a separately audited Phase 2. Do not add an
approval engine, approval policy DSL, new `langgraph.json` key or provider-specific identity model.

### Phase 1B result

The proof reached no missing Skein primitive. Three parallel `Send` tasks become independently
addressable LangGraph interrupts, and a resume map keyed by one interrupt id advances only that task.
Skein already preserves the opaque resume value, injects the verified channel principal into the
graph and atomically guards resume-run creation against thread status and an active run.

The extended example passes fourteen offline tests. In addition to Phase 1, they cover any-order
HR/manager/Finance approval, wrong-role rejection, duplicate reply isolation, concurrent reply
serialization and retry, rejected refund policy, decision audit fields, and partial WhatsApp batch
retry with one effect per task-scoped provider idempotency key. It adds no package export, route,
wire field, store method or config key. Independent per-recipient outbox records remain a possible
future primitive only if a real consumer requires that stronger retry/replay unit.

## Open questions

- Is a graph-declared delivery envelope a legitimate use of `replyWith`, or does naming it “reply”
  make the recipe misleading enough to justify a narrower alias later?
- Which concrete Dayweaver producer should be used by the later normalized-ingestion spike beyond
  crons, channels and idempotent run creation?
- Can a graph-declared delivery envelope represent more than one independently retryable effect, or
  does fan-out require a separately audited delivery primitive?

## Obligations if a public primitive survives

- New third-party-implemented interfaces require two consumers and a conformance suite.
- A new `langgraph.json` key requires Zod validation, loader tests, runtime wiring and documentation.
- New HTTP behavior must work across Express, Fastify, NestJS, Next.js and Fetch adapters.
- A new delivery store shape requires memory and Postgres implementations, conformance tests,
  migrations and compiled-asset verification.
- User-facing documentation changes require regenerating `llms-full.txt` with `pnpm docs:llms`.
