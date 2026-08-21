// The plugin contract: what a channel author writes, and what the pipeline promises them.
//
// Two rules shape every decision here. **Every provider-specific choice belongs to the channel; every
// correctness-critical one belongs to skein** — a channel cannot opt out of dedup, thread resolution
// or durable delivery, because those are the parts that are hard to get right and identical for every
// provider. And **no privileged access**: the first-party channels import this module and nothing
// else, exactly as a community one does, so a missing capability shows up here rather than being
// worked around internally.
//
// Note what is deliberately absent: `from`, `to`, `body`, `typing`. Chat is the case where the reply
// target happens to be the sender; a GitHub webhook, a Stripe dispute and an inbound email are the
// same pipeline without that property. The moment those names appear in this file, those stop fitting.

import type { Interrupt, RunStatus } from "@skein-js/core";

/**
 * A request as it arrived, before anything has been parsed.
 *
 * Raw bytes and the public URL are both here because signature schemes need them and both are
 * destroyed by well-meaning middleware: parsing JSON before verification makes Slack's scheme
 * *impossible* to check, and a proxy that rewrites the host breaks Twilio's, which signs the URL.
 */
export interface InboundRequest {
  readonly method: string;
  /**
   * The **public** URL this request was sent to — what the provider signed, not what the process
   * happened to bind.
   *
   * Taken from the channel's configured `public_url` when there is one, because every adapter answers
   * this question differently and the forwarding headers that would answer it are attacker-controlled.
   */
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  /** Lazily decoded views of the body. Cached, so reading twice costs once. */
  json(): unknown;
  form(): Record<string, string>;
  text(): string;
}

/**
 * Who a verified request represents.
 *
 * A principal rather than a boolean because a provider signature **is** an authentication scheme; it
 * just is not a bearer token. Returning an identity lets an inbound event flow through the deployment's
 * ordinary `Auth` block — `@auth.on.threads` handlers see it, ownership filters apply, multi-tenancy
 * works — instead of needing a route that bypasses authorization to create runs.
 */
export interface ChannelPrincipal {
  /** Derived from provider-verified data only, e.g. `"channel:twilio:+254712345678"`. */
  identity: string;
  permissions?: string[];
  metadata?: Record<string, unknown>;
}

/** What a channel wants done with a request it has verified. */
export type ChannelOutcome =
  | { kind: "event"; event: InboundEvent }
  /**
   * Acknowledge and do nothing — 204.
   *
   * A distinct outcome rather than a null event because **ignoring has to be cheap and explicit**:
   * Slack redelivers your own bot's messages, and a channel that cannot say "not interesting" ends up
   * answering itself in a loop.
   */
  | { kind: "ignore" }
  /**
   * Answer this request directly, with no run.
   *
   * Required by real providers, not a convenience: Slack's very first request is a `url_verification`
   * challenge that must echo a value back, and a slash command wants an immediate ephemeral reply. A
   * 204 expresses neither.
   */
  | { kind: "respond"; status: number; headers?: Record<string, string>; body?: unknown };

/** Where a reply goes. Opaque to skein — minted by the channel, handed back to it unchanged. */
export type ReplyTarget = unknown;

/** What arrives when a request turns out to be something the agent should act on. */
export interface InboundEvent {
  /**
   * The stable external identity this event belongs to — a phone number, an issue URL, an email
   * thread id. Mapped to a thread deterministically, so the same key always resumes the same
   * conversation. See `threadIdForChannelKey`.
   */
  threadKey: string;
  /** The thread id outright, when a channel would rather choose it than have one derived. */
  threadId?: string;
  /** Graph input for a fresh turn. */
  input: unknown;
  /**
   * What to hand `interrupt()` when this event resumes a paused run, if not `input`.
   *
   * The proposal assumed the resume value could just be `input`. It cannot, and the reason generalises
   * past chat: `input` is a *graph input envelope* — for a message-shaped graph, `{ messages: [...] }`
   * — while `interrupt()` returns whatever the node asked for, which is usually a scalar the author
   * chose (`true`, `"approve"`, the raw text). Passing the envelope hands the node an object it will
   * stringify into nonsense, and the graph silently reads it as "no".
   *
   * Still no coercion by skein: the channel knows the payload, the graph author knows the node, and
   * this is where the two agree. Defaults to `input` for a channel whose two shapes genuinely match.
   */
  resumeWith?: unknown;
  /** The provider's own event id, used to make retried deliveries idempotent. */
  idempotencyKey?: string;
  /** Handed back to `deliver` and `onSignal`. */
  replyTo?: ReplyTarget;
  /** Route to a graph other than the configured one — only among `allowed_assistants`. */
  assistantId?: string;
  metadata?: Record<string, unknown>;
  /**
   * What to do when the thread already has a run in flight or waiting on a human.
   *
   * Defaults to `"resume"`, which is the case everybody gets wrong: a reply arriving hours after an
   * `interrupt()` is an *answer*, not a new conversation, and starting a fresh run discards the
   * pending question. Built on the server's `if_thread_status` precondition, so the decision is atomic
   * rather than a read the next replica can invalidate.
   */
  onExisting?: "resume" | "enqueue" | "interrupt" | "reject";
}

/** Which run signals a channel wants. Omit to receive none and pay nothing for them. */
export interface SignalSubscription {
  kinds: readonly RunSignal["kind"][];
  /** Re-emit `progress` on this cadence — indicators on most providers expire in seconds. */
  keepaliveMs?: number;
}

/**
 * Progress on a run in flight.
 *
 * Only the two kinds with a demonstrated consumer ship: `progress` drives an indicator, `keepalive`
 * keeps it from expiring. `accepted`, `interrupted` and `settled` were all specified and then cut —
 * the acknowledgement is already the HTTP response, the interrupt arrives durably in the callback,
 * and on the motivating provider the indicator clears itself when the reply lands, so there was no
 * "stop" call for `settled` to make. This union is permanent public API; a kind is easy to add later
 * and impossible to remove.
 */
export type RunSignal =
  | { kind: "progress"; runId: string; node?: string; custom?: unknown }
  | { kind: "keepalive"; runId: string };

/** What a settled run turned into, for `deliver`. */
export interface RunOutcomeForChannel {
  runId: string;
  threadId: string;
  status: RunStatus;
  /**
   * The answer to send, already resolved — the graph's declared reply if it wrote one, else the last
   * AI message in `values.messages`, else absent.
   *
   * Resolved by the pipeline rather than by the channel, because the alternative is every channel
   * knowing the graph's state shape, which is what would stop them being reusable across graphs.
   * Absent means the run produced nothing to say, and a channel should send nothing rather than
   * inventing an apology — whether an end user is told "something went wrong" is a product decision.
   */
  reply?: unknown;
  /** The questions a run parked on, keyed by task, when it ended `interrupted`. */
  interrupts?: Record<string, Interrupt[]>;
  /** The run's final state, for a channel that needs more than the resolved reply. */
  values?: unknown;
}

/**
 * One inbound integration.
 *
 * `verify` and `parseEvent` are required because they are the only genuinely provider-specific steps.
 * Everything else — dedup, thread resolution, resume-versus-start, durable delivery — is skein's, once,
 * for every channel.
 */
export interface Channel {
  readonly name: string;

  /**
   * Authenticate the request. Return the principal it represents, or `false` to reject with 401.
   *
   * Runs **before any parsing**, over the raw request, because that is the only point at which a
   * signature can still be checked. Required, not optional: a provider with no signature scheme must
   * still produce a principal some other way — a secret path segment, a shared-secret query parameter,
   * basic auth. Weaker is a decision a deployment can make; absent is not.
   */
  verify(request: InboundRequest): Promise<ChannelPrincipal | false> | ChannelPrincipal | false;

  /** Map a verified request to an event, an ignore, or a direct response. This is the integration. */
  parseEvent(request: InboundRequest): Promise<ChannelOutcome> | ChannelOutcome;

  /**
   * Send the answer. **Durable** — routed through the delivery outbox, so it is retried, recorded and
   * replayable, and survives the process dying mid-run.
   */
  deliver?(outcome: RunOutcomeForChannel, target: ReplyTarget): Promise<void>;

  readonly signals?: SignalSubscription;

  /**
   * React to progress — a typing indicator, a status line.
   *
   * **Best-effort: at most once, never retried, never blocking the run.** Deliberately the opposite
   * guarantee to `deliver`, and a separate method so the two cannot be confused: retrying a "typing"
   * signal four minutes late is nonsense, and making the answer best-effort would defeat the point.
   * Must not send the answer.
   */
  onSignal?(signal: RunSignal, target: ReplyTarget): Promise<void>;
}
