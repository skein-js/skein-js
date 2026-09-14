import { expect, it } from "vitest";

import {
  composeRoutedChannel,
  declareChannelDestinationDelivery,
  type ChannelDestinationDelivery,
  type ChannelDestinationIntent,
} from "./index.js";

it("exports the routed-channel contract from the package root", () => {
  const intent: ChannelDestinationIntent = {
    destination: "email",
    target: null,
    payload: { subject: "Hello" },
  };
  const destination = async (_delivery: ChannelDestinationDelivery): Promise<void> => {};

  expect(composeRoutedChannel).toBeTypeOf("function");
  expect(declareChannelDestinationDelivery).toBeTypeOf("function");
  expect(intent.destination).toBe("email");
  expect(destination).toBeTypeOf("function");
});
