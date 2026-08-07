// Wraps the protocol handler table so a repeated `Idempotency-Key` on a create replays the original
// response instead of starting a second run. The ONE transport-neutral seam through which every
// adapter inherits it — nothing framework-specific lives here.
//
// Every webhook provider retries: Twilio on timeout or 5xx, Stripe, GitHub, Slack, SendGrid. Without
// this, a retry means a second reply to the end user or two agents acting on one event, and the only
// defence is a dedup table re-implemented inside every caller's application.
//
// Modelled on `authorizing-handlers.ts`, which is the other table-wide wrapper. This one sits
// **outside** it: the scope needs the authenticated principal, so authentication has to have
// happened first. See `principalFor` for what that costs.

import { SkeinHttpError, type SkeinStore } from "@skein-js/core";

import type {
  ProtocolHandler,
  ProtocolHandlers,
  ProtocolRequest,
  ProtocolResponse,
} from "../create-handlers.js";
import type { Clock, Logger } from "../deps.js";

import { idempotencyScope, requestFingerprint } from "./fingerprint.js";
import type { IdempotencyConfig } from "./idempotency-config.js";

/**
 * Creates whose response is a plain JSON body, so it can be recorded and replayed verbatim.
 *
 * `createRunBatch` is here despite having no `Content-Location` (the header names one run, and a
 * batch has many) — its body is still exactly reproducible, which is what a replay needs.
 */
const RECORDABLE_CREATES = [
  "createWaitRun",
  "createBackgroundRun",
  "createStatelessRun",
  "createRunBatch",
] as const satisfies readonly (keyof ProtocolHandlers)[];

/**
 * Creates that answer with a live SSE stream, where an idempotency key cannot be honoured.
 *
 * A `ProtocolResponse` of kind `sse` carries an `AsyncIterable`, not a body: there is nothing to
 * record, and consuming it to make one would break the stream for the caller who asked for it.
 *
 * These are **rejected loudly rather than ignored**. Silently dropping the header would leave a
 * caller believing their retries are deduplicated when every one of them starts another run — the
 * exact failure this whole surface exists to prevent, made harder to see by looking handled.
 */
const UNSUPPORTED_STREAM_CREATES = [
  "createStreamRun",
  "postThreadStream",
  "postThreadCommands",
] as const satisfies readonly (keyof ProtocolHandlers)[];

/**
 * `Pick`, not `extends IdempotencyConfig`: the sweep cadence travels in the same config block but is
 * the sweeper's business, and accepting it here would suggest this wrapper does something with it.
 */
export interface IdempotencyOptions extends Pick<
  IdempotencyConfig,
  "retentionHours" | "inFlightMinutes"
> {
  store: SkeinStore;
  clock: Clock;
  logger: Logger;
  /**
   * Resolves the authenticated caller for scoping, or `undefined` on a server with no auth.
   *
   * Injected rather than resolved here so this wrapper does not depend on `AuthEngine`, and so the
   * cost is visible at the composition site: on a request that carries a key, this authenticates and
   * then the inner auth wrapper authenticates again. Only on that path, and `authenticate` is a
   * user callback the docs already treat as per-request work.
   */
  principalFor?: (req: ProtocolRequest) => Promise<string | undefined>;
  /** Claim token generator. Injected so tests get stable ids. */
  newClaimId?: () => string;
}

const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_IN_FLIGHT_MINUTES = 15;

/**
 * Wrap `handlers` so the creates honour `Idempotency-Key`. Every other route is passed through
 * untouched, and a request without the header costs one header lookup.
 */
export function createIdempotentHandlers(
  handlers: ProtocolHandlers,
  options: IdempotencyOptions,
): ProtocolHandlers {
  const retentionMs = (options.retentionHours ?? DEFAULT_RETENTION_HOURS) * 3_600_000;
  const inFlightMs = (options.inFlightMinutes ?? DEFAULT_IN_FLIGHT_MINUTES) * 60_000;
  const newClaimId = options.newClaimId ?? (() => crypto.randomUUID());

  const wrapped = { ...handlers };
  for (const name of UNSUPPORTED_STREAM_CREATES) {
    wrapped[name] = rejectKeyOnStream(handlers[name]);
  }
  for (const name of RECORDABLE_CREATES) {
    wrapped[name] = async (req) => {
      const key = req.headers["idempotency-key"];
      if (key === undefined || key === "") return handlers[name](req);

      const scope = idempotencyScope(req, await options.principalFor?.(req));
      const fingerprint = requestFingerprint(req);
      const claimId = newClaimId();
      const now = options.clock().getTime();

      const { claimed, record } = await options.store.idempotency.claim({
        key,
        scope,
        fingerprint,
        claim_id: claimId,
        now: new Date(now).toISOString(),
        expires_at: new Date(now + inFlightMs).toISOString(),
      });

      if (!claimed) {
        // Same key, different request. A caller bug worth surfacing rather than answering with
        // someone else's response — and the one case where staying silent would be actively wrong.
        if (record.fingerprint !== fingerprint) {
          throw SkeinHttpError.unprocessable(
            `Idempotency-Key "${key}" was already used for a different request body.`,
          );
        }
        // The original is still running. 409 rather than blocking on it: holding the connection
        // would tie up a socket for the length of a run and time out in most proxies anyway.
        if (record.status !== "done" || !record.response) {
          throw SkeinHttpError.conflict(
            `Idempotency-Key "${key}" is still in flight. Retry shortly.`,
            { details: { retry_after_seconds: 1 } },
          );
        }
        const replayed = record.response;
        return {
          kind: "json",
          status: replayed.status,
          body: replayed.body,
          headers: { ...replayed.headers, "idempotent-replay": "true" },
        };
      }

      let response: ProtocolResponse;
      try {
        response = await handlers[name](req);
      } catch (error) {
        // Failures are deliberately never recorded — pinning a transient 503 for the whole retention
        // would make a momentary outage permanent for that key, and every retry for the next day
        // would replay the failure instead of trying again.
        await release(options, scope, key, claimId);
        throw error;
      }

      if (response.kind !== "json" || response.status >= 300) {
        await release(options, scope, key, claimId);
        return response;
      }

      try {
        await options.store.idempotency.record(scope, key, claimId, {
          status: response.status,
          body: response.body,
          ...(response.headers ? { headers: response.headers } : {}),
          ...(runIdOf(response.body) !== undefined ? { run_id: runIdOf(response.body) } : {}),
          ...(threadIdOf(response) !== undefined ? { thread_id: threadIdOf(response) } : {}),
          expires_at: new Date(options.clock().getTime() + retentionMs).toISOString(),
        });
      } catch (error) {
        // The run was created. Letting a failed *recording* turn that into a 500 would be the worst
        // of both worlds: the caller sees an error, the run exists anyway, and every retry 409s
        // against the claim until it expires. Degrade instead — this key loses its replay, and a
        // later retry may create a duplicate, which is exactly where we were before this feature.
        options.logger.warn(
          `could not record idempotency key "${key}"; the response is returned but not replayable`,
          error,
        );
        await release(options, scope, key, claimId);
      }
      return response;
    };
  }
  return wrapped;
}

/** 422 when a stream create carries a key it cannot honour; otherwise pass through untouched. */
function rejectKeyOnStream(inner: ProtocolHandler): ProtocolHandler {
  return async (req) => {
    const key = req.headers["idempotency-key"];
    if (key === undefined || key === "") return inner(req);
    throw SkeinHttpError.unprocessable(
      "Idempotency-Key is not supported on streaming runs, whose response cannot be replayed. " +
        "Use the background (`POST /threads/{thread_id}/runs`) or wait " +
        "(`POST /threads/{thread_id}/runs/wait`) mode, then join the stream by run id.",
    );
  };
}

/**
 * Free a claim whose request did not produce a recordable success.
 *
 * Swallowed on failure: the caller's own response is already decided, and turning a storage blip
 * into a 500 on a request that otherwise worked would be strictly worse than leaving a claim to
 * expire on its own.
 */
async function release(
  options: IdempotencyOptions,
  scope: string,
  key: string,
  claimId: string,
): Promise<void> {
  try {
    await options.store.idempotency.release(scope, key, claimId);
  } catch (error) {
    options.logger.warn(
      `could not release idempotency key "${key}"; it will expire on its own`,
      error,
    );
  }
}

/** The created run's id, when the body names one — recorded so a replay can be traced to its run. */
function runIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const runId = (body as { run_id?: unknown }).run_id;
  return typeof runId === "string" ? runId : undefined;
}

/**
 * The thread this response belongs to, so deleting that thread erases this record with it.
 *
 * Read from `Content-Location` rather than the body, because that is the one place every single-run
 * create names its thread: `POST /runs/wait` answers with the graph's final state — the very payload
 * this is here to make erasable — and that body has no `thread_id` in it. The header is built by
 * `runLocationHeaders` from server-owned ids, so it is not caller-influenced.
 *
 * `POST /runs/batch` has no `Content-Location` (its runs may span threads) and gets `undefined`. That
 * is the honest answer rather than a gap: a batch body is a list of run rows, not conversation
 * content, so there is nothing thread-shaped in it to erase.
 */
function threadIdOf(response: ProtocolResponse): string | undefined {
  const location = response.headers?.["content-location"];
  return /^\/threads\/([^/]+)\/runs\//.exec(location ?? "")?.[1];
}
