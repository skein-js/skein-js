# Decoupled email and WhatsApp delivery

This offline example proves that a Skein channel's inbound source and outbound destination do not
have to be the same provider:

```text
email source ----\                         /----> WhatsApp destination
                  -> one LangGraph workflow
WhatsApp source -/                         \----> email destination
```

The graph conditionally chooses the destination. A low-priority email emits nothing; an important
email produces a WhatsApp notification; a WhatsApp instruction produces an email. A refund request
fans out to three parallel LangGraph interrupts for HR, a manager and Finance. One durable callback
sends the three WhatsApp requests; each reply targets its own interrupt id, so decisions can arrive
in any order while the graph remains parked for the other approvers. The final resumed run declares
the result email.

```text
refund email -> extract -> HR interrupt ---------\
                         Manager interrupt -------+-> policy -> result email
                         Finance interrupt -------/
```

The verified WhatsApp sender becomes the run's server-owned principal. Each approval node compares
that identity with its assigned principal before accepting the decision. The decision saved in graph
state contains the role, actor, outcome, provider event id and timestamp, giving the workflow an
auditable checkpoint without introducing a second task store or approval engine.

The approval requests intentionally share one Skein outbox record. The batch destination assigns a
stable `${initialRunId}:${interruptId}` idempotency key to each provider send, so replay after partial
failure does not duplicate a recipient that already succeeded. This proves safe aggregate fan-out,
not independently replayable delivery records per recipient.

The example uses Skein's public `composeRoutedChannel` and
`declareChannelDestinationDelivery` helpers. They compose the existing contracts:

- channel verification, authorization, event deduplication and thread start/resume;
- `replyWith(unknown)` for one graph-declared structured result;
- the existing channel callback and transactional delivery outbox;
- destination-specific Zod validation and `runId` idempotency.

The provider clients are recording fakes, so no credentials or network are required.

## Try the browser playground

```bash
pnpm exec nx run example-decoupled-delivery:ui
```

Open `http://127.0.0.1:3030`. The playground provides three runnable scenarios: an important email
routed to WhatsApp, a WhatsApp instruction routed to email, and a refund that pauses for HR,
manager and Finance. In the refund scenario, the approval buttons submit authenticated WhatsApp
events to the exact interrupt ids returned by LangGraph.

The small local server keeps the example self-contained. Browser requests never receive the fake
provider secrets: it proxies source events to the same resolved Skein channel handlers exercised by
the CLI demo, then exposes the in-memory thread state and recorded destination effects for display.

## Run the refund relay

```bash
pnpm exec nx run example-decoupled-delivery:demo
```

The command sends a representative refund email through Skein's resolved email channel handler,
waits for the real LangGraph graph to pause on three parallel interrupts, answers them through the
resolved WhatsApp channel handler in Finance → HR → Manager order, and prints the final email plus
the checkpointed decision audit trail.

The orchestration path is real: channel verification, Skein auth and event deduplication, thread/run
coordination, the LangGraph checkpoint bridge, `Send`/`interrupt`, graph-declared `replyWith`, and the
Skein callback/outbox path all execute. Only the provider edges are fake—the example records the
email and WhatsApp effects locally instead of contacting provider APIs.

Representative trace:

```text
1. Email received: refund KES 27,500 for a duplicate order charge.
2. LangGraph paused on three parallel approvals:
   - hr -> whatsapp:+254700000011
   - manager -> whatsapp:+254700000012
   - finance -> whatsapp:+254700000013
3. finance approves over authenticated WhatsApp.
3. hr approves over authenticated WhatsApp.
3. manager approves over authenticated WhatsApp.
4. Final destination: email -> {"to":"customer@example.com"}.
5. Checkpointed decision audit trail:
   - hr: approve by channel:whatsapp:+254700000011 (...)
   - manager: approve by channel:whatsapp:+254700000012 (...)
   - finance: approve by channel:whatsapp:+254700000013 (...)
```

The trace is for people, not a stable machine-readable output format.

```bash
pnpm exec nx test example-decoupled-delivery
pnpm exec nx typecheck example-decoupled-delivery
```

This is intentionally not a workflow framework. LangGraph still owns routing, parallel work and
interrupts; Skein only adapts a graph-declared, allowlisted destination to the existing durable
channel callback path.

The demo and offline tests use the in-memory runtime. They exercise the same runtime assembly and
handler path as production adapters, but they are restart-volatile: pending interrupts, delivery
rows and retry schedules disappear with the process. Production approval workflows must select
durable Skein storage and a durable LangGraph checkpointer.
