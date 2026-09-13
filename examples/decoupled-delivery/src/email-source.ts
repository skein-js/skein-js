import { equalsConstantTime } from "@skein-js/agent-protocol";
import { z } from "zod";

import type { WorkflowSource } from "./workflow-delivery.js";

export const EMAIL_SOURCE_SECRET = "example-email-secret";

const emailEventSchema = z.object({
  eventId: z.string().min(1),
  conversationId: z.string().min(1),
  from: z.string().email(),
  subject: z.string(),
  body: z.string(),
  whatsappNumber: z.string().min(1),
  priority: z.enum(["low", "high"]),
  requiresApproval: z.boolean().optional().default(false),
  refundAmount: z.number().positive().optional(),
  refundReason: z.string().min(1).optional(),
});

export const emailSource: WorkflowSource = {
  name: "email",
  verify(request) {
    const token = request.headers["x-example-token"] ?? "";
    if (!equalsConstantTime(EMAIL_SOURCE_SECRET, token)) return false;
    return { identity: "source:email:approved-inbox" };
  },
  parseEvent(request) {
    const email = emailEventSchema.parse(request.json());
    return {
      kind: "event",
      event: {
        threadKey: email.conversationId,
        threadId: `relay:${email.conversationId}`,
        idempotencyKey: email.eventId,
        input: { source: "email", ...email },
        metadata: { source: "email", conversation_id: email.conversationId },
      },
    };
  },
};
