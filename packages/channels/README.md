# `@skein-js/channels`

Put an agent behind **anything that POSTs** — a WhatsApp number, a Slack workspace, a GitHub webhook,
an inbound mailbox — instead of behind a browser tab.

Part of **[skein-js](https://github.com/skein-js/skein-js)**. Entirely optional: a deployment that
configures no channel cannot tell this package exists.

## The problem

Putting an agent behind a phone number means writing, by hand: signature verification, dedup for the
provider's retries, a mapping from `whatsapp:+254…` to a thread, a branch on whether that thread is
waiting on a human, payload mapping in both directions, and a reply path that does not double-send.

Only two of those are about the provider. The rest are identical for every integration anyone will
ever write — and the interesting failures (a double reply, a lost reply, an interrupt that never
resumes) land in front of end users rather than in a test.

## The shape

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
texts is the failure this avoids.

## See also

- [docs/channels.md](https://github.com/skein-js/skein-js/blob/main/docs/channels.md) — the guide
- [docs/webhooks.md](https://github.com/skein-js/skein-js/blob/main/docs/webhooks.md) — the durable
  delivery this rides on
- [docs/human-in-the-loop.md](https://github.com/skein-js/skein-js/blob/main/docs/human-in-the-loop.md)
  — why a reply hours later has to resume rather than restart
