import { readDeclaredReply } from "@skein-js/agent-protocol";
import { describe, expect, it, vi } from "vitest";

import type { Channel, ChannelOutcome, InboundRequest } from "../channel/channel.js";

import {
  composeRoutedChannel,
  declareChannelDestinationDelivery,
  type ChannelDestinationDelivery,
  type ChannelDestinationIntent,
} from "./routed-channel.js";

const request = {} as InboundRequest;

function source(outcome: ChannelOutcome): Pick<Channel, "name" | "verify" | "parseEvent"> {
  return {
    name: "email",
    verify: () => ({ identity: "source:email" }),
    parseEvent: () => outcome,
  };
}

function declaredReply(intent: ChannelDestinationIntent): unknown {
  const writer = vi.fn();
  declareChannelDestinationDelivery(writer, intent);
  return readDeclaredReply(writer.mock.calls[0]![0])!.reply;
}

const runOutcome = {
  runId: "run-1",
  threadId: "thread-1",
  status: "success" as const,
};

describe("routed channels", () => {
  it("exports a source event unchanged except for arming an absent reply target", async () => {
    const event = {
      threadKey: "external-1",
      threadId: "thread-1",
      input: { message: "hello" },
      resumeWith: "approved",
      idempotencyKey: "event-1",
      assistantId: "triage",
      metadata: { tenant: "acme" },
      onExisting: "enqueue" as const,
    };
    const channel = composeRoutedChannel(source({ kind: "event", event }), new Map());

    expect(await channel.verify(request)).toEqual({ identity: "source:email" });
    expect(await channel.parseEvent(request)).toEqual({
      kind: "event",
      event: { ...event, replyTo: null },
    });
  });

  it("preserves an existing reply target and passes ignore/respond through", async () => {
    const event = { threadKey: "one", input: {}, replyTo: { provider: "original" } };
    expect(
      await composeRoutedChannel(source({ kind: "event", event }), new Map()).parseEvent(request),
    ).toEqual({ kind: "event", event });
    expect(
      await composeRoutedChannel(source({ kind: "ignore" }), new Map()).parseEvent(request),
    ).toEqual({ kind: "ignore" });
    expect(
      await composeRoutedChannel(
        source({ kind: "respond", status: 200, body: "ok" }),
        new Map(),
      ).parseEvent(request),
    ).toEqual({ kind: "respond", status: 200, body: "ok" });
  });

  it("dispatches a valid declared destination with run context", async () => {
    const delivery = vi.fn<(value: ChannelDestinationDelivery) => Promise<void>>(async () => {});
    const channel = composeRoutedChannel(
      source({ kind: "ignore" }),
      new Map([["whatsapp", delivery]]),
    );
    const reply = declaredReply({
      destination: "whatsapp",
      target: { to: "+254700000001" },
      payload: { body: "Approved" },
    });

    await channel.deliver!(
      { ...runOutcome, reply, interrupts: { task: [{ id: "approval", value: "Approve?" }] } },
      null,
    );

    expect(delivery).toHaveBeenCalledWith({
      ...runOutcome,
      interrupts: { task: [{ id: "approval", value: "Approve?" }] },
      target: { to: "+254700000001" },
      payload: { body: "Approved" },
    });
  });

  it("ignores unmarked inferred replies", async () => {
    const delivery = vi.fn(async () => {});
    const channel = composeRoutedChannel(
      source({ kind: "ignore" }),
      new Map([["email", delivery]]),
    );

    await channel.deliver!({ ...runOutcome, reply: "inferred interrupt" }, null);
    await channel.deliver!(
      { ...runOutcome, reply: { role: "assistant", content: "inferred message" } },
      null,
    );

    expect(delivery).not.toHaveBeenCalled();
  });

  it("reads a literal stored v1 declaration", async () => {
    const delivery = vi.fn(async () => {});
    const channel = composeRoutedChannel(
      source({ kind: "ignore" }),
      new Map([["email", delivery]]),
    );

    await channel.deliver!(
      {
        ...runOutcome,
        reply: {
          $skein_channel_destination: {
            version: 1,
            intent: { destination: "email", target: null, payload: { body: "stored" } },
          },
        },
      },
      null,
    );

    expect(delivery).toHaveBeenCalledWith(
      expect.objectContaining({ target: null, payload: { body: "stored" } }),
    );
  });

  it("rejects malformed, unknown-version and unknown-destination declarations", async () => {
    const channel = composeRoutedChannel(source({ kind: "ignore" }), new Map());
    await expect(
      channel.deliver!(
        { ...runOutcome, reply: { $skein_channel_destination: { version: 2, intent: {} } } },
        null,
      ),
    ).rejects.toThrow();
    await expect(
      channel.deliver!(
        {
          ...runOutcome,
          reply: declaredReply({ destination: "missing", target: null, payload: null }),
        },
        null,
      ),
    ).rejects.toThrow(/No channel destination named "missing"/);
  });

  it("validates strict JSON intent before consulting the writer", () => {
    expect(() =>
      declareChannelDestinationDelivery(undefined, {
        destination: "email",
        target: null,
        payload: 1n,
      }),
    ).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() =>
      declareChannelDestinationDelivery(undefined, {
        destination: "email",
        target: null,
        payload: cyclic,
      }),
    ).toThrow();
    expect(() =>
      declareChannelDestinationDelivery(undefined, {
        destination: "email",
        target: undefined,
        payload: null,
      }),
    ).toThrow();
    expect(() =>
      declareChannelDestinationDelivery(undefined, {
        destination: "email",
        target: null,
        payload: null,
        extra: true,
      } as ChannelDestinationIntent),
    ).toThrow();
    expect(() =>
      declareChannelDestinationDelivery(undefined, {
        destination: "email",
        target: null,
        payload: new Array(1),
      }),
    ).toThrow();
  });

  it("snapshots a valid intent before handing it to the writer", () => {
    const target = { to: "customer@example.com" };
    const payload: { body: string | bigint } = { body: "Approved" };
    const writer = vi.fn();

    declareChannelDestinationDelivery(writer, { destination: "email", target, payload });
    target.to = "attacker@example.com";
    payload.body = 1n;

    expect(readDeclaredReply(writer.mock.calls[0]![0])?.reply).toEqual({
      $skein_channel_destination: {
        version: 1,
        intent: {
          destination: "email",
          target: { to: "customer@example.com" },
          payload: { body: "Approved" },
        },
      },
    });
  });

  it("snapshots destinations and propagates callback failures", async () => {
    const original = vi.fn(async (_delivery: ChannelDestinationDelivery): Promise<void> => {
      throw new Error("provider unavailable");
    });
    const replacement = vi.fn(async (_delivery: ChannelDestinationDelivery): Promise<void> => {});
    const destinations = new Map<string, (delivery: ChannelDestinationDelivery) => Promise<void>>([
      ["email", original],
    ]);
    const channel = composeRoutedChannel(source({ kind: "ignore" }), destinations);
    destinations.set("email", replacement);
    destinations.set("later", replacement);
    const reply = declaredReply({ destination: "email", target: null, payload: null });

    await expect(channel.deliver!({ ...runOutcome, reply }, null)).rejects.toThrow(
      "provider unavailable",
    );
    expect(replacement).not.toHaveBeenCalled();
    await expect(
      channel.deliver!(
        {
          ...runOutcome,
          reply: declaredReply({ destination: "later", target: null, payload: null }),
        },
        null,
      ),
    ).rejects.toThrow(/No channel destination named "later"/);
  });

  it("rejects invalid source and destination configuration", () => {
    expect(() =>
      composeRoutedChannel({ ...source({ kind: "ignore" }), name: "" }, new Map()),
    ).toThrow(/non-empty name/);
    expect(() =>
      composeRoutedChannel({ ...source({ kind: "ignore" }), name: "   " }, new Map()),
    ).toThrow(/non-empty name/);
    expect(() =>
      composeRoutedChannel(source({ kind: "ignore" }), new Map([["", async () => {}]])),
    ).toThrow(/name cannot be empty/);
    expect(() =>
      composeRoutedChannel(source({ kind: "ignore" }), new Map([["   ", async () => {}]])),
    ).toThrow(/name cannot be empty/);
    expect(() =>
      declareChannelDestinationDelivery(undefined, {
        destination: "   ",
        target: null,
        payload: null,
      }),
    ).toThrow(/name cannot be empty/);
    expect(() =>
      composeRoutedChannel(
        source({ kind: "ignore" }),
        new Map([["email", "not callable"]]) as never,
      ),
    ).toThrow(/must be a function/);
  });
});
