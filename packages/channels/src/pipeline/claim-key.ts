// Making a provider's retries free.

import { createHash } from "node:crypto";

import type { ProtocolResponse } from "@skein-js/agent-protocol";
import type { IdempotencyRepo } from "@skein-js/core";

import type { ChannelPrincipal, InboundEvent } from "../channel/channel.js";

/** What claiming needs from the server. */
export interface IdempotencyDeps {
  idempotency?: IdempotencyRepo;
  /** How long an unfinished claim blocks a retry. */
  inFlightMs?: number;
  /** How long a recorded answer stays replayable. */
  retentionMs?: number;
  clock(): Date;
}

export interface ClaimInput {
  channelName: string;
  principal: ChannelPrincipal;
  event: InboundEvent;
  /** The provider's own bytes — see `fingerprintOf`. */
  rawBody: string;
}

export type ClaimOutcome =
  | {
      kind: "claimed";
      record(response: ProtocolResponse, ids: { runId: string; threadId: string }): Promise<void>;
      release(): Promise<void>;
    }
  /** A previous delivery of this same event already answered. Send that answer again. */
  | { kind: "replay"; response: ProtocolResponse }
  /** A concurrent delivery of this event is still in flight. */
  | { kind: "in_flight" }
  /** The same id arrived carrying *different* bytes — two different events, one id. */
  | { kind: "reused" };

const DEFAULT_IN_FLIGHT_MS = 15 * 60 * 1000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Claim this event's key, or report who already holds it.
 *
 * **Fingerprinted over the raw inbound bytes**, not over anything derived. A provider resends the
 * identical body on a retry, so that value is stable across attempts — whereas the run body we go on
 * to build is derived from mutable server state, and legitimately differs between a first delivery
 * (which starts a run) and a retry (which correctly resumes an interrupt instead). Fingerprinting the
 * derived body would refuse the retry precisely *because* it did the right thing.
 *
 * A channel that supplies no `idempotencyKey` gets no protection, which is honest rather than
 * convenient: without a provider-assigned event id there is nothing that identifies two deliveries as
 * the same event, and inventing one from the body would collide on two genuinely identical messages —
 * a customer sending "yes" twice is not a retry.
 */
export async function claimEventKey(
  input: ClaimInput,
  deps: IdempotencyDeps,
): Promise<ClaimOutcome> {
  const key = input.event.idempotencyKey;
  if (!key || !deps.idempotency) return unprotected();
  const repo = deps.idempotency;

  // The principal is part of the scope, so two tenants sending a provider event id that happens to
  // collide cannot replay each other's answers.
  const scope = `POST /channels/${input.channelName} ${input.principal.identity}`;
  const claimId = createHash("sha256")
    .update(`${scope}:${key}:${input.rawBody}`)
    .digest("hex")
    .slice(0, 32);
  const now = deps.clock();
  const fingerprint = fingerprintOf(input.rawBody);

  const result = await repo.claim({
    key,
    scope,
    fingerprint,
    claim_id: claimId,
    now: now.toISOString(),
    expires_at: new Date(now.getTime() + (deps.inFlightMs ?? DEFAULT_IN_FLIGHT_MS)).toISOString(),
  });

  if (!result.claimed) {
    const incumbent = result.record;
    // Same id, different bytes. Replaying here would answer *this* event with a different event's
    // response, which is worse than any error: the provider is told its message was handled, and the
    // message is silently dropped. A provider reusing an event id for different content is a bug on
    // their side or a forgery on someone else's, and neither should be answered with a stale success.
    if (incumbent.fingerprint !== fingerprint) return { kind: "reused" };
    if (incumbent.status === "done" && incumbent.response) {
      const recorded = incumbent.response as { status?: number; body?: unknown };
      return {
        kind: "replay",
        response: { kind: "json", status: recorded.status ?? 202, body: recorded.body },
      };
    }
    return { kind: "in_flight" };
  }

  return {
    kind: "claimed",
    record: async (response, ids) => {
      await repo.record(scope, key, claimId, {
        status: response.kind === "json" ? response.status : 202,
        body: response.kind === "json" ? response.body : undefined,
        expires_at: new Date(
          deps.clock().getTime() + (deps.retentionMs ?? DEFAULT_RETENTION_MS),
        ).toISOString(),
        // Both ids are supplied so the record is erased with the thread it belongs to. Without them a
        // body derived from a phone number would outlive the conversation's deletion by the whole
        // retention window, which is the opposite of what erasing a thread is for.
        run_id: ids.runId,
        thread_id: ids.threadId,
      });
    },
    release: () => repo.release(scope, key, claimId),
  };
}

/** No key, or no store that records them: proceed, and let the provider's retry create a second run. */
function unprotected(): ClaimOutcome {
  return { kind: "claimed", record: async () => {}, release: async () => {} };
}

/** A stable digest of what the provider actually sent. */
function fingerprintOf(rawBody: string): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
