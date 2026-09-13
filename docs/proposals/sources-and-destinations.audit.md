# Audit — Decoupled sources, destinations and parallel approvals

## Verdict

**PASS for Phase 1 and revised Phase 1B.** Target:
[`sources-and-destinations.md`](./sources-and-destinations.md), authored and revised in the same
sessions as these audits. Phase 2 remains unauthorised and requires a new audit based on evidence
from a real consumer.

Scope delta: Phase 1 reduces source/destination decoupling to one maintained example. Phase 1B
reduces multi-party coordination to LangGraph's existing parallel interrupts plus application-owned
authorization and policy; no human-task service survives.

Surface delta: zero permanent exported symbols, config keys, routes, headers, wire fields or
interface methods.

## Rollability ledger

| Capability                                                     | Owner            | Today                  | Existing mechanism                                                      | Verdict                         |
| -------------------------------------------------------------- | ---------------- | ---------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| Email source durably routes to WhatsApp                        | Application      | Yes                    | Local composed `Channel`, `replyWith`, existing outbox                  | Recipe                          |
| Graph selects a structured destination                         | Application      | Yes                    | Application-local Zod envelope and registry                             | Recipe                          |
| Preserve verification, auth, dedup, threads, HITL and delivery | Skein            | Yes                    | Existing channel pipeline, guarded run creation and outbox              | Reuse and test                  |
| Non-chat workflow without a DSL                                | Application      | Yes                    | LangGraph `StateGraph`, conditional edges and `interrupt`               | Reuse                           |
| Maintained offline proof                                       | Skein onboarding | No                     | Existing example conventions                                            | Build example                   |
| Three durable approval tasks                                   | Application      | Yes                    | Three parallel `Send` tasks, each calling `interrupt()` once            | Reuse                           |
| Deliver three approval requests                                | Application      | Yes, as one retry unit | One aggregate callback and per-interrupt provider idempotency           | Recipe with explicit semantics  |
| Accept decisions in any order                                  | Application      | Yes                    | Resume map keyed by interrupt id                                        | Reuse                           |
| Authorize a sender for one role                                | Application      | Yes                    | Verified `ChannelPrincipal` injected as server-owned graph identity     | Recipe                          |
| Keep other approvals pending after one decision                | Application      | Yes                    | Targeted resume advances only the matching parallel task                | Reuse                           |
| Serialize concurrent replies                                   | Skein            | Yes                    | Event claim plus atomic thread-status/active-run guard                  | Reuse and test                  |
| Prevent a duplicate answer consuming another role              | Application      | Yes                    | Completed interrupt id is not consumed by another pending task          | Reuse and test                  |
| Persist pending work across restart                            | Skein deployment | Yes                    | Durable LangGraph checkpointer and Postgres runtime                     | Document production requirement |
| Record actor/outcome/event/time                                | Application      | Yes                    | Approval node writes decision into graph state                          | Recipe                          |
| Independently replay each recipient delivery                   | Undetermined     | No                     | Current run has one callback/outbox record                              | Deferred; only if demanded      |
| Transport-neutral normalized ingestion                         | Undetermined     | Partly                 | Runs, crons and invoke exist; complete channel pipeline is not exported | Separate Dayweaver spike        |

The constructive consumer reaches completion without a missing primitive. It stops only if a future
consumer requires a separate Skein delivery row per recipient or sequential same-node interrupts as
stable business identifiers.

## Surface ledger

| Surface                                       | Status              | Narrow form                            | Withdrawal cost                   | Evidence                                     |
| --------------------------------------------- | ------------------- | -------------------------------------- | --------------------------------- | -------------------------------------------- |
| `examples/decoupled-delivery`                 | Added               | One maintained offline example         | Documentation expectation only    | Email, WhatsApp and refund proof             |
| `composeSourceChannel`                        | Example-local       | Function over `Channel`                | Local rename/removal              | Two source wrappers                          |
| `declareDestinationDelivery`                  | Example-local       | Wrapper over `replyWith`               | Local rename/removal              | Multiple graph branches                      |
| Destination registry                          | Example-local       | `ReadonlyMap`                          | Local rename/removal              | Email, WhatsApp and batch destinations       |
| Approval role/decision shapes                 | Example-local       | Graph state and interrupt payloads     | Local rename/removal              | One refund workflow                          |
| Public `Source`, `Destination` or `HumanTask` | Prohibited          | Keep structural and local              | Would become permanent aliases    | No second consumer                           |
| Approval engine or policy DSL                 | Prohibited          | Application graph                      | Permanent business-policy surface | Existing graph expresses it                  |
| CAS store method                              | Not needed          | —                                      | Would burden every driver         | Parallel interrupts remove the mutation race |
| Exact sequential-interrupt guard              | Not needed by proof | One simultaneous gate per thread       | Route/store compatibility forever | Parallel interrupt ids are distinct          |
| Multiple-delivery outbox API                  | Deferred            | Aggregate callback plus recipient keys | Store/worker/adapter permanence   | Stronger retry unit not demanded yet         |
| New config, route, header or wire field       | None                | —                                      | —                                 | Existing contracts suffice                   |

## Blocking findings

None after revision.

The first Phase 1B draft was blocked because it proposed application-store human tasks without
compare-and-set, required a non-resuming channel action that did not exist, used an interrupt id as a
sequential business-instance id, and left multi-recipient delivery semantics unstated. The revision
cleared those findings by reusing simultaneous LangGraph interrupts and explicitly choosing one
aggregate outbox retry unit with recipient-level idempotency.

## Advisories incorporated

- The example enables the existing `auth.path` seam so verified channel principals reach graph code.
- Task authorization stays in the graph; `threads:create_run` authorization is not presented as an
  approval ownership check.
- The proof documents that simultaneous interrupt ids address parallel tasks, while sequential
  interrupts in one node may reuse an id.
- Partial batch retry is tested after one recipient succeeds.
- The offline memory test does not claim restart durability; the README requires a durable store and
  checkpointer in production.
- Independent recipient delivery records remain a kill condition, not an accidental API addition.

## Premises

Confirmed by code and runtime probes:

- `Channel` owns verification, parsing and optional delivery in one interface.
- `replyWith` carries one arbitrary, last-write-wins value into one run callback.
- Channel delivery executes through the existing outbox path.
- A verified `ChannelPrincipal` becomes the server-owned `langgraph_auth_user` when auth is enabled.
- `InboundEvent.resumeWith` is opaque and reaches LangGraph's `Command.resume` unchanged.
- Three simultaneous `Send` tasks produce three distinct interrupt ids; an id-keyed resume map
  advances only the addressed task and leaves the others pending.
- The thread-status and active-run guard admits at most one concurrent resume run.
- `StoreRepo.put` is unconditional and supplies no compare-and-set operation.
- One run currently has one callback/outbox retry unit.

Falsified premises from the first draft:

- An upstream interrupt id does not identify sequential interrupt occurrences in the same node; the
  id may repeat because it is derived from the checkpoint namespace.
- The generic long-term store cannot safely coordinate concurrent mutable human-task records through
  read-then-write.
- A single delivery declaration does not create three independently retryable outbox records.

## Prior-art search

The audit inspected installed `@langchain/langgraph`, `@langchain/langgraph-sdk`, checkpoint packages,
`@langchain/langgraph-api`, every Skein package index, the channel pipeline, run guards and delivery
engine. Reused symbols include `StateGraph`, `Send`, `interrupt`, id-keyed `Command.resume`, the
LangGraph checkpointer, `ChannelPrincipal`, `InboundEvent.resumeWith`, `replyWith` and the existing
outbox. `HumanInterrupt`, LangGraph `task()`, `Send` as an external transport, store `batch`, and SDK
`respondAll` as a sequential-instance guard were considered and rejected for mismatched semantics.

## Obligations

The implemented phases owe an Nx example, inferred lint/test targets, explicit typecheck, tests
through the resolved runtime handler, formatting and documentation. They owe no storage-driver,
adapter, route, config or conformance changes because no package contract changes. A future
multi-delivery primitive would require both stores, conformance, Postgres integration/migrations,
delivery-worker behavior, replay APIs and all runtime adapters. A future normalized inbound action
would require channel conformance, auth/dedup tests and adapter/runtime parity.

## Strongest counter-cases considered

- Publishing `Source`, `Destination` or `HumanTask` was rejected because application code composes
  the behavior and only one consumer exists.
- A custom task table was rejected because it creates a CAS problem already solved by checkpointed
  parallel graph tasks.
- Sequential interrupts were rejected for this gate because their ids may repeat.
- Three direct provider calls were rejected as three Skein deliveries; the example honestly treats
  them as one aggregate callback with per-recipient idempotency.
- A server role model was rejected because identity mapping and approval authority are deployment
  policy carried by the existing auth seam.
