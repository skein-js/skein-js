// The `Idempotency-Key` branch table. The property under test throughout: a retried create returns
// the original answer and does NOT reach the handler a second time — the handler's call count is the
// real assertion, because "a second run was started" is the failure this whole surface exists to
// prevent.

import { SkeinHttpError } from "@skein-js/core";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it, vi } from "vitest";

import type { ProtocolHandlers, ProtocolRequest, ProtocolResponse } from "../create-handlers.js";

import { createIdempotentHandlers, type IdempotencyOptions } from "./idempotent-handlers.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function request(overrides: Partial<ProtocolRequest> = {}): ProtocolRequest {
  return {
    method: "POST",
    url: "http://localhost:2024/threads/t-1/runs",
    params: {},
    query: {},
    body: { assistant_id: "agent" },
    headers: { "idempotency-key": "k-1" },
    ...overrides,
  };
}

/**
 * A handler table stubbed down to what this wrapper touches, plus a call counter per handler. Only
 * the wrapped names need to be real handlers; the rest of the table is never dispatched here.
 */
function harness(
  options: {
    respond?: (req: ProtocolRequest) => Promise<ProtocolResponse>;
    overrides?: Partial<IdempotencyOptions>;
  } = {},
) {
  const calls = { createBackgroundRun: 0, createStreamRun: 0, createRunBatch: 0 };
  const respond =
    options.respond ??
    (async (): Promise<ProtocolResponse> => ({
      kind: "json",
      status: 200,
      body: { run_id: "r-1" },
      headers: { "content-location": "/threads/t-1/runs/r-1" },
    }));

  const inner = {
    createBackgroundRun: async (req: ProtocolRequest) => {
      calls.createBackgroundRun += 1;
      return respond(req);
    },
    createRunBatch: async (req: ProtocolRequest) => {
      calls.createRunBatch += 1;
      return respond(req);
    },
    createStreamRun: async () => {
      calls.createStreamRun += 1;
      return { kind: "sse", status: 200, events: (async function* () {})() } as ProtocolResponse;
    },
  } as unknown as ProtocolHandlers;

  const store = new MemorySkeinStore();
  const handlers = createIdempotentHandlers(inner, {
    store,
    clock: () => new Date(),
    logger: silentLogger,
    ...options.overrides,
  });
  return { handlers, calls, store };
}

describe("createIdempotentHandlers", () => {
  it("passes a request without the header straight through", async () => {
    const { handlers, calls, store } = harness();

    const response = await handlers.createBackgroundRun(request({ headers: {} }));

    expect(response.status).toBe(200);
    expect(calls.createBackgroundRun).toBe(1);
    // Nothing recorded: a request with no key must not pay for a table it never reads.
    expect(await store.idempotency.get("POST /threads/t-1/runs ", "k-1")).toBeNull();
  });

  it("replays the recorded response without re-running the handler", async () => {
    const { handlers, calls } = harness();

    const first = await handlers.createBackgroundRun(request());
    const second = await handlers.createBackgroundRun(request());

    expect(calls.createBackgroundRun).toBe(1);
    expect(second.status).toBe(first.status);
    expect(second).toMatchObject({ body: { run_id: "r-1" } });
  });

  it("replays Content-Location, so useStream can still rejoin after a remount", async () => {
    // The header the SDK parses to fire `onRunCreated`. Dropping it on a replay breaks
    // `reconnectOnMount` silently — the client gets a 200 and no way to find its run again.
    const { handlers } = harness();

    await handlers.createBackgroundRun(request());
    const replay = await handlers.createBackgroundRun(request());

    expect(replay.headers).toMatchObject({
      "content-location": "/threads/t-1/runs/r-1",
      "idempotent-replay": "true",
    });
  });

  it("marks only the replay, never the original", async () => {
    const { handlers } = harness();

    const first = await handlers.createBackgroundRun(request());

    expect(first.headers?.["idempotent-replay"]).toBeUndefined();
  });

  it("rejects the same key with a different body as 422", async () => {
    // A caller bug worth surfacing. Answering it with the first request's response would be worse:
    // the caller believes their second, different request ran.
    const { handlers, calls } = harness();
    await handlers.createBackgroundRun(request());

    await expect(
      handlers.createBackgroundRun(request({ body: { assistant_id: "different" } })),
    ).rejects.toMatchObject({ status: 422 });
    expect(calls.createBackgroundRun).toBe(1);
  });

  it("returns 409 while the original is still in flight", async () => {
    // Rather than blocking on it: holding the connection ties up a socket for the length of a run and
    // times out in most proxies anyway.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handlers } = harness({
      respond: async () => {
        await gate;
        return { kind: "json", status: 200, body: { run_id: "r-1" } };
      },
    });

    const inFlight = handlers.createBackgroundRun(request());
    await expect(handlers.createBackgroundRun(request())).rejects.toMatchObject({ status: 409 });

    release();
    await inFlight;
  });

  it("releases the claim when the handler throws, so a retry executes for real", async () => {
    // Failures are never recorded — pinning a transient 503 for the retention would make a momentary
    // outage permanent for that key.
    let attempt = 0;
    const { handlers, calls } = harness({
      respond: async () => {
        attempt += 1;
        if (attempt === 1) throw SkeinHttpError.conflict("upstream blew up");
        return { kind: "json", status: 200, body: { run_id: "r-2" } };
      },
    });

    await expect(handlers.createBackgroundRun(request())).rejects.toThrow();
    const retried = await handlers.createBackgroundRun(request());

    expect(calls.createBackgroundRun).toBe(2);
    expect(retried).toMatchObject({ body: { run_id: "r-2" } });
  });

  it("releases the claim on a non-2xx response too", async () => {
    const { handlers, calls } = harness({
      respond: async () => ({ kind: "json", status: 503, body: { detail: "busy" } }),
    });

    await handlers.createBackgroundRun(request());
    await handlers.createBackgroundRun(request());

    expect(calls.createBackgroundRun).toBe(2);
  });

  it("still returns the response when recording it fails", async () => {
    // The run was created. Turning a failed *recording* into a 500 would be the worst of both
    // worlds: the caller sees an error, the run exists anyway, and every retry 409s against the
    // orphaned claim until it expires.
    const store = new MemorySkeinStore();
    const inner = {
      createBackgroundRun: async () => ({ kind: "json", status: 200, body: { run_id: "r-1" } }),
    } as unknown as ProtocolHandlers;
    const handlers = createIdempotentHandlers(inner, {
      store: {
        ...store,
        idempotency: {
          ...store.idempotency,
          record: () => Promise.reject(new Error("connection reset")),
        },
      },
      clock: () => new Date(),
      logger: silentLogger,
    });

    const response = await handlers.createBackgroundRun(request());

    expect(response.status).toBe(200);
    // And the claim is released rather than orphaned, so the next retry can execute for real.
    expect(await store.idempotency.get("POST /threads/t-1/runs ", "k-1")).toBeNull();
  });

  it("scopes records by principal, so one caller's key cannot replay another's response", async () => {
    // The security case. Both callers send `k-1`; each must get their own run.
    const seen: string[] = [];
    let next = 0;
    const { handlers, calls } = harness({
      respond: async () => ({ kind: "json", status: 200, body: { run_id: `r-${(next += 1)}` } }),
      overrides: {
        principalFor: async (req) => {
          const who = req.headers["x-principal"];
          if (who) seen.push(who);
          return who;
        },
      },
    });

    const alice = await handlers.createBackgroundRun(
      request({ headers: { "idempotency-key": "k-1", "x-principal": "alice" } }),
    );
    const bob = await handlers.createBackgroundRun(
      request({ headers: { "idempotency-key": "k-1", "x-principal": "bob" } }),
    );

    expect(calls.createBackgroundRun).toBe(2);
    expect(alice).not.toMatchObject({
      body: { run_id: (bob as { body: { run_id: string } }).body.run_id },
    });
    expect(seen).toEqual(["alice", "bob"]);
  });

  it("records the thread from Content-Location, so a thread delete can erase it", async () => {
    // Read from the header rather than the body, because `POST /runs/wait` answers with the graph's
    // final state — the very payload this makes erasable — and that body names no thread.
    const { handlers, store } = harness({
      respond: async () => ({
        kind: "json",
        status: 200,
        body: { values: { messages: ["secret"] } },
        headers: { "content-location": "/threads/t-1/runs/r-1" },
      }),
    });

    await handlers.createBackgroundRun(request());

    const record = await store.idempotency.get("POST /threads/t-1/runs ", "k-1");
    expect(record?.thread_id).toBe("t-1");
    expect(await store.idempotency.deleteByThread("t-1")).toBe(1);
  });

  it("leaves thread_id unset on a batch, which has no single thread to erase", async () => {
    const { handlers, store } = harness({
      respond: async () => ({ kind: "json", status: 200, body: [{ run_id: "r-1" }] }),
    });

    await handlers.createRunBatch(request());

    expect(
      (await store.idempotency.get("POST /threads/t-1/runs ", "k-1"))?.thread_id,
    ).toBeUndefined();
  });

  it("rejects the header on a streaming create with 422 rather than ignoring it", async () => {
    // An SSE response is an AsyncIterable — there is no body to record. Silently dropping the header
    // would leave a caller believing their retries are deduplicated while every one starts a run.
    const { handlers, calls } = harness();

    await expect(handlers.createStreamRun(request())).rejects.toMatchObject({ status: 422 });
    expect(calls.createStreamRun).toBe(0);
  });

  it("leaves a streaming create untouched when no key is sent", async () => {
    const { handlers, calls } = harness();

    const response = await handlers.createStreamRun(request({ headers: {} }));

    expect(response.kind).toBe("sse");
    expect(calls.createStreamRun).toBe(1);
  });

  it("treats an empty header value as absent", async () => {
    const { handlers, calls } = harness();

    await handlers.createBackgroundRun(request({ headers: { "idempotency-key": "" } }));
    await handlers.createBackgroundRun(request({ headers: { "idempotency-key": "" } }));

    expect(calls.createBackgroundRun).toBe(2);
  });

  it("stops replaying once the retention has passed", async () => {
    const { handlers, calls } = harness({ overrides: { retentionHours: 40 / 3_600_000 } });

    await handlers.createBackgroundRun(request());
    await new Promise((resolve) => setTimeout(resolve, 120));
    await handlers.createBackgroundRun(request());

    expect(calls.createBackgroundRun).toBe(2);
  });

  it("lets a retry take over a claim whose request died mid-flight", async () => {
    // A SIGKILLed instance must not 409 its key until the full retention expires.
    const { handlers, calls, store } = harness({ overrides: { inFlightMinutes: 40 / 60_000 } });
    await store.idempotency.claim({
      key: "k-1",
      scope: "POST /threads/t-1/runs ",
      fingerprint: "whatever",
      claim_id: "dead",
      now: new Date().toISOString(),
      expires_at: new Date(Date.now() + 40).toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    const response = await handlers.createBackgroundRun(request());

    expect(calls.createBackgroundRun).toBe(1);
    expect(response.status).toBe(200);
  });
});
