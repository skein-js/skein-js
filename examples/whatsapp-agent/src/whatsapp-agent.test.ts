// The whole integration, end to end, offline.
//
// Every case here is a failure that shipped broken in real integrations before skein handled it, and
// each one is silent in the wild: a double reply, a lost reply, a question nobody was asked.

import { createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProtocolRuntime } from "@skein-js/server-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const configPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "langgraph.json");
const url = "http://127.0.0.1:2024/channels/twilio";

type Runtime = Awaited<ReturnType<typeof resolveProtocolRuntime>>;
let runtime: Runtime;

beforeEach(async () => {
  runtime = await resolveProtocolRuntime({ config: configPath });
});
afterEach(async () => {
  await runtime.runtime.worker.stop();
});

/** A correctly signed Twilio-shaped delivery. */
function twilioRequest(params: Record<string, string>) {
  const body = new URLSearchParams(params).toString();
  const signable = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .reduce((acc, [key, value]) => acc + key + value, url);
  const signature = createHmac("sha1", "test_auth_token").update(signable, "utf8").digest("base64");
  return {
    method: "POST",
    url,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body,
    params: {},
    query: {},
  };
}

const send = (params: Record<string, string>) =>
  runtime.runtime.handlers.handleInboundEvent(twilioRequest(params));

/** Wait until a predicate holds, so tests do not assert on timing. */
async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const threadsOf = () => runtime.runtime.service.threads.search({});

describe("an inbound WhatsApp message", () => {
  it("is accepted, and starts a run", async () => {
    const response = await send({
      From: "whatsapp:+254712345678",
      Body: "hello",
      MessageSid: "SM-1",
    });

    expect(response.status).toBe(202);
    expect(await threadsOf()).toHaveLength(1);
  });

  it("is refused when the signature is forged", async () => {
    const forged = twilioRequest({ From: "whatsapp:+254", Body: "hi", MessageSid: "SM-x" });
    forged.headers["x-twilio-signature"] = "not-the-signature";

    const response = await runtime.runtime.handlers.handleInboundEvent(forged);

    expect(response.status).toBe(401);
    expect(await threadsOf()).toHaveLength(0);
  });

  it("keeps one conversation per number", async () => {
    await send({ From: "whatsapp:+254712345678", Body: "one", MessageSid: "SM-1" });
    await send({ From: "whatsapp:+254712345678", Body: "two", MessageSid: "SM-2" });
    await send({ From: "whatsapp:+254700000000", Body: "other", MessageSid: "SM-3" });

    expect(await threadsOf()).toHaveLength(2);
  });

  it("never puts the phone number in the thread id, but keeps it findable", async () => {
    // Hashed, so the number does not reach a primary key, an index or a backup — and searchable, so
    // an erasure request can still find every thread for a customer.
    await send({ From: "whatsapp:+254712345678", Body: "hello", MessageSid: "SM-1" });

    const [thread] = await threadsOf();
    expect(thread!.thread_id).not.toContain("254712345678");
    expect(
      await runtime.runtime.service.threads.search({
        metadata: { skein_thread_key: "whatsapp:+254712345678" },
      }),
    ).toHaveLength(1);
  });

  it("ignores a delivery receipt without starting a run", async () => {
    const response = await send({ From: "whatsapp:+254712345678", MessageSid: "SM-1", Body: "" });

    expect(response.status).toBe(204);
    expect(await threadsOf()).toHaveLength(0);
  });
});

describe("a retried delivery", () => {
  it("produces exactly one run", async () => {
    // Twilio retries on any non-2xx and on a timeout. Without dedup the customer gets two answers.
    const first = await send({ From: "whatsapp:+254712345678", Body: "hi", MessageSid: "SM-1" });
    const second = await send({ From: "whatsapp:+254712345678", Body: "hi", MessageSid: "SM-1" });

    expect(second).toEqual(first);
    const [thread] = await threadsOf();
    expect(await runtime.runtime.service.runs.listByThread(thread!.thread_id)).toHaveLength(1);
  });
});

describe("human-in-the-loop over an asynchronous channel", () => {
  it("parks on a question, then resumes on the reply hours later", async () => {
    // The capability this whole feature exists for. `interrupted` is a *terminal* run status, so
    // nothing else in the system stops the second message from starting a fresh run and discarding
    // the pending question.
    await send({ From: "whatsapp:+254712345678", Body: "I want a refund", MessageSid: "SM-1" });

    const [thread] = await threadsOf();
    await until(
      async () =>
        (await runtime.runtime.service.threads.get(thread!.thread_id)).status === "interrupted",
      "the thread to park on its question",
    );

    // The customer answers. Same route, same channel, no notion of "this is a follow-up".
    await send({ From: "whatsapp:+254712345678", Body: "yes", MessageSid: "SM-2" });

    await until(
      async () => (await runtime.runtime.service.threads.get(thread!.thread_id)).status === "idle",
      "the resumed run to finish",
    );
    const state = await runtime.runtime.service.threads.get(thread!.thread_id);
    expect(JSON.stringify(state.values)).toMatch(/being processed/);
  });
});

describe("memory", () => {
  it("greets a returning customer, across separate conversations", async () => {
    // Two kinds of memory: `messages` lives on the thread's checkpoint, while this rides the
    // long-term store, so it survives a thread being archived entirely.
    await send({ From: "whatsapp:+254712345678", Body: "first", MessageSid: "SM-1" });
    const [thread] = await threadsOf();
    await until(
      async () => (await runtime.runtime.service.threads.get(thread!.thread_id)).status === "idle",
      "the first run to finish",
    );

    await send({ From: "whatsapp:+254712345678", Body: "second", MessageSid: "SM-2" });
    await until(async () => {
      const state = await runtime.runtime.service.threads.get(thread!.thread_id);
      return JSON.stringify(state.values).includes("Welcome back");
    }, "the returning-customer greeting");
  });
});
