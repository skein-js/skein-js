# Build a LangGraph WhatsApp workflow with a coupled channel

Use a coupled channel when a workflow receives messages from a provider and its outcome naturally goes
back through the same provider: WhatsApp → LangGraph → WhatsApp, Slack → LangGraph → Slack, or email
→ LangGraph → email. One `Channel` owns both translations, while Skein supplies authentication,
deduplication, thread resolution, interrupt/resume, and durable delivery.

Consider a customer who sends **“Where is order GT-1042?”** to a shop's WhatsApp number. The graph
looks up the shipment and replies **“GT-1042 left our Nairobi warehouse and arrives tomorrow.”** The
sender, conversation, and expected return provider are already the same, so splitting the source and
destination would add ceremony without adding control.

## When coupling is the simpler design

Coupling is useful, not a limitation, when the inbound event already contains the correct reply
address. A WhatsApp sender expects a WhatsApp response, and keeping both provider mappings together
means fewer names, maps, and failure paths.

Use a [cross-provider workflow](./decoupled-channel-delivery.md) when LangGraph must choose a
different destination—for example, an email source that should alert a manager over WhatsApp.

## Implement the WhatsApp channel

The event's `replyTo` is opaque to Skein. It is stored with the run and passed back to the same
channel's `deliver` method after the run settles.

```ts
import type { Channel } from "@skein-js/channels";
import { z } from "zod";

const whatsappReplyTargetSchema = z.object({ to: z.string().min(1) });

export const channel: Channel = {
  name: "whatsapp",

  verify(request) {
    if (!verifyWhatsAppSignature(request)) return false;
    const message = request.form();
    return { identity: `channel:whatsapp:${message["From"]}` };
  },

  parseEvent(request) {
    const message = request.form();
    if (!message["Body"] || !message["From"]) return { kind: "ignore" };

    return {
      kind: "event",
      event: {
        threadKey: message["From"],
        idempotencyKey: message["MessageSid"],
        input: { customerMessage: message["Body"] },
        resumeWith: message["Body"],
        replyTo: { to: message["From"] },
      },
    };
  },

  async deliver(outcome, target) {
    if (outcome.reply === undefined) return;
    const { to } = whatsappReplyTargetSchema.parse(target);
    await sendWhatsAppMessage({ to, body: String(outcome.reply) }, { key: outcome.runId });
  },
};
```

Provider retries cannot create duplicate runs when `idempotencyKey` is stable. Delivery is
at-least-once, so use `outcome.runId` as a provider idempotency key when the provider supports one.

## Return a reply from LangGraph

A LangGraph node can declare the exact value delivered by the channel with Skein's existing
`replyWith` helper. If it does not, Skein can fall back to the last AI message in message-shaped
state.

```ts
import {
  Annotation,
  END,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { replyWith } from "@skein-js/agent-protocol";

const State = Annotation.Root({ customerMessage: Annotation<string> });

async function answerOrderQuestion(state: typeof State.State, config: LangGraphRunnableConfig) {
  const orderId = /GT-\d+/.exec(state.customerMessage)?.[0];
  const shipment = orderId ? await orderSystem.findShipment(orderId) : undefined;

  const answer = shipment
    ? `${orderId} ${shipment.status} and arrives ${shipment.estimatedArrival}.`
    : "I could not find that order. Please send the order number, for example GT-1042.";

  config.writer?.(replyWith(answer));
  return {};
}

export const graph = new StateGraph(State)
  .addNode("answer-order-question", answerOrderQuestion)
  .addEdge(START, "answer-order-question")
  .addEdge("answer-order-question", END)
  .compile();
```

Bind the channel to that graph:

```jsonc
{
  "graphs": { "order-support": "./src/graph.ts:graph" },
  "skein": {
    "channels": {
      "whatsapp": {
        "path": "./src/whatsapp-channel.ts:channel",
        "assistant": "order-support",
        "public_url": "https://api.example.com",
      },
    },
  },
}
```

The result follows one durable path:

```text
WhatsApp webhook → channel.parseEvent → LangGraph → channel.deliver → WhatsApp
```

For a runnable implementation with `interrupt()` and resume, see
[`examples/whatsapp-agent`](https://github.com/skein-js/skein-js/tree/main/examples/whatsapp-agent).
