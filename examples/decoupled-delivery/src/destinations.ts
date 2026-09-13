import { emailDestination } from "./email-destination.js";
import { whatsappApprovalDestination } from "./whatsapp-approval-destination.js";
import { whatsappDestination } from "./whatsapp-destination.js";
import type { DestinationRegistry } from "./workflow-delivery.js";

export const destinations: DestinationRegistry = new Map(
  [emailDestination, whatsappDestination, whatsappApprovalDestination].map((destination) => [
    destination.name,
    destination,
  ]),
);
