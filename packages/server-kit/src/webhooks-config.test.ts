// `skein.webhooks` (snake_case) → the engine's camelCase config.

import { describe, expect, it } from "vitest";

import { resolveWebhooks } from "./webhooks-config.js";

describe("resolveWebhooks", () => {
  it("resolves prefixed header secrets and combines compatible restrictions without widening Skein policy", () => {
    expect(
      resolveWebhooks(
        { allowed_hosts: ["a.example"], require_https: false },
        {
          compatible: {
            headers: { Authorization: "Bearer ${{ env.LG_WEBHOOK_TOKEN }}" },
            url: { allowed_domains: ["b.example"], allowed_ports: [], require_https: true },
          },
          env: { LG_WEBHOOK_TOKEN: "private-value" },
          disabled: true,
        },
      ),
    ).toEqual({
      allowedHosts: ["a.example"],
      requireHttps: true,
      headers: { authorization: "Bearer private-value" },
      url: { allowedDomains: ["b.example"], allowedPorts: [] },
      disabled: true,
    });
  });

  it.each([
    "${{ env.OTHER_TOKEN }}",
    "${{ env.LG_WEBHOOK_MISSING }}",
    "${{ unsupported }}",
    "token\nprivate-value",
  ])(
    "refuses unavailable or invalid configured header values without including secrets: %s",
    (template) => {
      expect(() =>
        resolveWebhooks(undefined, {
          compatible: { headers: { Authorization: template } },
          env: { OTHER_TOKEN: "private-value" },
        }),
      ).toThrow(/webhooks.headers/);
      try {
        resolveWebhooks(undefined, {
          compatible: { headers: { Authorization: template } },
          env: { OTHER_TOKEN: "private-value" },
        });
      } catch (error) {
        expect(String(error)).not.toContain("private-value");
      }
    },
  );

  it("maps every key to its camelCase counterpart", () => {
    expect(
      resolveWebhooks({
        retries: { max_attempts: 6, initial_delay_ms: 500 },
        max_payload_bytes: 1_024,
        retain_hours: 72,
        allowed_hosts: ["hooks.example.com"],
      }),
    ).toEqual({
      retries: { maxAttempts: 6, initialDelayMs: 500 },
      maxPayloadBytes: 1_024,
      retainHours: 72,
      allowedHosts: ["hooks.example.com"],
    });
  });

  it("reports nothing for an absent or empty block, so the defaults apply", () => {
    // `undefined` here means *defaults*, not disabled — a run carrying a `webhook` owes a callback
    // whatever the config said. An empty block must be indistinguishable from no block at all.
    expect(resolveWebhooks(undefined)).toBeUndefined();
    expect(resolveWebhooks({})).toBeUndefined();
    expect(resolveWebhooks({ retries: {} })).toBeUndefined();
  });

  it("carries a partial retry policy without inventing the rest", () => {
    // The engine fills each missing knob from its own default; filling them here would freeze today's
    // defaults into every config that set one field.
    expect(resolveWebhooks({ retries: { max_attempts: 3 } })).toEqual({
      retries: { maxAttempts: 3 },
    });
  });

  it("drops an explicitly empty allowlist rather than reading it as 'allow nothing'", () => {
    // `"allowed_hosts": []` is what you get from a template or a substitution that produced nothing.
    // Honouring it literally would kill every callback in the deployment, which no one can have meant.
    expect(resolveWebhooks({ allowed_hosts: [] })).toBeUndefined();
  });

  it("copies the allowlist, so a later mutation of the parsed config cannot widen it", () => {
    const raw = { allowed_hosts: ["hooks.example.com"] };
    const resolved = resolveWebhooks(raw);
    raw.allowed_hosts.push("evil.example.com");

    expect(resolved?.allowedHosts).toEqual(["hooks.example.com"]);
  });

  it("ignores a value of the wrong type instead of passing it through", () => {
    // The schema rejects these at load, but this resolver is also reachable from an embedder handing
    // over a hand-built object — and a string where a number belongs would become `NaN` milliseconds.
    const resolved = resolveWebhooks({
      retain_hours: "72",
      retries: { max_attempts: null },
    } as unknown as Parameters<typeof resolveWebhooks>[0]);

    expect(resolved).toBeUndefined();
  });
});
