# whatsapp-agent — an agent behind a phone number

A customer texts a WhatsApp number. The agent answers. When the request is irreversible — a refund, a
cancellation — it stops and asks, and the customer's reply **hours later resumes that same question**
rather than starting a new conversation. A typing indicator runs while it thinks, the agent remembers
them next time, and the answer arrives even if the process dies mid-run.

Part of **[skein-js](../../README.md)**. No Twilio account, no API key, no network needed.

```bash
pnpm --filter @skein-js/example-whatsapp-agent dev   # http://127.0.0.1:2024
```

Then deliver a correctly signed, Twilio-shaped message:

```bash
URL=http://127.0.0.1:2024/channels/twilio
SIG=$(node -e '
  const {createHmac}=require("crypto");
  const url=process.argv[1];
  const p={From:"whatsapp:+254712345678",Body:"I want a refund",MessageSid:"SM-1"};
  const s=Object.entries(p).sort(([a],[b])=>a<b?-1:1).reduce((a,[k,v])=>a+k+v,url);
  console.log(createHmac("sha1","test_auth_token").update(s,"utf8").digest("base64"));
' "$URL")

curl -sX POST "$URL" -H "content-type: application/x-www-form-urlencoded" \
  -H "x-twilio-signature: $SIG" \
  --data-urlencode "From=whatsapp:+254712345678" \
  --data-urlencode "Body=I want a refund" \
  --data-urlencode "MessageSid=SM-1"
```

```
⋯ typing (in reply to SM-1)
→ whatsapp whatsapp:+254712345678: Just to confirm — you want to refund? Reply YES to go ahead.
```

Send `Body=yes` with a new `MessageSid` and the run **resumes** where it paused:

```
→ whatsapp whatsapp:+254712345678: Done — your refund is being processed.
```

## The whole integration is one file

[`src/twilio-channel.ts`](./src/twilio-channel.ts) — **65 lines**. It does the two things only Twilio
knows: verify a signature, and read a payload.

Everything else is skein's, once, for every channel:

| Not in this file       | Who does it                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| Retry dedup            | The provider's `MessageSid`, claimed over the raw bytes before anything branches |
| Number → conversation  | A deterministic thread id, hashed so the number stays out of your database       |
| Start or resume        | A precondition settled inside the driver's atomic create                         |
| Typing indicator       | A declared signal subscription, fanned out from the run's own stream             |
| Getting the reply back | The delivery outbox — retried, recorded, replayable, crash-safe                  |

And it is bound to a graph in [`langgraph.json`](./langgraph.json), because _which_ graph answers is
a deployment's decision, not a channel's:

```jsonc
"skein": {
  "channels": {
    "twilio": { "path": "./src/twilio-channel.ts:channel", "assistant": "support" },
  },
}
```

## The measurement

This example began as the **kill test** for the design: the same integration written by hand against
the raw API, so the delta would be measured rather than guessed. That version was **334 code lines**
across four files.

|                              |  Lines |
| ---------------------------- | -----: |
| By hand, against the raw API |    334 |
| Through `@skein-js/channels` | **65** |

The target was "under 60", so this is a near miss rather than a win by a mile — and the honest reading
is that the line count was never the strongest argument anyway. Three of those 334 lines' worth of
behaviour could not be made _correct_ from user code at all, and each failed silently:

- a start on a thread waiting for a human **discarded the question**, with nothing on the server to
  stop it ([#35](https://github.com/skein-js/skein-js/issues/35))
- the question itself was **unreachable from the callback**, so a receiver could not ask it
  ([#36](https://github.com/skein-js/skein-js/issues/36))
- a retry that correctly re-read the thread and resumed instead of starting was **refused for being
  right**, because `Idempotency-Key` fingerprints a body a webhook derives from mutable state

## What to look at

- [`src/twilio-channel.ts`](./src/twilio-channel.ts) — the integration. Note `verify` returns a
  _principal_, not a boolean, so an inbound message flows through whatever `Auth` block you configured.
- [`src/support-graph.ts`](./src/support-graph.ts) — the agent. It shows **both** kinds of memory: the
  `messages` channel lives on the thread's checkpoint (which is what makes a reply hours later
  continue the conversation), while a `getStore()` node remembers the customer across threads.
- [`src/whatsapp-agent.test.ts`](./src/whatsapp-agent.test.ts) — eight offline tests, each pinning a
  failure that has shipped broken in real integrations.

## Going live

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_WHATSAPP_FROM`, point your number's webhook
at `/channels/twilio`, and add your public origin to `langgraph.json`:

```jsonc
"twilio": { "path": "…", "assistant": "support", "public_url": "https://api.example.com" }
```

**`public_url` is not optional behind a proxy.** Twilio signs the full request URL, so verification
depends on knowing what it signed — and the only headers that could tell the server are ones the
caller controls, so skein will not guess.

`TWILIO_TYPING_INDICATOR_URL` enables the indicator
([typing indicators](https://www.twilio.com/docs/whatsapp/api/typing-indicators-resource) are public
beta, so the endpoint is configuration rather than a baked-in constant).

## Tests

```bash
nx test example-whatsapp-agent
```

Eight tests, all offline. **Not** covered, and deliberately not faked: real Twilio retry timing, real
proxy header behaviour, the multi-replica half of the resume race, and the live typing endpoint.
