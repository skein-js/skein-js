import { skeinRoutes } from "@skein-js/agent-protocol";
import { describe, expect, it } from "vitest";

import {
  consoleMountFromHttpConfig,
  corsFromHttpConfig,
  disabledRoutesFromHttpConfig,
  routesFromHttpConfig,
  toCorsOptions,
  type LanggraphCorsConfig,
} from "./cors-config.js";

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
    expect(options.allowedHeaders).toEqual(["authorization", "idempotency-key"]);
    expect(options.credentials).toBe(true);
    expect(options.maxAge).toBe(600);
  });

  it("always exposes LangGraph's content-location and x-pagination-total headers", () => {
    const options = toCorsOptions({ expose_headers: ["x-custom"] });
    expect(options.exposedHeaders).toEqual(
      expect.arrayContaining(["content-location", "x-pagination-total", "x-custom"]),
    );
  });

  it("exposes idempotent-replay, so a browser client can tell a replay from a fresh create", () => {
    expect(toCorsOptions({}).exposedHeaders).toEqual(expect.arrayContaining(["idempotent-replay"]));
  });

  it("allows idempotency-key through an explicit allow_headers list", () => {
    // `allow_headers` replaces the default (which reflects whatever the browser asked for), so a
    // deployment setting its own list would otherwise block the header at the preflight — a CORS
    // error client-side with nothing logged on the server.
    expect(toCorsOptions({ allow_headers: ["authorization"] }).allowedHeaders).toContain(
      "idempotency-key",
    );
  });

  it("does not duplicate idempotency-key when allow_headers already spells it", () => {
    const options = toCorsOptions({ allow_headers: ["Idempotency-Key", "authorization"] });
    expect(options.allowedHeaders).toEqual(["Idempotency-Key", "authorization"]);
  });

  it("leaves an explicitly empty allow_headers empty", () => {
    // `allow_headers: []` is a deliberate "permit no custom request headers" posture. Widening it
    // would advertise a header the operator excluded on purpose.
    expect(toCorsOptions({ allow_headers: [] }).allowedHeaders).toEqual([]);
  });

  it("leaves allowedHeaders unset when no allow_headers is configured", () => {
    // Absent means the cors middleware reflects the request's own headers, which already admits
    // `Idempotency-Key`. Setting a list here would *narrow* the default, not widen it.
    expect(toCorsOptions({}).allowedHeaders).toBeUndefined();
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

describe("disabledRoutesFromHttpConfig / routesFromHttpConfig", () => {
  it("reads each disable_* flag onto its route group", () => {
    expect(disabledRoutesFromHttpConfig({ disable_store: true, disable_meta: true })).toEqual({
      store: true,
      meta: true,
    });
  });

  it("treats only literal true as disabling", () => {
    // LangGraph's schema defaults each flag to false, and an env-substituted config can carry the
    // string "false" — which must not remove a resource.
    expect(disabledRoutesFromHttpConfig({ disable_runs: false })).toEqual({});
    expect(disabledRoutesFromHttpConfig({ disable_runs: "false" })).toEqual({});
    expect(disabledRoutesFromHttpConfig({ disable_runs: 1 })).toEqual({});
    expect(disabledRoutesFromHttpConfig(undefined)).toEqual({});
  });

  it("returns the untouched table when no flag is set, and a narrower one when they are", () => {
    expect(routesFromHttpConfig(undefined)).toBe(skeinRoutes);
    expect(routesFromHttpConfig({ cors: { allow_origins: ["*"] } })).toBe(skeinRoutes);

    const withoutStore = routesFromHttpConfig({ disable_store: true });
    expect(withoutStore.length).toBeLessThan(skeinRoutes.length);
    expect(withoutStore.some((binding) => binding.group === "store")).toBe(false);
  });
});

describe("consoleMountFromHttpConfig", () => {
  it("is off unless the config asks for it", () => {
    expect(consoleMountFromHttpConfig(undefined)).toBeUndefined();
    expect(consoleMountFromHttpConfig({})).toBeUndefined();
    expect(consoleMountFromHttpConfig({ cors: { allow_origins: ["*"] } })).toBeUndefined();
  });

  it("mounts at /console for literal true", () => {
    expect(consoleMountFromHttpConfig({ console: true })).toBe("/console");
  });

  it("takes a string as the mount path, normalized", () => {
    expect(consoleMountFromHttpConfig({ console: "/admin/console" })).toBe("/admin/console");
    expect(consoleMountFromHttpConfig({ console: "admin" })).toBe("/admin");
    expect(consoleMountFromHttpConfig({ console: "/admin/" })).toBe("/admin");
  });

  it("never reads a disabling value as enabling", () => {
    // The console can read and delete every thread, memory and schedule on the server. The sharp case
    // is a *string* "false": unlike the disable_* flags, a string here is legitimate (it names a mount
    // path), so without special handling `"${SKEIN_CONSOLE}"` resolving to "false" would serve the
    // console at /false — switching on the thing the config meant to switch off.
    expect(consoleMountFromHttpConfig({ console: false })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: "false" })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: "FALSE" })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: "0" })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: "off" })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: 0 })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: 1 })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: null })).toBeUndefined();
  });

  it("reads the string spellings of true as the default mount", () => {
    expect(consoleMountFromHttpConfig({ console: "true" })).toBe("/console");
    expect(consoleMountFromHttpConfig({ console: "1" })).toBe("/console");
    expect(consoleMountFromHttpConfig({ console: "on" })).toBe("/console");
  });

  it("refuses to mount at the root, which would shadow the protocol", () => {
    expect(consoleMountFromHttpConfig({ console: "/" })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: "" })).toBeUndefined();
    expect(consoleMountFromHttpConfig({ console: "   " })).toBeUndefined();
  });
});
