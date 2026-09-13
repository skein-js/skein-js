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

The proof adds no Skein API. `composeSourceChannel` and `declareDestinationDelivery` are deliberately
example-local. They compose the existing public contracts:

- channel verification, authorization, event deduplication and thread start/resume;
- `replyWith(unknown)` for one graph-declared structured result;
- the existing channel callback and transactional delivery outbox;
- destination-specific Zod validation and `runId` idempotency.

The provider clients are recording fakes, so no credentials or network are required.

```bash
pnpm exec nx test example-decoupled-delivery
pnpm exec nx typecheck example-decoupled-delivery
```

This is intentionally not a general source/destination framework. It is the smallest experiment that
can falsify the need for one. If application-local composition remains correct and small, it should
stay a recipe rather than become permanent package API.

The offline tests use the in-memory runtime. Production approval workflows must select durable Skein
storage and a durable LangGraph checkpointer; otherwise pending interrupts disappear on restart.
