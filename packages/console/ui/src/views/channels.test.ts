import { describe, expect, it } from "vitest";

import type { ChannelSummary } from "@/api";

import { filterChannels } from "./channels";

const channels: ChannelSummary[] = [
  {
    route_name: "support-whatsapp",
    channel_name: "twilio",
    assistant: "support",
    allowed_assistants: ["refunds"],
    delivery_supported: true,
  },
  {
    route_name: "orders-email",
    channel_name: "imap",
    assistant: "orders",
    allowed_assistants: [],
    delivery_supported: false,
  },
];

describe("filterChannels", () => {
  it("matches route, provider, default assistant, and allowed assistants", () => {
    expect(filterChannels(channels, "refund").map((row) => row.route_name)).toEqual([
      "support-whatsapp",
    ]);
    expect(filterChannels(channels, "IMAP").map((row) => row.route_name)).toEqual(["orders-email"]);
  });

  it("returns all rows for an empty filter", () => {
    expect(filterChannels(channels, "  ")).toEqual(channels);
  });
});
