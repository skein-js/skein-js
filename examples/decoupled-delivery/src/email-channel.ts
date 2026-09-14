import { composeRoutedChannel } from "@skein-js/channels";

import { destinations } from "./destinations.js";
import { emailSource } from "./email-source.js";

export const channel = composeRoutedChannel(emailSource, destinations);
