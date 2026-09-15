# Channels — connect LangGraph workflows to external systems

A **channel** is Skein's durable boundary between an authenticated webhook and a LangGraph workflow.
It turns a provider event—such as a WhatsApp message, Slack event, GitHub webhook, or inbound-email
notification—into ordinary graph input, then delivers the workflow's outcome.

The source and destination may be **coupled**: a WhatsApp message enters and its reply returns to the
same conversation. They may also be **decoupled**: an email starts a refund workflow, the graph asks
Finance for approval over WhatsApp, and the final decision returns by email. LangGraph still owns
state, branching, tools, and `interrupt()`; Skein owns the provider-facing lifecycle around the run.

You write thin provider adapters. Skein handles retry deduplication, external-identity-to-thread
mapping, start-versus-resume decisions, and durable delivery consistently across channels.

> A chat channel is a `Channel` whose reply target happens to be the sender. A GitHub webhook and a
> Stripe dispute go through the identical pipeline without that property — which is why these types
> talk about _events_, and why you will not find `from`, `to`, `body` or `typing` in any of them.

Entirely optional. A deployment that configures no channel does not install the package, serves no
channel routes, and cannot tell the feature exists.

## What Skein enables

Connecting a workflow to a phone number by hand means writing signature verification, deduplication
for retried deliveries, a mapping from `whatsapp:+254…` to a thread, a branch on whether that thread
is already waiting on a human, payload mapping in both directions, and a reply path that does not
double-send.

Only two of those are about the provider. The rest are identical for every integration anyone will
ever write — and their failures are silent ones: a double reply, a lost reply, a question nobody was
ever asked.

## Quick start

```bash
pnpm add @skein-js/channels
```

Write the provider adapter and bind its source route to a graph:

**`src/twilio-channel.ts`**

```ts
import { equalsConstantTime } from "@skein-js/agent-protocol";
import type { Channel } from "@skein-js/channels";

export const channel: Channel = {
  name: "twilio",

  verify(request) {
    const expected = sign(process.env.TWILIO_AUTH_TOKEN!, request.url.href, request.form());
    if (!equalsConstantTime(expected, request.headers["x-twilio-signature"] ?? "")) return false;
    return { identity: `channel:twilio:${request.form()["From"]}` };
  },

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

  async deliver(outcome, target) {
    const { to } = target as { to: string };
    if (outcome.reply !== undefined) await sendWhatsApp(to, String(outcome.reply));
  },
};
```

**`langgraph.json`**

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

That serves `POST /channels/twilio`. Point your provider's webhook at it.

A complete, runnable version — offline, no Twilio account —
is [`examples/whatsapp-agent`](https://github.com/skein-js/skein-js/tree/main/examples/whatsapp-agent).

### Route between different providers

The provider that receives an event does not have to send the result. The
[`decoupled-delivery`](https://github.com/skein-js/skein-js/tree/main/examples/decoupled-delivery)
example routes an email through one LangGraph workflow to WhatsApp, collects parallel authenticated
approvals with LangGraph `interrupt()`, then sends the result by email. Its runnable refund demo uses
Skein's normal channel, auth, deduplication, thread/run and delivery paths with offline provider
fakes.

Skein exposes this as a small composition layer rather than separate provider hierarchies:

```ts
import {
  composeRoutedChannel,
  declareChannelDestinationDelivery,
  type ChannelDestinationDelivery,
} from "@skein-js/channels";

const destinations = new Map([
  [
    "whatsapp",
    async (delivery: ChannelDestinationDelivery) => {
      const message = whatsappSchema.parse(delivery);
      await sendWhatsApp(message, { idempotencyKey: delivery.runId });
    },
  ],
]);

export const channel = composeRoutedChannel(emailSource, destinations);
```

### How LangGraph selects the destination

LangGraph passes a custom-stream writer to every node in `LangGraphRunnableConfig`. The Skein helper
uses that existing writer to declare the result of the workflow; the node does not call WhatsApp or
email itself:

```ts
import {
  Annotation,
  END,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { declareChannelDestinationDelivery } from "@skein-js/channels";

const RelayState = Annotation.Root({
  source: Annotation<"email" | "whatsapp">,
  sender: Annotation<string>,
  whatsappNumber: Annotation<string | undefined>,
  subject: Annotation<string>,
});

function routeMessage(
  state: typeof RelayState.State,
  config: LangGraphRunnableConfig,
): Partial<typeof RelayState.State> {
  if (state.source === "email" && state.whatsappNumber) {
    declareChannelDestinationDelivery(config.writer, {
      destination: "whatsapp",
      target: { to: state.whatsappNumber },
      payload: { body: `Important email from ${state.sender}: ${state.subject}` },
    });
  } else {
    declareChannelDestinationDelivery(config.writer, {
      destination: "email",
      target: { to: state.sender },
      payload: { subject: "Assistant update", body: state.subject },
    });
  }

  // The destination declaration is an output instruction, not graph state.
  return {};
}

export const graph = new StateGraph(RelayState)
  .addNode("route-message", routeMessage)
  .addEdge(START, "route-message")
  .addEdge("route-message", END)
  .compile();
```

The interaction is deliberately small:

1. The source channel converts email or WhatsApp into ordinary LangGraph input.
2. LangGraph performs extraction, classification, branching, `Send`, and `interrupt()` as usual.
3. The final node writes one explicit destination declaration through `config.writer`.
4. When the run settles, Skein resolves that declaration and invokes the allowlisted destination
   through its existing durable outbox.

For approvals, keep using LangGraph's `interrupt()`; no Skein approval abstraction is needed. A node
can declare the WhatsApp approval request before it interrupts, and declare the final email result
after `interrupt()` returns on resume. The complete parallel HR/Manager/Finance implementation is
[`examples/decoupled-delivery/src/relay-graph.ts`](https://github.com/skein-js/skein-js/blob/main/examples/decoupled-delivery/src/relay-graph.ts).

The map allowlists destination adapters and remains application-owned, along with provider credentials
and routing policy. It does not authorize recipients or operations: derive those from trusted workflow
data and enforce tenant/recipient policy before sending, rather than treating an LLM-selected or
user-supplied target as permission. Only `declareChannelDestinationDelivery` triggers routing;
ordinary `replyWith` values and inferred interrupt/AI-message replies are not dispatched by a routed
channel. Construct declarations through the helper, never its internal persisted marker.

`target` and `payload` must be plain JSON values so the outbox can persist them. They remain `unknown`
to the destination, which must validate its provider boundary—Zod is used above for exactly that.
Unknown or malformed declarations and thrown callbacks fail the outbox attempt visibly and are
retried. Delivery is at-least-once, so pass a stable key such as `runId` to providers that support
idempotency. One run still owns one outbox retry unit; aggregate fan-out does not create independent
delivery rows.

This helper is for channel-ingested runs. A poller using the Agent Protocol run API still uses its own
HTTP callback receiver. Existing `Channel` implementations with `deliver` continue to work unchanged.
Configured route keys and explicit channel-name aliases must be unique; collisions now fail at boot
instead of sharing thread identity or misrouting a callback.

For copy-first implementations, compare the practical
[WhatsApp → order lookup → WhatsApp recipe](./recipes/coupled-channel.md) with the
[customer refund email → Finance WhatsApp approval → customer email recipe](./recipes/decoupled-channel-delivery.md).

## The pipeline

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

Two properties of that shape are worth internalising before you write anything.

**The acknowledgement is early, always.** Slack retries after three seconds and shows the user an
error; Twilio times out comparably. Your `parseEvent` returns, the run is enqueued, and skein answers
2xx — it never waits for the graph. That is why progress needs `onSignal` and why the answer needs
`deliver`: by the time either has something to say, the HTTP request is long gone.

**`verify` runs before anything is parsed.** A signature covers the bytes as sent, so any middleware
that parses first destroys the thing you need to check. skein hands you the body as text for exactly
this reason.

## Implementing `verify`

```ts
verify(request: InboundRequest): Promise<ChannelPrincipal | false> | ChannelPrincipal | false;
```

Return a **principal**, or `false` for a 401.

**Why a principal and not a boolean.** A provider's signature _is_ an authentication scheme; it just
is not a bearer token. Producing an identity lets the message flow through the `Auth` block you
already configured — `@auth.on.threads` handlers see it, ownership filters apply, multi-tenancy works
— instead of needing a route that bypasses authorization to create runs.

```ts
return {
  identity: `channel:twilio:${from}`, // derived from provider-verified data only
  permissions: ["threads:write"], // optional; becomes AuthContext.scopes
  metadata: { tenant }, // optional; merged into the user object
};
```

Build `identity` **only from data the signature covered**. A value the caller could have set freely
is not an identity, and everything downstream — ownership filters, per-tenant scoping — inherits
whatever trust you put in it here.

**`verify` is required.** A provider with no signature scheme must still yield a principal some other
way: a secret path segment, a shared-secret query parameter, basic auth. Weaker is a decision your
deployment gets to make; absent is not, because the route creates runs.

### `InboundRequest`

| Member    | Notes                                                                       |
| --------- | --------------------------------------------------------------------------- |
| `method`  | The HTTP method                                                             |
| `url`     | A `URL`. The **public** one — see below                                     |
| `headers` | Lower-cased keys, whatever the transport                                    |
| `text()`  | The body exactly as sent                                                    |
| `form()`  | Decoded `application/x-www-form-urlencoded`                                 |
| `json()`  | Parsed JSON. Throws on a malformed body, so guard it if the provider varies |

The body views are lazy and cached, so reading `form()` in both `verify` and `parseEvent` parses once.

**`url` is the public URL, and that matters more than it looks.** Twilio signs the full request URL,
so verification depends on knowing what the provider saw — and behind a proxy the server cannot know
it. The only inputs are `Host` and `X-Forwarded-Proto`, both attacker-controlled. So skein takes the
origin from `public_url` in your config and keeps the router's own path. Set it in production, or
signature verification will fail in a way that looks like every request being forged.

### Comparing signatures

```ts
import { equalsConstantTime } from "@skein-js/agent-protocol";
```

Not `===`. It returns at the first differing byte, so an attacker who can send many requests and
measure your response recovers a valid signature a byte at a time. The length check inside is not
decoration either: Node's `timingSafeEqual` **throws** on unequal lengths, so the obvious hand-rolled
version turns a forged short signature into a 500 instead of a 401.

## Implementing `parseEvent`

```ts
parseEvent(request: InboundRequest): Promise<ChannelOutcome> | ChannelOutcome;
```

Three outcomes, and you will need all three.

### `{ kind: "event", event }` — do something

```ts
return {
  kind: "event",
  event: {
    threadKey: message.From, // which conversation
    input: { messages: [...] }, // what a fresh turn runs with
    resumeWith: message.Body, // what an interrupt gets, if different
    idempotencyKey: message.MessageSid, // the provider's own event id
    replyTo: { to: message.From }, // opaque; handed back to deliver/onSignal
    onExisting: "resume", // default
    assistantId: "triage", // only if allowed_assistants lists it
    metadata: { locale: message.Locale }, // stamped on the thread
  },
};
```

| Field            | Required | Notes                                                                       |
| ---------------- | -------- | --------------------------------------------------------------------------- |
| `threadKey`      | ✅       | Stable external identity. Hashed into a thread id                           |
| `input`          | ✅       | Graph input for a fresh turn                                                |
| `threadId`       |          | Choose the thread id yourself; skips the derivation entirely                |
| `resumeWith`     |          | What `interrupt()` receives. Defaults to `input` — usually wrong, see below |
| `idempotencyKey` |          | No key, no dedup. See [Retries](#retries-and-idempotency)                   |
| `replyTo`        |          | Opaque to skein. Omit it and no reply is delivered                          |
| `onExisting`     |          | `resume` (default) · `enqueue` · `interrupt` · `reject`                     |
| `assistantId`    |          | Rejected unless the deployment listed it in `allowed_assistants`            |
| `metadata`       |          | Merged onto the thread's metadata                                           |

### `{ kind: "ignore" }` — acknowledge, do nothing

Answers 204 and starts no run. **Use it liberally.** Slack redelivers your own bot's messages, and a
channel that cannot cheaply say "not interesting" ends up answering itself in a loop. Delivery
receipts, read receipts, reactions, media-only messages and bot echoes all belong here.

```ts
if (payload.bot_id) return { kind: "ignore" };
```

### `{ kind: "respond", status, body }` — answer this request directly

No run, your response. Required by real providers, not a convenience:

```ts
// Slack's very first request is a challenge that must be echoed back.
if (payload.type === "url_verification") {
  return { kind: "respond", status: 200, body: { challenge: payload.challenge } };
}
// A slash command wants an immediate ephemeral acknowledgement.
return { kind: "respond", status: 200, body: { response_type: "ephemeral", text: "On it…" } };
```

## Retries and idempotency

Providers retry. Twilio retries on any non-2xx and on a timeout; Slack retries three times. Without
dedup the customer gets two answers.

Set `idempotencyKey` to **the provider's own event id** — `MessageSid`, Slack's `event_id`, GitHub's
`X-GitHub-Delivery`. A retry carries the same one, and skein replays the first response instead of
starting a second run.

Three things worth knowing about how it behaves:

- **The fingerprint is the raw inbound bytes**, not anything derived. A retry that correctly re-reads
  the thread and resumes instead of starting sends the same key with a _different_ run body — and
  fingerprinting that derived body would refuse the retry precisely because it did the right thing.
- **Same key, different bytes → 422.** Two genuinely different events sharing an id is a provider bug
  or a forgery; replaying would tell the sender its message was handled while silently dropping it.
- **No key means no protection**, deliberately. Without a provider-assigned id nothing identifies two
  deliveries as the same event, and deriving one from the body would collide when a customer
  legitimately sends "yes" twice.

## Conversations that wait for a human

This is the case channels exist for, and the one every hand-written integration gets wrong.

`interrupt()` parks a thread until someone answers. The run that parked it settles as `interrupted`,
which is a **terminal** status — so the thread holds no inflight run, no `multitask_strategy` guards
it, and a plain start succeeds and discards the pending question. Silently.

A channel does the right thing by default: a message arriving on a paused thread **resumes** it. The
decision is a [precondition on the create](./runs.md#dont-start-a-run-on-a-thread-thats-waiting-for-a-human),
settled inside the driver, so two replicas cannot both resume.

### Set `resumeWith` — you almost certainly need it

`input` is what a _fresh turn_ takes. For a message-shaped graph that is an envelope:
`{ messages: [{ role: "human", content: "yes" }] }`. But `interrupt()` returns whatever the node asked
for — usually a scalar the graph author chose:

```ts
const answer = interrupt("Approve this refund?");
if (/^y/i.test(String(answer))) { … }
```

Hand that node the envelope and `String(...)` gives `"[object Object]"`, which does not match — so the
graph reads a "yes" as a "no", and nothing errors. skein will not guess between the two shapes, so
say which is which:

```ts
input: { messages: [{ role: "human", content: body }] },
resumeWith: body,
```

### Choosing `onExisting`

| Value       | What happens                                             | When                                                |
| ----------- | -------------------------------------------------------- | --------------------------------------------------- |
| `resume`    | Answers a pending interrupt; otherwise queues a new turn | **Default.** Chat, email, anything conversational   |
| `enqueue`   | Always a new turn, behind whatever is running            | A feed of events that each deserve their own run    |
| `interrupt` | Cancels the run in flight and starts this one            | "Actually, stop — do this instead"                  |
| `reject`    | 409 unless the thread is genuinely free                  | An event that is only valid on an idle conversation |

Under `resume`, a message arriving while the agent is still thinking **queues** rather than being
refused. The server's default `multitask_strategy` is `reject`, which for Twilio would render as a
failed message for having typed twice; a conversation wants ordering.

When the answer is not an answer — _"actually, never mind, what's my balance?"_ — skein still resumes
and the **graph** decides whether to re-ask, pivot or abandon, because the graph holds the question.
If you would rather have a blunter rule, use `enqueue`.

## Delivering the reply

```ts
deliver?(outcome: RunOutcomeForChannel, target: ReplyTarget): Promise<void>;
```

Optional — a GitHub channel that comments from inside the graph owes no callback. Omit it and no
reply is delivered.

**It runs inside skein's delivery outbox**, which is where all its guarantees come from. The delivery
row is written in the run's finalize transaction, so a crash between "the run succeeded" and "the
customer was told" cannot lose the answer. A **throw is a failed attempt**: retried with exponential
backoff, recorded, and replayable from the [delivery routes](./webhooks.md#see-what-a-callback-did-and-replay-it).
So let it throw — swallowing an error here is how an answer gets silently dropped.

```ts
async deliver(outcome, target) {
  if (outcome.reply === undefined) return; // nothing to say
  const { to } = target as { to: string };
  await sendWhatsApp(to, String(outcome.reply)); // throws → retried
}
```

### What `outcome.reply` is

Resolved by skein, in order:

1. **What the graph declared**, via `replyWith` on the custom stream.
2. **The last AI message** in `values.messages` — LangGraph's `MessagesAnnotation` convention, so an
   ordinary chat agent works with no graph changes at all.
3. **The interrupt's question**, when the run is `interrupted`.
4. Otherwise `undefined`.

Resolved centrally rather than per channel on purpose: a channel that guessed at `state.answer` versus
`state.draft` would stop being reusable across graphs, which is the premise the whole plugin surface
rests on. For a graph whose state is not message-shaped, declare it:

```ts
import { replyWith } from "@skein-js/agent-protocol";

// inside a node, with LangGraph's StreamWriter in scope
writer(replyWith("Your order ships Tuesday."));
```

**A failed run says nothing.** `error`, `timeout` and `cancelled` resolve to no reply, because whether
an end user hears "something went wrong" is a product decision and leaking internals to a phone number
is the wrong default. Send your own message from `deliver` if you want one.

## Progress signals

```ts
signals: { kinds: ["progress"], keepaliveMs: 10_000 },
async onSignal(signal, target) { … }
```

Because the acknowledgement is early, progress cannot ride the response. `onSignal` is how a typing
indicator gets sent while the graph works.

**Its guarantees are deliberately the opposite of `deliver`'s**: best-effort, at most once, never
retried, never blocking the run, dropped on any error. Retrying a "typing" indicator four minutes
late is nonsense, and a slow provider must never be why the acknowledgement times out. That is why
they are two methods rather than one with a flag.

- `progress` — fires immediately, then once per frame the run produces.
- `keepalive` — fires on `keepaliveMs`, for providers whose indicator expires (most do, in seconds).

Declaring a subscription is what lets skein pick the cheapest stream that satisfies it. A channel that
asks for nothing costs exactly what an API run costs; one that asks for `progress` gets node-level
updates and **never** pays for token streaming it would only throw away.

## Addressing a conversation from outside

Thread ids are derived, and the derivation is exported — which is what makes hashing acceptable rather
than merely private:

```ts
import { threadIdForChannelKey } from "@skein-js/channels";

const threadId = threadIdForChannelKey("twilio", "whatsapp:+254712345678");
await client.threads.get(threadId);
```

The phone number never reaches a primary key, an index or a backup. The raw key **is** stamped into
thread metadata, so a search answers the same question from the other side — which is the shape a
GDPR erasure request actually arrives in:

```ts
await client.threads.search({ metadata: { skein_thread_key: "whatsapp:+254712345678" } });
```

### Ending a conversation and starting a new one

Two different things people mean by this, and they need different answers.

**"Forget everything and start over."** Delete the thread. The next message from that number derives
the same id, finds nothing there, and begins fresh:

```ts
await client.threads.delete(threadIdForChannelKey("twilio", "whatsapp:+254712345678"));
```

**"Start a new conversation, but keep the old one."** Then the thread key is not just the phone number
— it is the phone number _and_ which conversation. `threadKey` is whatever your channel says, so put
the session in it:

```ts
// A ticket, a billing period, a counter you keep — whatever "a conversation" means to you.
threadKey: `${message.From}:${await currentSessionFor(message.From)}`;
```

Old conversations stay readable, each under its own thread, and a search on `skein_thread_key` still
finds them because the raw key is what gets stamped.

A channel that already has its own conversation ids returns `threadId` on the event instead, and skein
does no transformation at all.

## Configuration

| Key                  | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `path`               | `path:export`, or a package name                                      |
| `assistant`          | **Required.** Which graph these events run                            |
| `allowed_assistants` | Graphs the channel may route to itself. Omitted means it cannot route |
| `public_url`         | Your externally reachable origin, when signatures cover the URL       |

**`assistant` is required and not defaultable.** The binding is deployment knowledge: a community
Twilio adapter has no business knowing you named your graph `support`. It takes a graph name or an
assistant UUID, resolving exactly as it does for [crons](./crons.md).

**`allowed_assistants` is opt-in and bounded** for a sharper reason. A channel is an npm package you
installed; without a bound, an `assistantId` derived from untrusted input could reach any graph you
serve. Omit the key and the channel cannot route at all.

Everything is validated **at boot**: a missing `assistant`, one naming a graph that does not exist, an
`allowed_assistants` entry outside your graphs, a `path` whose export is not a channel. Discovering
any of those when the first customer texts is the failure this avoids.

## Testing a channel

The quickest end-to-end check is the console's **Channels** tab. It shows the effective routes and
assistant allowlists that passed boot validation. Copy an inbound path, send a fixture or provider
event, then open the resulting thread and run: the run's **Deliveries** panel shows attempts, retry
timing, errors, and a confirmed replay action. Sensitive webhook paths and opaque reply targets are
redacted in the UI.

The same inventory is available as authenticated `GET /channels`; it is mounted only when at least
one channel is configured and exposes no module paths, public URLs, credentials or raw config.

A channel is a plain object, so `verify` and `parseEvent` are unit-testable with no server:

```ts
const request = buildInboundRequest({
  method: "POST",
  url: "https://api.example.com/channels/twilio",
  headers: { "x-twilio-signature": signature },
  text: "From=whatsapp%3A%2B254&Body=hi&MessageSid=SM-1",
});

expect(channel.verify(request)).toEqual({ identity: "channel:twilio:whatsapp:+254" });
```

For the whole path, boot a runtime from a `langgraph.json` and dispatch into the handler — no HTTP
server, no ports:

```ts
const resolved = await resolveProtocolRuntime({ config: "./langgraph.json" });
const response = await resolved.runtime.handlers.handleInboundEvent(request);
expect(response.status).toBe(202);
```

Worth covering, because each has shipped broken in real integrations: a forged signature is refused;
a retried delivery produces exactly one run; an interrupt is resumed rather than trampled; a delivery
receipt starts no run. [`examples/whatsapp-agent`](https://github.com/skein-js/skein-js/tree/main/examples/whatsapp-agent)
does all four offline.

## Things that will bite you

- **Mount order, if you also hand-roll routes.** `skeinRouter` installs a JSON body parser for
  everything routed into it, so a raw-body route registered _after_ it sees an empty body and fails to
  verify — a 401 that looks like a forged request. Channel routes are handled for you; your own are
  not.
- **`public_url` behind a proxy.** Without it, URL-signing providers fail every request.
- **Forgetting `resumeWith`.** The graph reads a "yes" as a "no" and nothing errors.
- **Swallowing errors in `deliver`.** A throw is what buys you the retry.
- **Returning `false` from `verify` for a _parse_ failure.** That reports a forged request when the
  truth is a malformed one; prefer `{ kind: "respond", status: 400 }` from `parseEvent`.
- **Sending the reply from `parseEvent`.** It will be sent again on every retry. The outbox exists so
  that it is not your problem.

## What is not here yet

- **First-party channels.** There are none: you write the file. Shipping one would make skein
  responsible for the correctness of someone else's signature scheme, so a flaw becomes a CVE here
  rather than in your code — a real cost that has to be earned.
- **A channel conformance suite**, so a community channel can prove it rejects forged signatures,
  stale timestamps and duplicate ids without hand review.
- **Chunked streaming of the answer** — send it in pieces, crash halfway, and the outbox replays a
  message the user already partly received. Needs provider-side editing (Slack can, WhatsApp cannot).
- **Attachments.** Carry the provider's media URL in `metadata` and fetch it from the graph.
- **Polled sources** (IMAP, queue consumers). The pipeline is entered by an inbound HTTP request, and
  there is nothing to enter it with when you poll — that is closer to [crons](./crons.md).

## See also

- [webhooks.md](./webhooks.md) — the durable delivery a channel's reply rides on
- [human-in-the-loop.md](./human-in-the-loop.md) — `interrupt()`, and why a reply hours later must
  resume rather than restart
- [runs.md](./runs.md#dont-start-a-run-on-a-thread-thats-waiting-for-a-human) — `if_thread_status`,
  the precondition underneath `onExisting`
- [agent-protocol.md](./agent-protocol.md#authentication--authorization) — the `Auth` block a
  verified principal flows through
