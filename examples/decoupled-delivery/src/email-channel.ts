import { destinations } from "./destinations.js";
import { emailSource } from "./email-source.js";
import { composeSourceChannel } from "./workflow-delivery.js";

export const channel = composeSourceChannel(emailSource, destinations);
