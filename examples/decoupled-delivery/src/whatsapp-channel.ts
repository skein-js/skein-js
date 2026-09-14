import { composeRoutedChannel } from "@skein-js/channels";

import { destinations } from "./destinations.js";
import { whatsappSource } from "./whatsapp-source.js";

export const channel = composeRoutedChannel(whatsappSource, destinations);
