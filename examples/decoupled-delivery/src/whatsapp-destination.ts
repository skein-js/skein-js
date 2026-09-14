import type { ChannelDestinationDelivery } from "@skein-js/channels";
import { z } from "zod";

import { recordDelivery } from "./delivery-recorder.js";

const targetSchema = z.object({ to: z.string().min(1) });
const payloadSchema = z.object({ body: z.string() });

export async function whatsappDestination(delivery: ChannelDestinationDelivery): Promise<void> {
  await recordDelivery({
    destination: "whatsapp",
    runId: delivery.runId,
    target: targetSchema.parse(delivery.target),
    payload: payloadSchema.parse(delivery.payload),
  });
}
