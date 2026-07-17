import { describe, expect, it } from "vitest";

import { corsFromHttpConfig, toCorsOptions, type LanggraphCorsConfig } from "./cors-config.js";

/** Resolve the function `origin` option into a simple `(origin) => boolean` allow predicate. */
function originPredicate(config: LanggraphCorsConfig): (candidate: string | undefined) => boolean {
  const { origin } = toCorsOptions(config);
  if (typeof origin !== "function") throw new Error("expected a function origin");
  return (candidate) => {
    let allowed = false;
    origin(candidate, (_err, result) => {
      allowed = result === true;
    });
    return allowed;
  };
}

describe("toCorsOptions (LangGraph http.cors → cors options)", () => {
  it("maps snake_case LangGraph fields onto cors option names", () => {
    const options = toCorsOptions({
      allow_origins: ["http://localhost:3000"],
      allow_methods: ["GET", "POST"],
      allow_headers: ["authorization"],
      allow_credentials: true,
      max_age: 600,
    });

    expect(options.origin).toEqual(["http://localhost:3000"]);
    expect(options.methods).toEqual(["GET", "POST"]);
    expect(options.allowedHeaders).toEqual(["authorization"]);
    expect(options.credentials).toBe(true);
    expect(options.maxAge).toBe(600);
  });

  it("always exposes LangGraph's content-location and x-pagination-total headers", () => {
    const options = toCorsOptions({ expose_headers: ["x-custom"] });
    expect(options.exposedHeaders).toEqual(
      expect.arrayContaining(["content-location", "x-pagination-total", "x-custom"]),
    );
  });

  it('treats a configured ["*"] as allow-all', () => {
    expect(toCorsOptions({ allow_origins: ["*"] }).origin).toBe("*");
  });

  it("full-matches allow_origin_regex (Starlette semantics), rejecting substring bypasses", () => {
    // Deliberately UNANCHORED, the idiomatic upstream form (Starlette full-matches).
    const allow = originPredicate({ allow_origin_regex: "https://.*\\.example\\.com" });

    expect(allow("https://app.example.com")).toBe(true);
    // A bare `.test()` would allow these via substring match — the fix anchors to a full match.
    expect(allow("https://x.example.com.attacker.io")).toBe(false);
    expect(allow("https://not-example.com")).toBe(false);
    expect(allow(undefined)).toBe(false);
  });

  it("allows an origin matching allow_origins OR allow_origin_regex (additive, not exclusive)", () => {
    const allow = originPredicate({
      allow_origins: ["https://app.example.com"],
      allow_origin_regex: "https://.*\\.preview\\.example\\.com",
    });

    expect(allow("https://app.example.com")).toBe(true); // from the list
    expect(allow("https://pr-7.preview.example.com")).toBe(true); // from the regex
    expect(allow("https://evil.com")).toBe(false);
  });

  it("reads http.cors from a config block, or returns undefined when absent", () => {
    expect(corsFromHttpConfig({ cors: { allow_origins: ["*"] } })?.origin).toBe("*");
    expect(corsFromHttpConfig({})).toBeUndefined();
    expect(corsFromHttpConfig(undefined)).toBeUndefined();
  });
});
