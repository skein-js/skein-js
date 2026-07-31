// Redis-backed `RunAbortChannel`: carries run-abort requests between instances, so a
// `POST /threads/{id}/runs/{id}/cancel` routed to replica B stops a run executing on replica A.
//
// One pub/sub channel for the whole deployment, not one per run. An abort is a rare control message and
// every instance needs to hear all of them (only the executor acts, the rest no-op on an unknown run
// id), so a single `SUBSCRIBE` per process is both simpler and cheaper than tracking which runs a
// process happens to be executing.
//
// Fire-and-forget on purpose, matching the seam's contract: the cancel is already durable in the run
// row before this is called, so a dropped message costs promptness rather than correctness. That is what
// makes plain pub/sub the right primitive here instead of a durable queue.

import type {
  RunAbortChannel,
  RunAbortListener,
  RunAbortReason,
  RunAbortRequest,
  RunAbortSubscription,
} from "@skein-js/core";
import { Redis, type RedisOptions } from "ioredis";

import { closeConnection } from "./redis-connection.js";

/** How ioredis clients are created. Injected so the channel can be tested without a server. */
export type RedisClientFactory = (url: string, options?: RedisOptions) => Redis;

export interface RedisRunAbortChannelOptions {
  /** Namespaces the channel so multiple apps can share one Redis. Default `"skein"`. */
  keyPrefix?: string;
  /** Called when a malformed message arrives, or a publish fails. Defaults to silence. */
  onError?: (error: unknown) => void;
  /** How ioredis clients are created. Defaults to `new Redis(url, options)`. */
  createClient?: RedisClientFactory;
}

/** The reasons that may travel on the wire — anything else is a malformed message. */
const ABORT_REASONS = new Set<RunAbortReason>(["cancel", "timeout", "interrupt", "rollback"]);

/**
 * Parse a published message back into a request, or `undefined` if it is not one.
 *
 * Validated rather than trusted: this is a shared Redis, so another app (or an older/newer skein) can
 * publish to the same channel, and an unvalidated `reason` would reach the run engine and decide which
 * terminal status a run settles to.
 */
function parseAbortRequest(payload: string): RunAbortRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { run_id: runId, reason } = parsed as { run_id?: unknown; reason?: unknown };
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  if (typeof reason !== "string" || !ABORT_REASONS.has(reason as RunAbortReason)) return undefined;
  return { run_id: runId, reason: reason as RunAbortReason };
}

/** Redis `RunAbortChannel`. Owns its connections; every subscription's `close()` releases its own. */
export class RedisRunAbortChannel implements RunAbortChannel {
  readonly #commands: Redis;
  readonly #url: string;
  readonly #createClient: RedisClientFactory;
  readonly #channel: string;
  readonly #onError: (error: unknown) => void;
  #disposed = false;

  constructor(url: string, options: RedisRunAbortChannelOptions = {}) {
    this.#url = url;
    this.#createClient = options.createClient ?? ((target, opts) => new Redis(target, opts ?? {}));
    // Lazy, for the same reason the event bus is: constructing this must not open a socket, so an
    // assembly that fails partway has no in-flight handshake to orphan. See `closeConnection`.
    this.#commands = this.#createClient(url, { lazyConnect: true });
    this.#channel = `${options.keyPrefix ?? "skein"}:runs:abort`;
    this.#onError = options.onError ?? (() => {});
  }

  async requestAbort(request: RunAbortRequest): Promise<void> {
    if (this.#disposed) return;
    await this.#commands.publish(
      this.#channel,
      JSON.stringify({ run_id: request.run_id, reason: request.reason }),
    );
  }

  subscribe(listener: RunAbortListener): RunAbortSubscription {
    // Its own connection, because a subscribed ioredis client cannot issue ordinary commands — the
    // publish side needs `#commands` to stay usable.
    const subscriber = this.#createClient(this.#url, {});
    let closed = false;

    subscriber.on("message", (_channel, payload: string) => {
      const request = parseAbortRequest(payload);
      if (!request) {
        this.#onError(new Error(`ignored a malformed abort message: ${payload.slice(0, 120)}`));
        return;
      }
      try {
        listener(request);
      } catch (error) {
        // A listener that throws must not take down the subscriber and silently stop delivering every
        // later abort on this instance.
        this.#onError(error);
      }
    });
    // Errors are reported, never thrown: an unhandled `error` on an ioredis client terminates the
    // process, and losing the abort channel must not do that — cancellation degrades to per-instance.
    subscriber.on("error", (error) => this.#onError(error));

    const subscribed = subscriber.subscribe(this.#channel).catch((error: unknown) => {
      this.#onError(error);
    });

    return {
      close: async () => {
        if (closed) return;
        closed = true;
        // Await the SUBSCRIBE first: closing mid-handshake is what orphans ioredis's in-flight
        // commands as unhandled rejections (see redis-connection.ts).
        await subscribed;
        await closeConnection(subscriber);
      },
    };
  }

  /** Release the publishing connection. Subscriptions own theirs and are closed individually. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await closeConnection(this.#commands);
  }
}
