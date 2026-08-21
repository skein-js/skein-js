# Channels — an agent behind WhatsApp, Slack, or any webhook

LangGraph gives you an agent behind an API. A **channel** puts one behind anything that POSTs: a
WhatsApp number, a Slack workspace, a GitHub webhook, an inbound mailbox.

> A channel is a `Channel` whose reply target happens to be the sender. A GitHub webhook and a Stripe
> dispute go through the identical pipeline without that property — which is why the types here talk
> about _events_, and why you will not find `from`, `to`, `body` or `typing` in any of them.

Entirely optional. A deployment that configures no channel does not install the package, serves no
channel routes, and cannot tell the feature exists.

## The problem it removes

Putting an agent behind a phone number means writing, by hand: signature verification, dedup for the
provider's retries, a mapping from `whatsapp:+254…` to a thread, a branch on whether that thread is
already waiting on a human, payload mapping both ways, and a reply path that does not double-send.

Only two of those are about the provider. The rest are identical for every integration anyone will
ever write — and the interesting failures land in front of end users rather than in a test.

## Write one

```bash
pnpm add @skein-js/channels
```

```ts
import { equalsConstantTime } from "@skein-js/agent-protocol";
import type { Channel } from "@skein-js/channels";

export const channel: Channel = {
  name: "twilio",

  // Runs before anything is parsed — the only point at which a signature can still be checked.
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
        replyTo: { to: message["From"] },
        input: { messages: [{ role: "human", content: message["Body"] }] },
        resumeWith: message["Body"],
      },
    };
  },

  // Durable: retried, recorded, replayable, survives the process dying mid-run.
  async deliver(outcome, target) {
    if (outcome.reply !== undefined) await send(target, String(outcome.reply));
  },
};
```

Then bind it to a graph:

```jsonc
{
  "graphs": { "support": "./src/support.ts:graph" },
  "skein": {
    "channels": {
      "twilio": {
        "path": "./src/twilio-channel.ts:channel",
        "assistant": "support", // REQUIRED
        "public_url": "https://api.example.com",
      },
    },
  },
}
```

That serves `POST /channels/twilio`. A runnable version of all of it is
[`examples/whatsapp-agent`](https://github.com/skein-js/skein-js/tree/main/examples/whatsapp-agent).

## What skein does around your two functions

```text
POST /channels/twilio
  → verify()          your signature check → a principal, or 401
  → authorize()       your Auth block, exactly as on every run-creating route
  → parseEvent()      ignore → 204 · respond → that response · event → on
  → dedup             the provider's event id, claimed over the raw bytes
  → thread            a deterministic id, get-or-create
  → start | resume    decided atomically against the thread's real status
  → 2xx               after enqueueing, never after the run finishes
  ├→ onSignal()       progress, best-effort
  └→ deliver()        the answer, durably
```

**`verify` returns a principal, not a boolean.** A provider's signature _is_ an authentication
scheme; it just is not a bearer token. Producing an identity lets an inbound message flow through the
`Auth` block you already configured — `@auth.on.threads` handlers see it, ownership filters apply,
multi-tenancy works. It is required: a provider with no signature scheme must still yield a principal
some other way (a secret path segment, a shared-secret query parameter). Weaker is your call; absent
is not.

**The acknowledgement is early, always.** Slack retries after three seconds and shows the user an
error; Twilio times out comparably. So progress cannot ride the response — that is what `onSignal` is
for.

**`deliver` and `onSignal` have opposite guarantees.** `deliver` is durable, at-least-once, retried
and replayed from the delivery outbox. `onSignal` is best-effort and lost by design — retrying a
"typing" indicator four minutes late is nonsense. They are separate methods so the two cannot be
confused.

## Conversations that wait for a human

This is the case channels exist for, and the one every hand-written integration gets wrong.

`interrupt()` parks a thread until someone answers. The run that parked it settles as `interrupted`,
which is a **terminal** status — so the thread holds no inflight run, no `multitask_strategy` guards
it, and a plain start succeeds and discards the pending question. Silently.

A channel does the right thing by default: a message arriving on a paused thread **resumes** it. The
decision is a [precondition on the create](./runs.md#dont-start-a-run-on-a-thread-thats-waiting-for-a-human),
settled inside the driver, so two replicas cannot both resume.

```ts
// The default. Override per event when a provider's semantics differ.
onExisting: "resume"; // | "enqueue" | "interrupt" | "reject"
```

**Set `resumeWith` when your graph input is an envelope.** `input` is what a _fresh turn_ takes — for
a message-shaped graph, `{ messages: [...] }` — while `interrupt()` returns whatever the node asked
for, usually a scalar. Handing the node the envelope makes it read as nonsense. skein does not coerce
between them; you say which is which.

## Addressing a conversation from outside

Thread ids are derived, and the derivation is exported — which is what makes hashing acceptable rather
than merely private:

```ts
import { threadIdForChannelKey } from "@skein-js/channels";

// End it. The next inbound message starts fresh under the same id.
await client.threads.delete(threadIdForChannelKey("twilio", "whatsapp:+254712345678"));
```

The phone number never reaches a primary key, an index or a backup. The raw key **is** stamped into
thread metadata, so a search answers the same question from the other side — which is the shape a
GDPR erasure request actually arrives in:

```ts
await client.threads.search({ metadata: { skein_thread_key: "whatsapp:+254712345678" } });
```

## Configuration

| Key                  | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `path`               | `path:export`, or a package name                                      |
| `assistant`          | **Required.** Which graph these events run                            |
| `allowed_assistants` | Graphs the channel may route to itself. Omitted means it cannot route |
| `public_url`         | Your externally reachable origin, when signatures cover the URL       |

**`assistant` is required and not defaultable.** The binding is deployment knowledge: a community
Twilio adapter has no business knowing you named your graph `support`.

**`allowed_assistants` is opt-in and bounded** for a sharper reason. A channel is an npm package you
installed; without a bound, an assistant id derived from untrusted input could reach any graph you
serve.

**`public_url` is configuration, not header sniffing.** Twilio signs the full request URL, so
verification depends on knowing it — and `Host` and `X-Forwarded-Proto` are both attacker-controlled.
Behind a proxy, set it.

Everything is validated **at boot**. An `assistant` naming a graph that does not exist fails startup,
because discovering that when the first customer texts is the failure this avoids.

## What is not here yet

- **First-party channels.** There are none: you write the file. That is deliberate for now — shipping
  one makes skein responsible for the correctness of someone else's signature scheme, so a flaw
  becomes a CVE in skein rather than in your code.
- **A channel conformance suite**, so a community channel can prove it rejects forged signatures and
  stale timestamps without hand review.
- **Chunked streaming of the answer** — send it in pieces, crash halfway, and the outbox replays a
  message the user already partly received.
- **Attachments.** Channels carry the provider's media URL in metadata; the graph fetches it.
- **Polled sources** (IMAP, queue consumers). The pipeline is entered by an inbound HTTP request, and
  there is nothing to enter it with when you poll — that is closer to [crons](./crons.md).

## See also

- [webhooks.md](./webhooks.md) — the durable delivery a channel's reply rides on
- [human-in-the-loop.md](./human-in-the-loop.md) — `interrupt()`, and why a reply hours later must
  resume rather than restart
- [runs.md](./runs.md#dont-start-a-run-on-a-thread-thats-waiting-for-a-human) — `if_thread_status`,
  the precondition underneath `onExisting`
