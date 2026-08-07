// What counts as "the same request". The fingerprint is what turns a provider's retry into a replay
// instead of a second run, so both directions matter: it must be stable across things that do not
// change the request (key order), and sensitive to everything that does (path, query, body, thread).

import { describe, expect, it } from "vitest";

import type { ProtocolRequest } from "../create-handlers.js";

import { idempotencyScope, requestFingerprint } from "./fingerprint.js";

function request(overrides: Partial<ProtocolRequest> = {}): ProtocolRequest {
  return {
    method: "POST",
    url: "http://localhost:2024/threads/t-1/runs",
    params: {},
    query: {},
    body: { assistant_id: "agent", input: { messages: [] } },
    headers: {},
    ...overrides,
  };
}

describe("requestFingerprint", () => {
  it("ignores object key order, so a reserialized retry is not a false mismatch", () => {
    // The realistic failure this prevents: an HTTP client that emits keys in a different order on the
    // retry than on the first attempt. Byte-different, semantically identical — a 422 here would look
    // like a skein bug and be impossible to reproduce on demand.
    const a = request({ body: { assistant_id: "agent", input: { a: 1, b: 2 } } });
    const b = request({ body: { input: { b: 2, a: 1 }, assistant_id: "agent" } });

    expect(requestFingerprint(a)).toBe(requestFingerprint(b));
  });

  it("respects array order, because order is meaning in an array", () => {
    // A message list is not a set. Sorting arrays to be "more canonical" would hash two genuinely
    // different conversations the same.
    const a = request({ body: { input: { messages: ["first", "second"] } } });
    const b = request({ body: { input: { messages: ["second", "first"] } } });

    expect(requestFingerprint(a)).not.toBe(requestFingerprint(b));
  });

  it("distinguishes the same body posted to two different threads", () => {
    // The concrete path, not the route template: `/threads/{id}/runs` would hash these the same, and
    // the second thread would be answered with the first thread's run.
    const a = request({ url: "http://localhost:2024/threads/t-1/runs" });
    const b = request({ url: "http://localhost:2024/threads/t-2/runs" });

    expect(requestFingerprint(a)).not.toBe(requestFingerprint(b));
  });

  it("ignores the host, so two ingresses to one server agree", () => {
    const a = request({ url: "http://localhost:2024/threads/t-1/runs" });
    const b = request({ url: "https://api.example.com/threads/t-1/runs" });

    expect(requestFingerprint(a)).toBe(requestFingerprint(b));
  });

  it("ignores query parameter order but not query content", () => {
    // A query flag can change what a create does — `POST /runs/wait` reads `cancel_on_disconnect` —
    // so two requests differing only there are not the same request.
    const ab = request({ query: { a: "1", b: "2" } });
    const ba = request({ query: { b: "2", a: "1" } });
    const different = request({ query: { a: "1", b: "3" } });

    expect(requestFingerprint(ab)).toBe(requestFingerprint(ba));
    expect(requestFingerprint(ab)).not.toBe(requestFingerprint(different));
  });

  it("distinguishes a changed body", () => {
    const a = request();
    const b = request({ body: { assistant_id: "other", input: { messages: [] } } });

    expect(requestFingerprint(a)).not.toBe(requestFingerprint(b));
  });

  it("does not drop a `__proto__` field, which would collide two different bodies", () => {
    // Assigning `sorted["__proto__"]` on a plain-object accumulator hits the prototype setter rather
    // than creating an own property, so the key would vanish and these two would hash the same.
    const plain = request({ body: { assistant_id: "agent" } });
    const withProto = request({ body: { assistant_id: "agent", ["__proto__"]: { admin: true } } });

    expect(requestFingerprint(plain)).not.toBe(requestFingerprint(withProto));
  });

  it("distinguishes the method", () => {
    expect(requestFingerprint(request({ method: "POST" }))).not.toBe(
      requestFingerprint(request({ method: "PUT" })),
    );
  });

  it("treats an absent body and a null body alike, and neither throws", () => {
    expect(requestFingerprint(request({ body: undefined }))).toBe(
      requestFingerprint(request({ body: null })),
    );
  });

  it("falls back to the raw url rather than throwing on a relative one", () => {
    // An adapter that hands over a path instead of an absolute URL must not turn every idempotent
    // request into a 500.
    expect(() => requestFingerprint(request({ url: "/threads/t-1/runs" }))).not.toThrow();
  });
});

describe("idempotencyScope", () => {
  it("separates two principals using the same key", () => {
    // The security property: without the principal, tenant B guessing tenant A's key is handed A's
    // recorded response, which names a run and a thread B cannot otherwise see.
    expect(idempotencyScope(request(), "alice")).not.toBe(idempotencyScope(request(), "bob"));
  });

  it("separates the same key on two paths", () => {
    const runs = idempotencyScope(request({ url: "http://x/threads/t-1/runs" }), "alice");
    const wait = idempotencyScope(request({ url: "http://x/threads/t-1/runs/wait" }), "alice");

    expect(runs).not.toBe(wait);
  });

  it("gives every caller one scope when there is no auth", () => {
    // The correct reading of a server with no tenants: there is only one caller.
    expect(idempotencyScope(request(), undefined)).toBe(idempotencyScope(request(), undefined));
  });

  it("does not let a principal id forge another scope by containing the separator", () => {
    // The principal is last precisely so it cannot shift the fields before it.
    expect(idempotencyScope(request(), "alice bob")).not.toBe(idempotencyScope(request(), "alice"));
  });
});
