// The pipeline, end to end over fakes.
//
// The security cases at the bottom are the load-bearing ones. This route is exempt from
// `createAuthorizingHandlers` — it authenticates by provider signature rather than by bearer token —
// and once a route is exempt, *nothing type-checks that it authorizes at all*. `ROUTE_AUTHZ` being
// exhaustive gives an entry, not a call site. These tests are the call site's only guard.

import { MemorySkeinStore } from "@skein-js/storage-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Channel, ChannelOutcome } from "../channel/channel.js";
import type { RegisteredChannel } from "../channel/registry.js";
import { threadIdForChannelKey } from "../channel/thread-id.js";

import { handleInboundEvent, type PipelineDeps } from "./handle-event.js";

const rawBody = "From=whatsapp%3A%2B254712345678&Body=hi&MessageSid=SM-1";

const request = {
  method: "POST",
  url: "http://127.0.0.1:2024/channels/twilio",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  text: rawBody,
};

function channelOf(overrides: Partial<Channel> = {}): Channel {
  return {
    name: "twilio",
    verify: () => ({ identity: "channel:twilio:+254712345678" }),
    parseEvent: (): ChannelOutcome => ({
      kind: "event",
      event: {
        threadKey: "whatsapp:+254712345678",
        idempotencyKey: "SM-1",
        input: { messages: [{ role: "human", content: "hi" }] },
      },
    }),
    ...overrides,
  };
}

function registeredOf(channel: Channel, config: Partial<RegisteredChannel["config"]> = {}) {
  return { channel, config: { assistant: "support", ...config } };
}

function depsOf(overrides: Partial<PipelineDeps> = {}) {
  const store = new MemorySkeinStore();
  const threads = new Map<string, "idle" | "busy" | "interrupted" | "error">();
  const created: Parameters<PipelineDeps["createRun"]>[0][] = [];
  const deps: PipelineDeps = {
    idempotency: store.idempotency,
    clock: () => new Date("2026-01-01T00:00:00.000Z"),
    logger: { warn: vi.fn() },
    authorize: async () => undefined,
    ensureThread: async (threadId) => {
      if (!threads.has(threadId)) threads.set(threadId, "idle");
    },
    threadStatus: async (threadId) => threads.get(threadId) ?? null,
    createRun: async (input) => {
      created.push(input);
      return { runId: `run-${created.length}` };
    },
    ...overrides,
  };
  return { deps, created, threads };
}

describe("the inbound pipeline", () => {
  let harness: ReturnType<typeof depsOf>;
  beforeEach(() => {
    harness = depsOf();
  });

  it("verifies before parsing, and 401s a forged request", async () => {
    // Ordering matters, not just the outcome: a signature covers bytes and a URL, so anything that
    // parses first makes verification impossible rather than merely inconvenient.
    const parseEvent = vi.fn();
    const response = await handleInboundEvent(
      registeredOf(channelOf({ verify: () => false, parseEvent })),
      request,
      harness.deps,
    );

    expect(response.status).toBe(401);
    expect(parseEvent).not.toHaveBeenCalled();
    expect(harness.created).toHaveLength(0);
  });

  it("acknowledges an ignore without creating a run", async () => {
    // Slack redelivers your own bot's messages. A channel that cannot say "not interesting" cheaply
    // ends up answering itself in a loop.
    const response = await handleInboundEvent(
      registeredOf(channelOf({ parseEvent: () => ({ kind: "ignore" }) })),
      request,
      harness.deps,
    );

    expect(response.status).toBe(204);
    expect(harness.created).toHaveLength(0);
  });

  it("returns a channel's direct response verbatim", async () => {
    // Slack's very first request is a `url_verification` challenge that must echo a value back. A 204
    // expresses nothing that could satisfy it.
    const response = await handleInboundEvent(
      registeredOf(
        channelOf({
          parseEvent: () => ({ kind: "respond", status: 200, body: { challenge: "abc" } }),
        }),
      ),
      request,
      harness.deps,
    );

    expect(response).toMatchObject({ status: 200, body: { challenge: "abc" } });
    expect(harness.created).toHaveLength(0);
  });

  it("acknowledges after enqueueing, not after the run finishes", async () => {
    // Slack gives you three seconds before it retries and shows the user an error. The ack cannot
    // wait on the graph.
    const response = await handleInboundEvent(registeredOf(channelOf()), request, harness.deps);

    expect(response).toMatchObject({ status: 202, body: { run_id: "run-1" } });
  });

  it("lands the event on a thread derived from the external key", async () => {
    await handleInboundEvent(registeredOf(channelOf()), request, harness.deps);

    expect(harness.created[0]?.threadId).toBe(
      threadIdForChannelKey("twilio", "whatsapp:+254712345678"),
    );
  });

  it("runs the graph the deployment bound, not one the channel picked", async () => {
    // A community adapter has no business choosing your graph unless you listed it.
    const channel = channelOf({
      parseEvent: () => ({
        kind: "event",
        event: { threadKey: "k", input: {}, assistantId: "triage" },
      }),
    });

    await expect(
      handleInboundEvent(registeredOf(channel), request, harness.deps),
    ).rejects.toMatchObject({ status: 403, code: "assistant_not_allowed" });
  });

  it("allows routing the deployment opted into", async () => {
    const channel = channelOf({
      parseEvent: () => ({
        kind: "event",
        event: { threadKey: "k", input: {}, assistantId: "triage" },
      }),
    });

    await handleInboundEvent(
      registeredOf(channel, { allowedAssistants: ["triage"] }),
      request,
      harness.deps,
    );

    expect(harness.created[0]?.assistantId).toBe("triage");
  });
});

describe("retries", () => {
  it("replays the first answer instead of starting a second run", async () => {
    // The provider resends the identical body; exactly one run must exist afterwards.
    const harness = depsOf();
    const registered = registeredOf(channelOf());

    const first = await handleInboundEvent(registered, request, harness.deps);
    const second = await handleInboundEvent(registered, request, harness.deps);

    expect(second).toEqual(first);
    expect(harness.created).toHaveLength(1);
  });

  it("is not refused when the retry correctly resumes instead of starting", async () => {
    // The bug this ordering exists to dissolve. `Idempotency-Key` fingerprints the request body, and
    // a webhook derives its body from mutable server state — so a retry that re-reads the thread and
    // builds a *resume* instead of a *start* sends the same key with a different body, and is refused
    // for having done the right thing. Claiming over the raw inbound bytes makes the branch
    // irrelevant to the fingerprint.
    const harness = depsOf();
    const registered = registeredOf(channelOf());

    await handleInboundEvent(registered, request, harness.deps);
    // The thread parks on an interrupt between deliveries, so the retry would derive a resume.
    harness.threads.set(threadIdForChannelKey("twilio", "whatsapp:+254712345678"), "interrupted");

    const retry = await handleInboundEvent(registered, request, harness.deps);

    expect(retry.status).toBe(202);
    expect(harness.created).toHaveLength(1);
  });

  it("does not record a failure, so a transient outage is not made permanent", async () => {
    // Pinning a 503 for the retention window would replay it for every retry for 24 hours.
    const harness = depsOf({
      createRun: vi.fn().mockRejectedValue(new Error("database is down")),
    });
    const registered = registeredOf(channelOf());

    await expect(handleInboundEvent(registered, request, harness.deps)).rejects.toThrow(
      "database is down",
    );

    // The key is free again, so the next delivery genuinely retries.
    const recovered = depsOf({ idempotency: harness.deps.idempotency });
    expect((await handleInboundEvent(registered, request, recovered.deps)).status).toBe(202);
  });

  it("refuses a reused id carrying different bytes, rather than replaying", async () => {
    // Found by negative-checking the replay test. Replaying here would answer *this* event with a
    // different event's response — the provider is told its message was handled, and the message is
    // silently dropped. That is worse than any error, so it is a permanent 422 the provider must not
    // retry, distinct from the transient 409 above.
    const harness = depsOf();
    const registered = registeredOf(channelOf());

    await handleInboundEvent(registered, request, harness.deps);
    const different = {
      ...request,
      text: "From=whatsapp%3A%2B254712345678&Body=DIFFERENT&MessageSid=SM-1",
    };

    const response = await handleInboundEvent(registered, different, harness.deps);

    expect(response).toMatchObject({ status: 422, body: { code: "idempotency_key_reused" } });
    expect(harness.created).toHaveLength(1);
  });

  it("protects nothing when the channel supplies no event id", async () => {
    // Honest rather than convenient: without a provider-assigned id, nothing identifies two
    // deliveries as the same event, and deriving one from the body would collide on a customer
    // legitimately sending "yes" twice.
    const harness = depsOf();
    const channel = channelOf({
      parseEvent: () => ({ kind: "event", event: { threadKey: "k", input: {} } }),
    });

    await handleInboundEvent(registeredOf(channel), request, harness.deps);
    await handleInboundEvent(registeredOf(channel), request, harness.deps);

    expect(harness.created).toHaveLength(2);
  });
});

describe("authorization — the guard nothing else enforces", () => {
  it("authorizes against the handler table's own row", async () => {
    // Restating the pair here instead of reading it would let the two drift apart silently, and this
    // route is exempt from the wrapper that would otherwise keep them together.
    const authorize = vi.fn().mockResolvedValue(undefined);

    await handleInboundEvent(registeredOf(channelOf()), request, depsOf({ authorize }).deps);

    expect(authorize).toHaveBeenCalledWith(expect.anything(), {
      resource: "threads",
      action: "create_run",
    });
  });

  it("creates no run when the deployment's Auth block denies", async () => {
    // The whole reason `verify` returns a principal rather than a boolean: an inbound event flows
    // through the deployment's ordinary authorization, and a denial has to stop it dead.
    const harness = depsOf({
      authorize: vi.fn().mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 })),
    });

    await expect(
      handleInboundEvent(registeredOf(channelOf()), request, harness.deps),
    ).rejects.toMatchObject({ status: 403 });
    expect(harness.created).toHaveLength(0);
  });

  it("cannot be authenticated by a forged x-auth-scheme header", async () => {
    // `resolveAuthContext` admits `x-auth-scheme: langsmith` without authenticating, which on a
    // run-creating route is one forged header away from free run creation. This route never reaches
    // that code path — the channel's own `verify` is the only way in — so the header is inert.
    const harness = depsOf();
    const forged = { ...request, headers: { ...request.headers, "x-auth-scheme": "langsmith" } };

    const response = await handleInboundEvent(
      registeredOf(channelOf({ verify: () => false })),
      forged,
      harness.deps,
    );

    expect(response.status).toBe(401);
    expect(harness.created).toHaveLength(0);
  });

  it("passes the verified principal on, so ownership filters can scope the thread", async () => {
    const authorize = vi.fn().mockResolvedValue(undefined);

    await handleInboundEvent(registeredOf(channelOf()), request, depsOf({ authorize }).deps);

    expect(authorize.mock.calls[0]?.[0]).toEqual({ identity: "channel:twilio:+254712345678" });
  });
});
