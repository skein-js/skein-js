import { z } from "zod";

import { recordDelivery } from "./delivery-recorder.js";
import type { WorkflowDestination } from "./workflow-delivery.js";

const targetSchema = z.object({ to: z.string().min(1) });
const payloadSchema = z.object({ body: z.string() });

export const whatsappDestination: WorkflowDestination = {
  name: "whatsapp",
  async deliver(delivery) {
    await recordDelivery({
      destination: "whatsapp",
      runId: delivery.runId,
      target: targetSchema.parse(delivery.target),
      payload: payloadSchema.parse(delivery.payload),
    });
  },
};
