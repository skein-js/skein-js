# `@skein-js/channels`

Connect LangGraph workflows to external systems through durable sources and destinations. The
workflow defines what happens—state, decisions, tools, branching, and interrupts. A channel defines
how an authenticated provider event enters that workflow and how its outcome leaves. Together:

```text
channel source → LangGraph workflow → channel destination
```

skein-js keeps conversations connected, prevents duplicate work, resumes interrupted workflows, and
delivers outcomes reliably; each integration only translates its provider's events and deliveries.

LangGraph deliberately doesn't own provider integrations. This package supplies that missing
lifecycle around the graph. For example:

- WhatsApp question → order lookup and escalation workflow → WhatsApp answer;
- customer email → refund validation and approvals → WhatsApp approvers → customer email;
- GitHub deployment webhook → failure triage workflow → Slack on-call alert.

Part of **[skein-js](https://github.com/skein-js/skein-js)**. Entirely optional: a deployment that
configures no channel cannot tell this package exists.

## Why workflows need channels

LangGraph can express and persist the business process, but a provider connection still needs
signature verification, dedup for retries, a mapping from `whatsapp:+254…` to a thread, a branch on
whether that thread is waiting on a human, payload mapping in both directions, and a reply path that
does not double-send.

Only two of those are about the provider. The rest are identical for every integration anyone will
ever write — and the interesting failures (a double reply, a lost reply, an interrupt that never
resumes) land in front of end users rather than in a test.

## How a channel wraps a workflow

A channel implements two required methods. Everything else is skein's, once, for every channel.

```ts
import type { Channel } from "@skein-js/channels";

export const channel: Channel = {
  name: "twilio",

  // Runs before any parsing, because that is the only point at which a signature can still be
  // checked. Returns a principal, not a boolean — see below.
  verify(request) {
    const expected = sign(authToken, request.url.href, request.form());
    if (!equalsConstantTime(expected, request.headers["x-twilio-signature"] ?? "")) return false;
    return { identity: `channel:twilio:${request.form()["From"]}` };
  },

  // The integration: provider payload in, event out.
  parseEvent(request) {
    const message = request.form();
    if (!message["Body"]) return { kind: "ignore" };
    return {
      kind: "event",
      event: {
        threadKey: message["From"]!,
        idempotencyKey: message["MessageSid"]!,
        replyTo: message["From"]!,
        input: { messages: [{ role: "human", content: message["Body"] }] },
      },
    };
  },

  // Durable: retried, recorded, replayable, survives the process dying mid-run.
  async deliver(outcome, target) {
    if (outcome.reply) await sendWhatsApp(target as string, String(outcome.reply));
  },
};
```

Then bind it to a graph in `langgraph.json` — the binding is deployment knowledge, so a community
adapter never has to know what you named your graph:

```jsonc
{
  "graphs": { "support": "./src/support.ts:graph" },
  "skein": {
    "channels": {
      "twilio": {
        "path": "./src/twilio-channel.ts:channel",
        "assistant": "support",
        "public_url": "https://api.example.com",
      },
    },
  },
}
```

## Route a workflow from one provider to another

Use `composeRoutedChannel` when the inbound provider should not own outbound delivery. The source
still verifies and parses events; an application-owned map supplies allowlisted destinations:

```ts
import { composeRoutedChannel, type ChannelDestinationDelivery } from "@skein-js/channels";

const destinations = new Map([
  [
    "whatsapp",
    async ({ target, payload, runId }: ChannelDestinationDelivery) => {
      const message = whatsappPayloadSchema.parse({ target, payload });
      await sendWhatsApp(message, { idempotencyKey: runId });
    },
  ],
]);

export const channel = composeRoutedChannel(emailSource, destinations);
```

The workflow selects a destination after processing:

```ts
import { declareChannelDestinationDelivery } from "@skein-js/channels";

declareChannelDestinationDelivery(config.writer, {
  destination: "whatsapp",
  target: { to: "+254700000001" },
  payload: { body: "Order GT-1042 needs approval." },
});
```

Only this explicit declaration is dispatched. Ordinary `replyWith` values and inferred interrupt or
AI-message replies are intentionally ignored by a routed channel. Targets and payloads must be plain
JSON values, and every destination must validate its provider-specific boundary. The map allowlists
adapters, not recipients: authorize targets from trusted workflow data instead of treating an
LLM-selected or user-supplied value as permission to send. An invalid or unknown declaration, or a
callback that throws, fails the existing outbox attempt visibly.

Delivery remains at-least-once. Use a stable provider idempotency key such as `runId`; a run still has
one outbox retry unit, even when one callback performs aggregate fan-out. Existing channels that
implement `Channel.deliver` directly continue to work unchanged.

## Decisions worth knowing

**`verify` returns a principal, not a boolean.** A provider's signature _is_ an authentication
scheme; it just is not a bearer token. Producing an identity lets an inbound event flow through the
deployment's ordinary `Auth` block — `@auth.on.threads` handlers see it, ownership filters apply,
multi-tenancy works. The alternative, a route exempt from authorization, would be an unauthenticated
run-creation endpoint.

**`verify` is required.** A provider with no signature scheme must still produce a principal some
other way — a secret path segment, a shared-secret query parameter, basic auth. Weaker is a decision
a deployment can make; absent is not.

**Events, not chat messages.** There is no `from`, `to`, `body` or `typing` in these types. Chat is
the case where the reply target happens to be the sender; a GitHub webhook and a Stripe dispute are
the same pipeline without that property. Those names appearing here is what would stop them fitting.

**`deliver` and `onSignal` have opposite guarantees**, which is why they are separate methods rather
than one with a flag. `deliver` is durable, at-least-once and replayed from the outbox. `onSignal` is
best-effort and lost by design — retrying a "typing" indicator four minutes late is nonsense, and
making the answer best-effort would defeat the point.

**Thread ids are derived, and the derivation is exported.** `threadIdForChannelKey(channel, key)`
hashes the key, so a phone number never lands in a primary key, an index or a backup. It is exported
rather than hidden because an id you cannot recompute is not a primitive — with it, ending a
conversation is `threads.delete(threadIdForChannelKey("twilio", "whatsapp:+254…"))` and needs no new
API. The raw key is stamped into thread metadata, so `POST /threads/search` answers the same question
from the other direction, which is the shape a GDPR erasure request arrives in.

**Configuration is validated at boot**, not at the first event. An `assistant` naming a graph that
does not exist fails startup with a precise error — discovering that typo when the first customer
texts is the failure this avoids. Configured route keys and explicit `Channel.name` aliases must also
be unambiguous; collisions fail at boot before they can merge thread identities or misroute a reply.

## See also

- [docs/channels.md](../../docs/channels.md) — the workflows and channels guide
- [docs/webhooks.md](../../docs/webhooks.md) — the durable
  delivery this rides on
- [docs/human-in-the-loop.md](../../docs/human-in-the-loop.md)
  — why a reply hours later has to resume rather than restart
