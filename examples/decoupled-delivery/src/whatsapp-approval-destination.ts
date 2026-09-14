import type { ChannelDestinationDelivery } from "@skein-js/channels";
import { z } from "zod";

import { recordDelivery } from "./delivery-recorder.js";

const approvalInterruptSchema = z.object({
  kind: z.literal("refund-approval"),
  refundId: z.string().min(1),
  role: z.enum(["hr", "manager", "finance"]),
  assignedPrincipal: z.string().min(1),
  whatsappNumber: z.string().min(1),
  amount: z.number().positive(),
  reason: z.string().min(1),
});

export async function whatsappApprovalDestination(
  delivery: ChannelDestinationDelivery,
): Promise<void> {
  const pending = Object.values(delivery.interrupts ?? {}).flat();
  for (const item of pending) {
    const approval = approvalInterruptSchema.parse(item.value);
    const interruptId = item.id;
    if (!interruptId) throw new Error(`The ${approval.role} approval has no interrupt id.`);
    await recordDelivery({
      destination: "whatsapp",
      runId: delivery.runId,
      idempotencyKey: `${delivery.runId}:${interruptId}`,
      target: { to: approval.whatsappNumber },
      payload: {
        kind: "refund-approval",
        interruptId,
        body: `Approve refund ${approval.refundId} for ${approval.amount}: ${approval.reason}?`,
        role: approval.role,
      },
    });
  }
}
