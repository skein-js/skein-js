// `webhook` accepts http(s) only.
//
// The hazard this closes: skein derives its own delivery URLs under a private scheme for a run whose
// reply belongs to a channel, and the delivery machinery cannot tell a caller-supplied URL from a
// server-derived one. `z.string().url()` accepts *any* scheme the platform URL parser does — so
// without this, a caller could name that scheme on an ordinary run create and have the server deliver
// a message of their choosing through somebody else's provider account, bypassing `require_https` and
// `allowed_hosts` on the way out.
//
// The boundary that can tell the two apart is this one, so the check lives here.

import { describe, expect, it } from "vitest";

import { parse } from "./parse.js";
import { runCreateSchema } from "./schemas.js";

const run = { assistant_id: "agent" };

describe("the webhook URL scheme", () => {
  it("accepts http and https", () => {
    expect(parse(runCreateSchema, { ...run, webhook: "https://example.test/hook" })).toMatchObject({
      webhook: "https://example.test/hook",
    });
    expect(parse(runCreateSchema, { ...run, webhook: "http://example.test/hook" })).toMatchObject({
      webhook: "http://example.test/hook",
    });
  });

  it("refuses skein's own internal delivery scheme", () => {
    // The forgery this exists to stop.
    expect(() =>
      parse(runCreateSchema, { ...run, webhook: "skein+channel://twilio/eyJ0byI6IisxIn0" }),
    ).toThrow();
  });

  it("refuses every other scheme too", () => {
    // Not a denylist of one: `file:` and `data:` were never legitimate here either, and a denylist
    // would go stale the moment another internal scheme is added.
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "ftp://example.test/x"]) {
      expect(() => parse(runCreateSchema, { ...run, webhook: url })).toThrow();
    }
  });

  it("still refuses a value that is not a URL at all", () => {
    expect(() => parse(runCreateSchema, { ...run, webhook: "not-a-url" })).toThrow();
  });
});
