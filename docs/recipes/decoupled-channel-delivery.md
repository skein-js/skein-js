# Route email to WhatsApp with LangGraph and decoupled channels

Use decoupled channel delivery when an event arrives through one provider but LangGraph must choose
another destination: email → LangGraph → WhatsApp, WhatsApp → LangGraph → email, or one source routed
to several application-owned provider adapters.

The source still uses Skein's normal channel pipeline. The only extra layer is an allowlisted
destination map plus one explicit instruction written by the graph.

The example below handles a concrete request: a customer emails **“Please refund KES 27,500 for
order GT-1042; I was charged twice.”** LangGraph asks Finance for approval over WhatsApp, the Finance
reply resumes the interrupted graph, and the customer receives the decision by email.

## See the refund approval workflow

The recording follows the complete example: an email starts the workflow, LangGraph pauses for the
three required approvals, each authenticated WhatsApp response resumes its own interrupt, and the
approved result is delivered back to the customer by email.

<video controls playsinline preload="metadata" style="width: 100%; border-radius: 12px">
  <source src="../videos/decoupled-refund-approval.mp4" type="video/mp4">
  Your browser cannot play this video.
</video>

## When source and destination should be separate

Decoupling is appropriate when routing is a workflow decision rather than an inherent response:

- an ERP order event alerts a sales team over WhatsApp;
- an email refund request asks HR, a manager, and Finance for approval;
- a personal assistant reads calendar or email events and sends a WhatsApp briefing.

If a WhatsApp message simply needs a WhatsApp reply, use the smaller
[coupled WhatsApp channel recipe](./coupled-channel.md). Both forms use the same `Channel`, run,
thread, LangGraph, and outbox primitives; decoupling is additive rather than a replacement.

## 1. Define an inbound email source

A source verifies and parses only. `composeRoutedChannel` arms the existing durable callback path, so
the source does not need a fake email `deliver` method. Both inbound providers use one trusted,
tenant-scoped workflow ID when they intentionally converge on the same thread:

```ts
const tenantId = "acme"; // Deployment configuration, never inbound request data.

export function workflowThreadId(refundId: string): string {
  return `relay:${tenantId}:${refundId}`;
}
```

Here `refundId` is issued by the application or verified provider metadata; do not derive an
authoritative thread ID directly from email text or another user-controlled field.

```ts
import type { Channel } from "@skein-js/channels";
import { z } from "zod";

import { workflowThreadId } from "./workflow-thread-id.js";

const refundEmailSchema = z.object({
  messageId: z.string().min(1),
  refundId: z.string().min(1),
  from: z.string().email(),
  orderId: z.string().min(1),
  amountKes: z.number().positive(),
  reason: z.string().min(1),
});

export const emailSource = {
  name: "email-source",
  verify(request) {
    if (!verifyEmailWebhook(request)) return false;
    return { identity: "channel:email:inbound" };
  },
  parseEvent(request) {
    const email = refundEmailSchema.parse(request.json());
    return {
      kind: "event" as const,
      event: {
        threadKey: email.refundId,
        threadId: workflowThreadId(email.refundId),
        idempotencyKey: email.messageId,
        input: {
          source: "email",
          refundId: email.refundId,
          customerEmail: email.from,
          orderId: email.orderId,
          amountKes: email.amountKes,
          reason: email.reason,
          financeWhatsapp: "whatsapp:+254700000013",
        },
      },
    };
  },
} satisfies Pick<Channel, "name" | "verify" | "parseEvent">;
```

## 2. Allowlist provider destinations

Destination callbacks own credentials, provider validation, authorization, and idempotency. Names
are explicit and local to this composed channel. The map allowlists provider adapters, not recipients:
authorize every target from trusted application data rather than treating an LLM-selected or
user-supplied phone number as permission to send.

```ts
import { composeRoutedChannel, type ChannelDestinationDelivery } from "@skein-js/channels";
import { z } from "zod";

const whatsappDeliverySchema = z.object({
  target: z.object({ to: z.string().min(1) }),
  payload: z.object({ body: z.string().min(1) }),
});
const emailDeliverySchema = z.object({
  target: z.object({ to: z.string().email() }),
  payload: z.object({ subject: z.string(), body: z.string() }),
});

export const destinations = new Map([
  [
    "whatsapp",
    async (delivery: ChannelDestinationDelivery) => {
      const message = whatsappDeliverySchema.parse(delivery);
      await assertAuthorizedRecipient(delivery.threadId, "whatsapp", message.target.to);
      await sendWhatsAppMessage(
        { to: message.target.to, body: message.payload.body },
        { key: delivery.runId },
      );
    },
  ],
  [
    "email",
    async (delivery: ChannelDestinationDelivery) => {
      const message = emailDeliverySchema.parse(delivery);
      await assertAuthorizedRecipient(delivery.threadId, "email", message.target.to);
      await sendEmail(
        {
          to: message.target.to,
          subject: message.payload.subject,
          body: message.payload.body,
        },
        { key: delivery.runId },
      );
    },
  ],
]);

export const channel = composeRoutedChannel(emailSource, destinations);
```

The map is copied at construction and is the complete adapter allowlist. Unknown destination names
fail the durable outbox attempt instead of silently dropping or guessing a route. Recipient and
operation policy remains application-owned; `assertAuthorizedRecipient` represents a lookup against
trusted workflow or tenant data, not another check of the recipient's string shape.

## 3. Let LangGraph choose WhatsApp

LangGraph passes `config.writer` to the node. The graph declares data; the destination callback
performs the external side effect only after the run settles.

```ts
import {
  Annotation,
  END,
  interrupt,
  START,
  StateGraph,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { declareChannelDestinationDelivery } from "@skein-js/channels";

const State = Annotation.Root({
  source: Annotation<"email">,
  refundId: Annotation<string>,
  customerEmail: Annotation<string>,
  orderId: Annotation<string>,
  amountKes: Annotation<number>,
  reason: Annotation<string>,
  financeWhatsapp: Annotation<string>,
  financeDecision: Annotation<"approve" | "reject" | undefined>,
});

function notifyFinance(state: typeof State.State, config: LangGraphRunnableConfig) {
  declareChannelDestinationDelivery(config.writer, {
    destination: "whatsapp",
    target: { to: state.financeWhatsapp },
    payload: {
      body:
        `Approve KES ${state.amountKes.toLocaleString()} refund for ${state.orderId}? ` +
        `Reason: ${state.reason}. Reply APPROVE or REJECT.`,
    },
  });
  return {};
}

function awaitFinance(state: typeof State.State) {
  const decision = interrupt({
    kind: "refund-approval",
    refundId: state.refundId,
    assignedTo: state.financeWhatsapp,
  });
  return { financeDecision: decision as "approve" | "reject" };
}

function emailCustomer(state: typeof State.State, config: LangGraphRunnableConfig) {
  const approved = state.financeDecision === "approve";
  declareChannelDestinationDelivery(config.writer, {
    destination: "email",
    target: { to: state.customerEmail },
    payload: {
      subject: approved
        ? `Refund approved for ${state.orderId}`
        : `Refund update for ${state.orderId}`,
      body: approved
        ? `Finance approved your KES ${state.amountKes.toLocaleString()} refund.`
        : "Finance could not approve this refund. Our support team will contact you.",
    },
  });
  return {};
}

export const graph = new StateGraph(State)
  .addNode("notify-finance", notifyFinance)
  .addNode("await-finance", awaitFinance)
  .addNode("email-customer", emailCustomer)
  .addEdge(START, "notify-finance")
  .addEdge("notify-finance", "await-finance")
  .addEdge("await-finance", "email-customer")
  .addEdge("email-customer", END)
  .compile();
```

On the first run, `notify-finance` supplies the durable WhatsApp delivery and `await-finance` parks
the thread. The WhatsApp approval webhook needs its own verified source channel, must address the same
trusted workflow thread, and resumes the interrupt:

```ts
import { composeRoutedChannel, type Channel } from "@skein-js/channels";
import { z } from "zod";

import { destinations } from "./destinations.js";
import { workflowThreadId } from "./workflow-thread-id.js";

const financeReplySchema = z.object({
  messageId: z.string().min(1),
  refundId: z.string().min(1),
  interruptId: z.string().min(1),
  from: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
});

const whatsappSource = {
  name: "whatsapp-source",
  verify(request) {
    if (!verifyWhatsAppWebhook(request)) return false;
    const message = financeReplySchema.parse(request.json());
    return { identity: `channel:whatsapp:${message.from}` };
  },
  parseEvent(request) {
    const message = financeReplySchema.parse(request.json());
    return {
      kind: "event" as const,
      event: {
        threadKey: message.refundId,
        threadId: workflowThreadId(message.refundId),
        idempotencyKey: message.messageId,
        input: { source: "whatsapp", ...message },
        resumeWith: { [message.interruptId]: message.decision },
      },
    };
  },
} satisfies Pick<Channel, "name" | "verify" | "parseEvent">;

export const channel = composeRoutedChannel(whatsappSource, destinations);
```

`workflowThreadId` must derive a tenant-scoped ID from trusted workflow data, and both sources must use
the same function. Derive the Finance principal from the verified WhatsApp sender and validate that
the principal is assigned to this approval before accepting the decision. The runnable example
performs both checks and keeps the actor, provider event ID, and timestamp in graph state as an audit
trail.

Only `declareChannelDestinationDelivery` triggers a routed destination. Ordinary `replyWith` output
and inferred AI replies are ignored here, preventing an accidental chat response from becoming an
external action. `target` and `payload` must be JSON-persistable; the destination validates their
provider-specific shape.

## 4. Configure the source route

```jsonc
{
  "graphs": { "relay": "./src/relay-graph.ts:graph" },
  "skein": {
    "channels": {
      "email": {
        "path": "./src/email-channel.ts:channel",
        "assistant": "relay",
        "public_url": "https://api.example.com",
      },
      "whatsapp": {
        "path": "./src/whatsapp-channel.ts:channel",
        "assistant": "relay",
        "public_url": "https://api.example.com",
      },
    },
  },
}
```

Configured route keys and explicit source names must be unique. Skein rejects those collisions at
boot so a delivery alias cannot resolve to the wrong channel. That does not namespace an explicit
`threadId`: this recipe intentionally shares one between email and WhatsApp. Build explicit IDs from
trusted, tenant-scoped workflow identifiers; when `threadId` is omitted, Skein safely namespaces the
derived ID by channel name instead.

The complete flow is:

```text
Customer email → LangGraph → Finance WhatsApp → interrupt/resume → LangGraph → customer email
```

For conditional email/WhatsApp routing plus parallel LangGraph `interrupt()` approvals, run
[`examples/decoupled-delivery`](https://github.com/skein-js/skein-js/tree/main/examples/decoupled-delivery).
