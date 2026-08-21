// `SKEIN_WEBHOOK_SECRET` has to reach an embedded host, not just the `langgraph.json` path.
//
// The bug this pins was a fail-open, which is the worst shape a signing bug can have: `embedInMemoryGraphs`
// set no `webhooks` at all, so a host that exported the secret and followed the docs sent **unsigned**
// callbacks. Nothing looked wrong from the inside — an unsigned callback is dispatched exactly like a
// signed one, and only the receiver (which is usually someone else's system) could ever notice.

import { afterEach, describe, expect, it } from "vitest";

import { embedInMemoryGraphs } from "./in-memory-deps.js";
import { WEBHOOK_SECRET_ENV } from "./webhooks-config.js";

const original = process.env[WEBHOOK_SECRET_ENV];

afterEach(() => {
  if (original === undefined) delete process.env[WEBHOOK_SECRET_ENV];
  else process.env[WEBHOOK_SECRET_ENV] = original;
});

describe("embedInMemoryGraphs and webhook signing", () => {
  it("picks the signing key up from the environment", () => {
    process.env[WEBHOOK_SECRET_ENV] = "whsec_from_env";

    const deps = embedInMemoryGraphs({});

    expect(deps.webhooks?.secrets).toEqual(["whsec_from_env"]);
  });

  it("lets an explicit override win, since it is spread last", () => {
    process.env[WEBHOOK_SECRET_ENV] = "whsec_from_env";

    const deps = embedInMemoryGraphs({}, { webhooks: { secrets: ["whsec_explicit"] } });

    expect(deps.webhooks?.secrets).toEqual(["whsec_explicit"]);
  });

  it("adds nothing when the environment configures nothing", () => {
    // The compatibility half: a host that sets no env var gets exactly the deps it got before.
    delete process.env[WEBHOOK_SECRET_ENV];

    expect(embedInMemoryGraphs({})).not.toHaveProperty("webhooks");
  });
});
