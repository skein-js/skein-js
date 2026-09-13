import { z } from "zod";

import { recordDelivery } from "./delivery-recorder.js";
import type { WorkflowDestination } from "./workflow-delivery.js";

const targetSchema = z.object({ to: z.string().email() });
const payloadSchema = z.object({ subject: z.string(), body: z.string() });

export const emailDestination: WorkflowDestination = {
  name: "email",
  async deliver(delivery) {
    await recordDelivery({
      destination: "email",
      runId: delivery.runId,
      target: targetSchema.parse(delivery.target),
      payload: payloadSchema.parse(delivery.payload),
    });
  },
};
