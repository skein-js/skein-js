// Unit tests for the shared runtime CORS core — locking in the review fixes: an unset origin must
// never be reflected (so it can't pair with credentials into a wildcard bypass), regex origins are
// full-string-anchored, and cors-config's function-form origins are honored.

import { describe, expect, it } from "vitest";

import { allowedOrigin, corsResponseHeaders } from "./cors-runtime.js";

describe("allowedOrigin", () => {
  it("resolves an UNSET origin to `*`, never the reflected request origin (credentials-safe)", () => {
    expect(allowedOrigin("https://attacker.example", {})).toBe("*");
    expect(allowedOrigin("https://attacker.example", { credentials: true })).toBe("*");
  });

  it("does not emit a reflected origin + credentials for a credentialed-but-origin-less config", () => {
    const headers = corsResponseHeaders("https://attacker.example", { credentials: true });
    // `*` (not the attacker origin) — browsers reject `*` with credentials, so the misconfig is inert.
    expect(headers["access-control-allow-origin"]).toBe("*");
  });

  it("reflects only for the explicit `true` / `cors: true` dev shorthand", () => {
    expect(allowedOrigin("https://app.example", true)).toBe("https://app.example");
    expect(allowedOrigin("https://app.example", { origin: true })).toBe("https://app.example");
    // The boolean shorthand never attaches credentials.
    expect(
      corsResponseHeaders("https://app.example", true)["access-control-allow-credentials"],
    ).toBe(undefined);
  });

  it("full-string-anchors a RegExp origin (no substring/suffix bypass)", () => {
    // Anchored like cors-config's allow_origin_regex: the pattern must match the WHOLE origin, so a
    // trailing `.attacker.io` can't ride along on a `trusted.com` match.
    const cors = { origin: /https:\/\/([a-z]+\.)?trusted\.com/ } as const;
    expect(allowedOrigin("https://trusted.com.attacker.io", cors)).toBeUndefined();
    expect(allowedOrigin("https://trusted.com", cors)).toBe("https://trusted.com");
    expect(allowedOrigin("https://app.trusted.com", cors)).toBe("https://app.trusted.com");
  });

  it("honors a cors-config-style function origin", () => {
    const allow = {
      origin: (_o: string | undefined, cb: (e: Error | null, ok: boolean) => void) =>
        cb(null, true),
    };
    const deny = {
      origin: (_o: string | undefined, cb: (e: Error | null, ok: boolean) => void) =>
        cb(null, false),
    };
    expect(allowedOrigin("https://app.example", allow)).toBe("https://app.example");
    expect(allowedOrigin("https://app.example", deny)).toBeUndefined();
  });

  it("matches string and array origins exactly", () => {
    expect(allowedOrigin("https://a.example", { origin: "https://a.example" })).toBe(
      "https://a.example",
    );
    expect(allowedOrigin("https://b.example", { origin: ["https://a.example"] })).toBeUndefined();
    expect(allowedOrigin("https://a.example", { origin: ["https://a.example"] })).toBe(
      "https://a.example",
    );
  });

  it("attaches credentials only with an explicit allow-listed (non-`*`) origin", () => {
    const headers = corsResponseHeaders("https://a.example", {
      origin: "https://a.example",
      credentials: true,
    });
    expect(headers["access-control-allow-origin"]).toBe("https://a.example");
    expect(headers["access-control-allow-credentials"]).toBe("true");
    expect(headers["vary"]).toBe("origin");
  });
});
