import { describe, expect, it } from "vitest";

import { formatDeliveryTarget } from "./delivery-target";

describe("formatDeliveryTarget", () => {
  it("shows a webhook host but never its credential-bearing path, query, or userinfo", () => {
    const target = "https://operator:secret@hooks.slack.com/services/T/B/token?key=hidden";
    const shown = formatDeliveryTarget(target);

    expect(shown).toBe("webhook · hooks.slack.com/…");
    expect(shown).not.toMatch(/operator|secret|services|token|hidden/);
  });

  it("shows a channel name but never its opaque reply payload", () => {
    const shown = formatDeliveryTarget("skein+channel://whatsapp/eyJ0byI6IisyNTQifQ");

    expect(shown).toBe("channel · whatsapp");
    expect(shown).not.toContain("eyJ0by");
  });

  it("reveals nothing from malformed or unsupported values", () => {
    expect(formatDeliveryTarget("not a url secret-token")).toBe("<unparseable url>");
    expect(formatDeliveryTarget("ftp://example.test/private")).toBe("<unparseable url>");
    expect(formatDeliveryTarget("skein+channel://%ZZ/private")).toBe("<unparseable url>");
  });
});
