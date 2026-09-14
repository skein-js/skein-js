import { emailDestination } from "./email-destination.js";
import { whatsappApprovalDestination } from "./whatsapp-approval-destination.js";
import { whatsappDestination } from "./whatsapp-destination.js";
export const destinations = new Map([
  ["email", emailDestination],
  ["whatsapp", whatsappDestination],
  ["whatsapp-approval-batch", whatsappApprovalDestination],
] as const);
