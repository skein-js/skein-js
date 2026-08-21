// The pipeline every inbound event goes through, whatever the provider.
//
//   POST /channels/:name
//     -> verify()            principal, or 401
//     -> authorize()         403, or ownership filters
//     -> parseEvent()        ignore -> 204 | respond -> that response | event -> on
//     -> claim the key       BEFORE the branch, over the raw bytes
//     -> resolve the thread  deterministic id, get-or-create
//     -> create the run      with the caller's thread-status precondition
//     -> 2xx                 after enqueueing, never after the run completes
//
// Only `verify` and `parseEvent` are the channel's. Everything between them is identical for every
// integration anyone will ever write, which is the whole reason this exists.

import { ROUTE_AUTHZ, type ProtocolResponse, type RouteAuthz } from "@skein-js/agent-protocol";
import { SkeinHttpError, type AuthContext, type Metadata } from "@skein-js/core";

import type { Channel, ChannelPrincipal, InboundEvent } from "../channel/channel.js";
import {
  buildInboundRequest,
  streamModesFor,
  type RawRequest,
} from "../channel/inbound-request.js";
import type { RegisteredChannel } from "../channel/registry.js";
import { channelThreadMetadata, threadIdForChannelKey } from "../channel/thread-id.js";

import { claimEventKey, type ClaimOutcome, type IdempotencyDeps } from "./claim-key.js";
import { toChannelDeliveryUrl } from "./reply-target.js";
import { resolveRunPlan } from "./resolve-run.js";
import { fanOutRunSignals, type RunFrames } from "./signals.js";

/** What the pipeline needs from the server it is mounted in. */
export interface PipelineDeps extends IdempotencyDeps {
  /** Creates the run. The service, not HTTP — the pipeline runs in-process. */
  createRun(input: {
    threadId: string;
    assistantId: string;
    input?: unknown;
    command?: { resume?: unknown };
    ifThreadStatus?: readonly ("idle" | "busy" | "interrupted" | "error")[];
    multitaskStrategy?: "reject" | "interrupt" | "rollback" | "enqueue";
    streamMode: readonly string[];
    metadata?: Metadata;
    authContext?: AuthContext;
    /**
     * Where the answer goes, as a delivery URL. Server-derived: see `reply-target.ts` for why a
     * caller cannot name this scheme itself.
     */
    webhook?: string;
  }): Promise<{ runId: string }>;
  /** Get-or-create, so a first message and a hundredth take the same path. */
  ensureThread(threadId: string, metadata: Metadata, authContext?: AuthContext): Promise<void>;
  /** The thread's status, for deciding start-versus-resume. `null` when it does not exist yet. */
  threadStatus(threadId: string): Promise<"idle" | "busy" | "interrupted" | "error" | null>;
  /**
   * Authenticate + authorize the principal the channel verified.
   *
   * Injected rather than reached for, because the deployment's `Auth` block lives behind
   * `ProtocolDeps` and this package must not depend on how a server assembled it. Returns the context
   * to run as, or throws the deployment's own 403.
   */
  authorize(principal: ChannelPrincipal, authz: RouteAuthz): Promise<AuthContext | undefined>;
  logger: { warn(message: string, error?: unknown): void };
  clock(): Date;
  /**
   * A run's frames, for channels that asked for progress signals.
   *
   * Optional: a deployment whose bus is unreachable simply gets no indicators, which is a cosmetic
   * loss rather than a broken conversation. The answer still arrives — that rides the outbox.
   */
  runFrames?: RunFrames;
}

/** Handle one inbound request for `registered`. */
export async function handleInboundEvent(
  registered: RegisteredChannel,
  raw: RawRequest,
  deps: PipelineDeps,
): Promise<ProtocolResponse> {
  const { channel, config } = registered;
  const request = buildInboundRequest(raw, {
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
  });

  // 1. Verify, before anything is parsed. A signature covers bytes and a URL; touching either first
  //    is what makes verification impossible rather than merely inconvenient.
  const principal = await channel.verify(request);
  if (principal === false) {
    return { kind: "json", status: 401, body: { message: "Invalid signature." } };
  }

  // 2. Authorize through the deployment's own Auth block. The channel authenticated; what that
  //    identity may *do* is the deployment's question, and it is the same question every run-creating
  //    route asks.
  //
  //    The resource/action pair is *read from* `ROUTE_AUTHZ` rather than restated here. This route is
  //    exempt from `createAuthorizingHandlers` (it authenticates by signature, not by bearer token —
  //    see the note there), so nothing type-checks that it authorizes at all. Passing the table's own
  //    row through is what keeps the two from drifting apart silently.
  const authContext = await deps.authorize(principal, ROUTE_AUTHZ.handleInboundEvent);

  // 3. Parse. The one genuinely provider-specific step.
  const outcome = await channel.parseEvent(request);
  if (outcome.kind === "ignore") return { kind: "json", status: 204, body: undefined };
  if (outcome.kind === "respond") {
    return {
      kind: "json",
      status: outcome.status,
      body: outcome.body,
      ...(outcome.headers ? { headers: outcome.headers } : {}),
    };
  }

  const event = outcome.event;
  const assistantId = resolveAssistant(event, registered);

  // 4. Claim the provider's event id **before** deciding start-versus-resume.
  //
  //    This ordering is the whole trick, and it is what makes `Idempotency-Key` usable here at all.
  //    That header fingerprints the request body, which assumes a client replaying a fixed request. A
  //    webhook derives its body from mutable server state: a retry that correctly re-reads the thread
  //    and builds a *resume* instead of a *start* sends the same key with a different body, and is
  //    refused for being right. Claiming first, over the raw inbound bytes — which the provider
  //    resends unchanged — means the fingerprint is stable no matter which branch we take.
  const claim = await claimEventKey(
    { channelName: channel.name, principal, event, rawBody: request.text() },
    deps,
  );
  if (claim.kind === "replay") return claim.response;
  if (claim.kind === "reused") {
    // Permanent, so the provider must not retry it — distinct from the in-flight 409 below, which it
    // should. Not silently replayed: see the note in `claim-key.ts`.
    return {
      kind: "json",
      status: 422,
      body: {
        message: `Event id "${event.idempotencyKey}" was already used for a different event.`,
        code: "idempotency_key_reused",
      },
    };
  }
  if (claim.kind === "in_flight") {
    // A concurrent retry is still running. 409 rather than a duplicate run — the provider will try
    // again, and by then the first attempt has recorded its answer.
    return {
      kind: "json",
      status: 409,
      body: { message: "This event is already being handled.", code: "idempotency_key_in_flight" },
    };
  }

  try {
    // 5. Resolve the thread. Deterministic, so the same phone number always resumes the same
    //    conversation, and get-or-create so a first message costs no special case.
    const threadId = event.threadId ?? threadIdForChannelKey(channel.name, event.threadKey);
    await deps.ensureThread(
      threadId,
      { ...channelThreadMetadata(channel.name, event.threadKey), ...(event.metadata ?? {}) },
      authContext,
    );

    // 6. Start or resume, per the channel's policy, atomically against the thread's real status.
    //
    //    Retried **once** on a status mismatch, because the guard is doing its job: the thread changed
    //    between reading it and creating the run — most often because the agent parked on a question
    //    microseconds ago — and the right answer is to re-decide against what is true now, which turns
    //    this message into the answer rather than a new conversation. Once, not in a loop: a thread
    //    that keeps changing under us is a genuine conflict the provider should retry.
    const { runId } = await createWithPlan(
      event,
      threadId,
      assistantId,
      deps,
      channel,
      authContext,
    );

    // 7. Acknowledge **after enqueueing, never after the run completes.** Slack gives you three
    //    seconds before it retries and shows the user an error; Twilio times out comparably. This is
    //    also why signals exist at all — the ack is early, so progress has to arrive out of band.
    // Started before the acknowledgement and deliberately not awaited: the provider is waiting on
    // this response, and a typing indicator must never be the reason it times out.
    if (deps.runFrames && event.replyTo !== undefined) {
      fanOutRunSignals({
        channel,
        runId,
        target: event.replyTo,
        frames: deps.runFrames,
        logger: deps.logger,
      });
    }

    const response: ProtocolResponse = { kind: "json", status: 202, body: { run_id: runId } };
    await claim.record(response, { runId, threadId });
    return response;
  } catch (error) {
    // Never record a failure: pinning a transient 503 for the retention window would make a momentary
    // outage permanent for this event, and every retry would replay it instead of trying again.
    await claim.release();
    throw error;
  }
}

/**
 * Create the run, re-deciding once if the thread moved under us.
 *
 * The 409 this catches is the precondition working: something changed between reading the thread's
 * status and creating the run. Re-resolving turns the message into an answer to the question that
 * just appeared, instead of a start that would discard it.
 */
async function createWithPlan(
  event: InboundEvent,
  threadId: string,
  assistantId: string,
  deps: PipelineDeps,
  channel: Channel,
  authContext: AuthContext | undefined,
): Promise<{ runId: string }> {
  const attempt = async (): Promise<{ runId: string }> => {
    const plan = await resolveRunPlan(event, threadId, deps);
    return deps.createRun({
      threadId,
      assistantId,
      ...plan.run,
      streamMode: streamModesFor(channel),
      ...(authContext ? { authContext } : {}),
      // Only when the channel named a reply target *and* can actually send one. A channel with no
      // `deliver` — a GitHub integration that comments from inside the graph — owes no callback, and
      // giving it one would record a delivery nothing could ever complete.
      ...(event.replyTo !== undefined && channel.deliver
        ? { webhook: toChannelDeliveryUrl({ channelName: channel.name, replyTo: event.replyTo }) }
        : {}),
    });
  };

  try {
    return await attempt();
  } catch (error) {
    if (!isThreadStatusMismatch(error)) throw error;
    return attempt();
  }
}

function isThreadStatusMismatch(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "thread_status_mismatch";
}

/**
 * Which graph this event runs.
 *
 * The configured one unless the channel asked for another *and* the deployment listed it. A channel
 * is an npm package someone installed: without the bound, an `assistantId` derived from untrusted
 * input could reach any graph on the server.
 */
function resolveAssistant(event: InboundEvent, registered: RegisteredChannel): string {
  const requested = event.assistantId;
  if (requested === undefined || requested === registered.config.assistant) {
    return registered.config.assistant;
  }
  if (!registered.config.allowedAssistants?.includes(requested)) {
    throw SkeinHttpError.forbidden(
      `Channel "${registered.channel.name}" asked to run "${requested}", which is not in its ` +
        `allowed_assistants.`,
      { code: "assistant_not_allowed" },
    );
  }
  return requested;
}

export type { ClaimOutcome, Channel };
