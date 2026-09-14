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
- An external HTTP caller cannot name a `skein+channel://` target through the validated run-create
  API. Direct `RunService` calls are less constrained, but the internal channel target remains a
  server-derived implementation detail rather than a supported application input.
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
composition is small and isolated in `workflow-delivery.ts`, the registry and two five-line channel
wrappers. No correctness step requires a private import.

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

## Phase 1C — runnable operations-relay demo and second-consumer gate

Turn the proof into something a developer can run and inspect without reading its test suite. The
recommended demo is a customer-refund relay because one short scenario exercises every important
boundary: an email webhook starts the workflow, the graph normalizes and validates the refund,
WhatsApp carries three independently addressed human decisions, and email receives the final result.
It is realistic enough to expose identity, retry and audit requirements while remaining deterministic
and free of provider credentials.

Add an offline demo command to `examples/decoupled-delivery` that:

1. resolves the same Skein runtime assembly and channel-handler path used by production adapters,
   with in-memory drivers for the offline demonstration;
2. submits a representative refund email through the email channel route;
3. prints the three pending HR, manager and Finance approval requests;
4. submits authenticated WhatsApp approvals in a deliberately different order; and
5. prints the final email plus the checkpointed decision audit trail.

The demo must call the runtime handler rather than the graph or destination helper directly. Provider
clients remain recording fakes; the command demonstrates orchestration semantics, not Twilio or email
account setup. Tests keep asserting the outcome, while the demo provides a human-readable trace.
This is also an integration invariant: LangGraph owns graph execution, checkpointing, `Send` and
`interrupt`; Skein's normal runtime path owns verification, authorization, deduplication, thread/run
coordination, the LangGraph checkpoint bridge and delivery. The demo must not replace either layer
with parallel example machinery.

In parallel with using this recipe in Garatropic, build a small Dayweaver spike as the second
consumer: an external scheduler or poller reads mock calendar and email items, starts a durable run
through `@langchain/langgraph-sdk`: first `Client.threads.create` with the deterministic thread id and
`ifExists: "do_nothing"`, then `Client.runs.create` with
`streamMode: ["values", "custom"]`, a stable source-item `Idempotency-Key` in the client's default
headers, and an application HTTP callback that dispatches the graph result to WhatsApp. Requesting
`custom` is what captures a `replyWith` declaration; ordinary runs default to `values` only. Reuse
the polling/idempotent-run pattern already demonstrated by `examples/triage-agent`; do not add a
poller store, scheduler abstraction or custom run client. A WhatsApp reply continues through the
existing channel path by naming the same deterministic thread id used by the thread-scoped run. The
simplified `/invoke` endpoint is explicitly unsuitable here: it has no durable run row or outbox and
does not capture `replyWith` declarations. Do not force polled events through the HTTP webhook parser
merely to call them a source, and do not treat the server-derived `skein+channel://` target as a
supported run-create input.

The application callback must configure Skein webhook signing, verify the raw request with the
existing `verifySkeinSignature` helper, propagate `X-Skein-Delivery-Id` as the fake WhatsApp
provider's idempotency key, and return `2xx` only after the provider accepts the effect. The fake
provider must atomically consume that key so concurrent callbacks and a retry after “provider
accepted, receiver failed before `2xx`” record one external effect. Its offline tests must reject an
invalid signature, prove that retrying one source item returns the same run, cover those two callback
races, and observe one provider effect. Do not implement custom HMAC or use the run id where the
callback already supplies the stronger delivery id. Real destinations that do not accept an
idempotency key remain at-least-once; the receiver cannot manufacture exactly-once delivery with a
check-then-send table.

At least one Dayweaver test must traverse the complete public path: start ephemeral real Agent
Protocol and callback servers, create the deterministic thread and run through the installed SDK,
wait for the real signed callback, and assert the run/thread identity, graph-declared WhatsApp
envelope, genuine delivery id and signature, and one recorded provider effect. It must fail if
`custom`, `replyWith`, the webhook, worker/outbox, signature verification or dispatch is removed.
Receiver-focused tests alone do not prove this integration.

The Dayweaver graph must declare the briefing/approval delivery and then call LangGraph
`interrupt()`. A second end-to-end test posts an authenticated reply through the real WhatsApp
channel using the same explicit thread id and asserts that Skein creates a resume run, propagates the
verified principal, clears the interrupt and reaches the graph's declared final destination. It must
fail if channel verification, thread correlation, resume mapping, LangGraph checkpointing or the
Skein-LangGraph bridge is bypassed.

The spike must also document the narrow crash window between creating a run and Skein recording its
idempotency response: a client retry is safe once the response record exists, but the API does not
claim exactly-once creation across every process-failure boundary.

Record the duplicated composition code and any inaccessible correctness property in both consumers.
Dayweaver can supply evidence only for the destination-envelope and callback-dispatch seam because
its polled input correctly bypasses channel ingestion. It cannot justify extracting the inbound
source adapter. A second genuinely inbound-channel consumer would be required for that. Any later
candidate must be narrowed to exactly the boundary duplicated by two consumers. Destination
credentials, registry construction and routing policy remain application-owned. An extraction must
not change the `Channel` interface, configuration, wire protocol or one-callback-per-run delivery
semantics.

### Phase 1C extraction gate

Keep each helper example-local unless two consumers duplicate that exact seam and at least one of
these is true:

- application code cannot preserve an existing Skein correctness guarantee through public APIs; or
- the identical boundary code remains substantial after provider-specific validation and business
  policy are removed.

For a destination declaration/callback dispatcher, Garatropic and Dayweaver may be the two
consumers. For `composeSourceChannel`, Dayweaver does not count; require another inbound-channel
consumer.

Independently replayable delivery records and transport-neutral authenticated ingestion are separate
capabilities. Either requires its own proposal, failing consumer test and audit; neither may be
smuggled into the ergonomic helper.

### Phase 1C documentation and quality gate

- Add an explicit Nx `demo` target for `examples/decoupled-delivery`, smoke-test its callable demo
  function, and document the exact command, representative human-readable trace, what is real versus
  fake, and why the in-memory run is not restart-durable in its README.
- Give the Dayweaver spike its own private example and README with exact commands, the complete
  public-path topology, deterministic thread correlation, callback signing and idempotency duties,
  and the at-least-once caveat.
- List both examples in `docs/recipes/index.md`.
- Add a short cross-provider routing section to `docs/channels.md` linking the recipe and stating that
  the composition remains example-local rather than a public `Source`/`Destination` API.
- Run the examples' Nx lint, typecheck and test targets plus the refund demo target. Regenerate the
  curated documentation bundle with `pnpm docs:llms` after editing the user-facing docs.

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
