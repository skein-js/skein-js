// Getting the answer back out, and the reply target that addresses it.

import { describe, expect, it, vi } from "vitest";

import type { Channel } from "../channel/channel.js";
import type { ChannelRegistry } from "../channel/registry.js";

import { wrapChannelDispatcher } from "./deliver.js";
import {
  isChannelDeliveryUrl,
  parseChannelDeliveryUrl,
  toChannelDeliveryUrl,
} from "./reply-target.js";
import { resolveReply } from "./resolve-reply.js";

const registryOf = (channel: Channel): ChannelRegistry => ({
  names: [channel.name],
  get: (name) =>
    name === channel.name ? { channel, config: { assistant: "support" } } : undefined,
});

describe("the channel reply target", () => {
  it("round-trips whatever the channel put on replyTo", () => {
    // Opaque to skein: a phone number, an issue URL, a Slack channel + thread ts.
    const target = { channelName: "twilio", replyTo: { to: "whatsapp:+254", sid: "SM-1" } };

    expect(parseChannelDeliveryUrl(toChannelDeliveryUrl(target))).toEqual(target);
  });

  it("survives a channel name that needs escaping", () => {
    const target = { channelName: "a/b c", replyTo: "x" };

    expect(parseChannelDeliveryUrl(toChannelDeliveryUrl(target))?.channelName).toBe("a/b c");
  });

  it("leaves an ordinary webhook alone", () => {
    // The wrapper must be invisible to every deployment that has no channels.
    expect(parseChannelDeliveryUrl("https://example.test/hook")).toBeUndefined();
    expect(isChannelDeliveryUrl("https://example.test/hook")).toBe(false);
  });

  it("treats a malformed target as not-a-channel rather than swallowing it", () => {
    // It then fails visibly on the ordinary webhook path instead of being dropped here.
    expect(parseChannelDeliveryUrl("skein+channel://twilio/!!!not-base64!!!")).toBeUndefined();
  });
});

describe("wrapChannelDispatcher", () => {
  const settled = {
    run_id: "run-1",
    thread_id: "thread-1",
    status: "success" as const,
    values: { messages: [{ type: "ai", content: "Your order ships Tuesday." }] },
  };

  it("passes an ordinary webhook straight through", async () => {
    const inner = vi.fn().mockResolvedValue(undefined);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatch = wrapChannelDispatcher({
      registry: registryOf({ name: "twilio", verify: vi.fn(), parseEvent: vi.fn(), deliver }),
      inner,
      logger: { warn: vi.fn() },
    });

    await dispatch("https://example.test/hook", settled);

    expect(inner).toHaveBeenCalledWith("https://example.test/hook", settled, undefined);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("routes a channel target to the channel, with the reply resolved", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const dispatch = wrapChannelDispatcher({
      registry: registryOf({ name: "twilio", verify: vi.fn(), parseEvent: vi.fn(), deliver }),
      inner: vi.fn(),
      logger: { warn: vi.fn() },
    });

    await dispatch(
      toChannelDeliveryUrl({ channelName: "twilio", replyTo: "whatsapp:+254" }),
      settled,
    );

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", reply: "Your order ships Tuesday." }),
      "whatsapp:+254",
    );
  });

  it("throws when a channel fails, so the outbox retries it", async () => {
    // The whole reason `deliver` runs *inside* the dispatcher: a failed send is an attempt the outbox
    // already knows how to back off, record and replay.
    const dispatch = wrapChannelDispatcher({
      registry: registryOf({
        name: "twilio",
        verify: vi.fn(),
        parseEvent: vi.fn(),
        deliver: vi.fn().mockRejectedValue(new Error("Twilio is down")),
      }),
      inner: vi.fn(),
      logger: { warn: vi.fn() },
    });

    await expect(
      dispatch(toChannelDeliveryUrl({ channelName: "twilio", replyTo: "x" }), settled),
    ).rejects.toThrow("Twilio is down");
  });

  it("fails loudly when the channel is gone, rather than dropping the answer", async () => {
    const dispatch = wrapChannelDispatcher({
      registry: { names: [], get: () => undefined },
      inner: vi.fn(),
      logger: { warn: vi.fn() },
    });

    await expect(
      dispatch(toChannelDeliveryUrl({ channelName: "twilio", replyTo: "x" }), settled),
    ).rejects.toThrow(/no channel named "twilio" is configured any more/i);
  });

  it("warns when an interrupt renders no question", async () => {
    // A successful run that says nothing is ordinary. An *interrupt* that says nothing strands the
    // conversation forever: the run waits for an answer to a question nobody was asked, and no
    // timeout will ever fire.
    const warn = vi.fn();
    const dispatch = wrapChannelDispatcher({
      registry: registryOf({
        name: "twilio",
        verify: vi.fn(),
        parseEvent: vi.fn(),
        deliver: vi.fn().mockResolvedValue(undefined),
      }),
      inner: vi.fn(),
      logger: { warn },
    });

    await dispatch(toChannelDeliveryUrl({ channelName: "twilio", replyTo: "x" }), {
      run_id: "run-2",
      status: "interrupted",
      interrupts: {},
    });

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cannot proceed/));
  });

  it("does not warn when a successful run simply has nothing to say", async () => {
    const warn = vi.fn();
    const dispatch = wrapChannelDispatcher({
      registry: registryOf({
        name: "twilio",
        verify: vi.fn(),
        parseEvent: vi.fn(),
        deliver: vi.fn().mockResolvedValue(undefined),
      }),
      inner: vi.fn(),
      logger: { warn },
    });

    await dispatch(toChannelDeliveryUrl({ channelName: "twilio", replyTo: "x" }), {
      run_id: "run-3",
      status: "success",
      values: {},
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("resolveReply", () => {
  it("prefers what the graph declared", () => {
    // Explicit beats inferred, and it is the only option for a graph whose state is not message-shaped.
    expect(
      resolveReply({
        status: "success",
        reply: "declared",
        values: { messages: [{ type: "ai", content: "inferred" }] },
      }),
    ).toBe("declared");
  });

  it("falls back to the last AI message, so an ordinary chat agent needs no changes", () => {
    expect(
      resolveReply({
        status: "success",
        values: {
          messages: [
            { type: "ai", content: "first" },
            { type: "human", content: "question" },
            { type: "ai", content: "last" },
          ],
        },
      }),
    ).toBe("last");
  });

  it("reads a plain object's `role` as well as a LangChain message's `type`", () => {
    // A receiver should not have to care which shape the graph happened to produce.
    expect(
      resolveReply({
        status: "success",
        values: { messages: [{ role: "assistant", content: "x" }] },
      }),
    ).toBe("x");
  });

  it("renders the question for an interrupted run", () => {
    expect(
      resolveReply({
        status: "interrupted",
        interrupts: { "task-1": [{ value: "Refund £40?" }] },
      }),
    ).toBe("Refund £40?");
  });

  it("says nothing for a failed run", () => {
    // Whether an end user is told "something went wrong" is a product decision, and leaking a failed
    // run's internals to a phone number is the wrong default.
    expect(
      resolveReply({ status: "error", values: { messages: [{ type: "ai", content: "x" }] } }),
    ).toBeUndefined();
  });
});
