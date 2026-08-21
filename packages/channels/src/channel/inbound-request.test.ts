// What a channel sees when it verifies a request — especially the two fields signatures depend on.

import { describe, expect, it, vi } from "vitest";

import type { Channel } from "./channel.js";
import { buildInboundRequest, streamModesFor } from "./inbound-request.js";

const raw = {
  method: "POST",
  url: "http://127.0.0.1:2024/channels/twilio",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "sig" },
  text: "From=whatsapp%3A%2B254712345678&Body=I+want+a+refund",
};

describe("buildInboundRequest", () => {
  it("decodes a form body", () => {
    // Twilio, and every slash command. A pipeline that only spoke JSON could not serve them.
    expect(buildInboundRequest(raw).form()).toEqual({
      From: "whatsapp:+254712345678",
      Body: "I want a refund",
    });
  });

  it("lower-cases header names", () => {
    // A channel comparing header names should not have to know which transport delivered the request.
    expect(buildInboundRequest(raw).headers["x-twilio-signature"]).toBe("sig");
  });

  it("presents the configured public origin, keeping the router's own path", () => {
    // Twilio signs the full URL, so this string *is* part of the signature. The origin is
    // configuration because `Host` and `X-Forwarded-Proto` are attacker-controlled; the path is not,
    // so a deployment does not have to restate it.
    const request = buildInboundRequest(
      { ...raw, url: "http://10.0.0.4:8080/channels/twilio?x=1" },
      { publicUrl: "https://api.example.com" },
    );

    expect(request.url.href).toBe("https://api.example.com/channels/twilio?x=1");
  });

  it("falls back to the request's own URL when nothing is configured", () => {
    expect(buildInboundRequest(raw).url.href).toBe("http://127.0.0.1:2024/channels/twilio");
  });

  it("caches each body view", () => {
    // `verify` and `parseEvent` usually want the same shape, and parsing twice is pure waste.
    const request = buildInboundRequest(raw);
    expect(request.form()).toBe(request.form());
  });

  it("hands back the untouched text for signature schemes that sign bytes", () => {
    // Slack signs `v0:{timestamp}:{body}` — re-serializing a parsed body does not reproduce it.
    expect(buildInboundRequest(raw).text()).toBe(raw.text);
  });

  it("treats an empty body as undefined JSON rather than throwing", () => {
    expect(buildInboundRequest({ ...raw, text: "" }).json()).toBeUndefined();
  });
});

describe("streamModesFor", () => {
  const channel = (signals?: Channel["signals"]): Channel =>
    ({
      name: "c",
      verify: vi.fn(),
      parseEvent: vi.fn(),
      ...(signals ? { signals } : {}),
    }) as Channel;

  it("always requests the custom stream, so a declared reply can be captured", () => {
    // `replyWith()` writes to the custom stream and the engine only captures frames it receives, so
    // omitting this made the documented first choice of reply source silently impossible.
    expect(streamModesFor(channel())).toContain("custom");
  });

  it("pays for no progress stream when a channel wants no signals", () => {
    // A GitHub channel should cost what an API run costs, plus the custom stream it may reply on.
    expect(streamModesFor(channel())).toEqual(["values", "custom"]);
  });

  it("adds only the cheap stream for a progress subscription", () => {
    // The load argument: an indicator needs to know work is happening, not what the tokens were.
    expect(streamModesFor(channel({ kinds: ["progress"] }))).toEqual([
      "values",
      "custom",
      "updates",
    ]);
  });

  it("never selects token streaming", () => {
    const modes = streamModesFor(channel({ kinds: ["progress", "keepalive"] }));
    expect(modes).not.toContain("events");
  });
});
