import { equalsConstantTime } from "@skein-js/agent-protocol";
import type { Channel } from "@skein-js/channels";
import { z } from "zod";

import { findRefundApproverByNumber } from "./approval-roles.js";

export const WHATSAPP_SOURCE_SECRET = "example-whatsapp-secret";

const whatsappEventBaseSchema = z.object({
  eventId: z.string().min(1),
  conversationId: z.string().min(1),
  from: z.string().min(1),
  body: z.string().min(1),
});

const whatsappEventSchema = z.union([
  whatsappEventBaseSchema.extend({
    kind: z.literal("instruction"),
    emailAddress: z.string().email(),
  }),
  whatsappEventBaseSchema.extend({
    kind: z.literal("approval"),
    interruptId: z.string().min(1),
    decision: z.enum(["approve", "reject"]),
  }),
]);

function principalForWhatsAppNumber(number: string): string {
  return (
    findRefundApproverByNumber(number)?.principal ??
    `channel:whatsapp:${number.replace(/^whatsapp:/, "")}`
  );
}

export const whatsappSource = {
  name: "whatsapp",
  verify(request) {
    const token = request.headers["x-example-token"] ?? "";
    if (!equalsConstantTime(WHATSAPP_SOURCE_SECRET, token)) return false;
    const candidate = whatsappEventBaseSchema.safeParse(request.json());
    if (!candidate.success) return false;
    const approver = findRefundApproverByNumber(candidate.data.from);
    return {
      identity: principalForWhatsAppNumber(candidate.data.from),
      permissions: approver ? [`refund:approve:${approver.role}`] : [],
      metadata: approver ? { approval_role: approver.role } : {},
    };
  },
  parseEvent(request) {
    const message = whatsappEventSchema.parse(request.json());
    if (message.kind === "approval") {
      const actor = principalForWhatsAppNumber(message.from);
      return {
        kind: "event",
        event: {
          threadKey: message.conversationId,
          threadId: `relay:${message.conversationId}`,
          idempotencyKey: message.eventId,
          input: { source: "whatsapp", ...message },
          resumeWith: {
            [message.interruptId]: {
              actor,
              outcome: message.decision,
              providerEventId: message.eventId,
              decidedAt: new Date().toISOString(),
            },
          },
          metadata: { source: "whatsapp", conversation_id: message.conversationId },
        },
      };
    }
    return {
      kind: "event",
      event: {
        threadKey: message.conversationId,
        threadId: `relay:${message.conversationId}`,
        idempotencyKey: message.eventId,
        input: { source: "whatsapp", ...message },
        metadata: { source: "whatsapp", conversation_id: message.conversationId },
      },
    };
  },
} satisfies Pick<Channel, "name" | "verify" | "parseEvent">;
