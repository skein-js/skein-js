import { destinations } from "./destinations.js";
import { whatsappSource } from "./whatsapp-source.js";
import { composeSourceChannel } from "./workflow-delivery.js";

export const channel = composeSourceChannel(whatsappSource, destinations);
