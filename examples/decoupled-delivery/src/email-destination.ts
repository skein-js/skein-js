import type { ChannelDestinationDelivery } from "@skein-js/channels";
import { z } from "zod";

import { recordDelivery } from "./delivery-recorder.js";

const targetSchema = z.object({ to: z.string().email() });
const payloadSchema = z.object({ subject: z.string(), body: z.string() });

export async function emailDestination(delivery: ChannelDestinationDelivery): Promise<void> {
  await recordDelivery({
    destination: "email",
    runId: delivery.runId,
    target: targetSchema.parse(delivery.target),
    payload: payloadSchema.parse(delivery.payload),
  });
}
