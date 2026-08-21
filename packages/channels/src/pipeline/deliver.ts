// Routing a settled run's answer to the channel that started it.

import type { ChannelRegistry } from "../channel/registry.js";

import { parseChannelDeliveryUrl } from "./reply-target.js";
import { toRunOutcome, type DeliveryPayload } from "./resolve-reply.js";

/** The outbox's dispatcher: given a target and a body, get it there or throw so it is retried. */
export type Dispatcher = (url: string, payload: unknown, attempt?: unknown) => Promise<void>;

export interface WrapDispatcherOptions {
  registry: ChannelRegistry;
  /** Everything that is not a channel target — the deployment's own dispatcher, untouched. */
  inner: Dispatcher;
  logger: { warn(message: string, error?: unknown): void };
}

/**
 * Wrap the delivery dispatcher so a channel's replies ride the outbox.
 *
 * The channel's `deliver` runs **inside** the dispatcher rather than beside it, and that placement is
 * the entire design: everything the outbox already guarantees for a webhook now applies to a WhatsApp
 * reply unchanged. The delivery row is written in the run's finalize transaction, so a crash between
 * "the run succeeded" and "the customer was told" cannot lose the answer. A throw here is a failed
 * attempt, so it is retried with backoff and recorded. And an operator can list and replay it with the
 * same routes they already use.
 *
 * No new storage, no second retry loop, no second crash window — which was the test this had to pass.
 */
export function wrapChannelDispatcher(options: WrapDispatcherOptions): Dispatcher {
  return async (url, payload, attempt) => {
    const target = parseChannelDeliveryUrl(url);
    if (!target) return options.inner(url, payload, attempt);

    const registered = options.registry.get(target.channelName);
    if (!registered) {
      // The channel was configured when the run started and is not now — a config change between the
      // run and its delivery. Nothing to retry into, so fail loudly rather than silently dropping an
      // answer someone is waiting for.
      throw new Error(
        `Cannot deliver: no channel named "${target.channelName}" is configured any more.`,
      );
    }
    const { channel } = registered;
    if (!channel.deliver) {
      // A channel with no `deliver` is legitimate — a GitHub webhook that comments from inside the
      // graph, say — so this is not an error. But a run that *was* given a reply target and cannot use
      // it is a wiring mistake worth naming.
      options.logger.warn(
        `channel "${channel.name}" has no deliver(), so the reply for run ` +
          `${(payload as DeliveryPayload).run_id ?? "?"} was dropped.`,
      );
      return;
    }

    const body = payload as DeliveryPayload;
    const outcome = toRunOutcome(body);

    // An interrupted run that renders nothing is the one case worth a warning. A successful run with
    // no reply is ordinary — plenty of graphs do work without saying anything. But an *interrupt* that
    // says nothing strands the conversation permanently: the run is waiting for an answer to a
    // question nobody was ever asked, and no timeout will ever fire.
    if (outcome.status === "interrupted" && outcome.reply === undefined) {
      options.logger.warn(
        `run ${outcome.runId} is waiting on an interrupt, but nothing rendered a question for ` +
          `channel "${channel.name}" to send. The conversation cannot proceed.`,
      );
    }

    await channel.deliver(outcome, target.replyTo);
  };
}
