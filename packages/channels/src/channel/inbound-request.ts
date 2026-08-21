// Turning a transport-neutral protocol request into the `InboundRequest` a channel verifies.

import type { Channel, InboundRequest } from "./channel.js";

/** What the pipeline needs from whatever transport delivered the request. */
export interface RawRequest {
  readonly method: string;
  /** The URL the adapter saw. Used only when the channel has no configured `public_url`. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The body as text. Absent for a request with no body. */
  readonly text?: string;
}

export interface BuildInboundRequestOptions {
  /**
   * The externally reachable origin this channel is mounted under, e.g. `https://api.example.com`.
   *
   * Configuration rather than something reconstructed from the request, and that is a security
   * decision rather than laziness. Twilio signs the full request URL, so verification depends on
   * knowing it — but the only inputs a server has are `Host` and `X-Forwarded-Proto`, both of which
   * the caller controls. Trusting them means a forged header changes the string being verified;
   * ignoring them means every deployment behind a proxy fails to verify. Neither is acceptable, so
   * the deployment states it once.
   */
  publicUrl?: string;
}

/**
 * Build the request a channel's `verify` and `parseEvent` see.
 *
 * The body views are lazy and cached: `verify` typically needs one shape (Twilio parses the form to
 * rebuild its signature; Slack wants the untouched text) and `parseEvent` usually needs the same one,
 * so decoding eagerly would pay for shapes nobody asks for, and decoding twice would parse the body
 * once per caller.
 */
export function buildInboundRequest(
  raw: RawRequest,
  options: BuildInboundRequestOptions = {},
): InboundRequest {
  const text = raw.text ?? "";
  let jsonCache: { value: unknown } | undefined;
  let formCache: Record<string, string> | undefined;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.headers)) {
    // Lower-cased, because a channel comparing header names should not have to know whether it is
    // behind Node's http server (which lower-cases) or a Fetch `Headers` (which also does, but only
    // through its own accessor — a plain object built from one may not have).
    if (value !== undefined) headers[name.toLowerCase()] = value;
  }

  return {
    method: raw.method,
    url: resolvePublicUrl(raw.url, options.publicUrl),
    headers,
    text: () => text,
    json: () => {
      // Cached as a wrapper rather than by testing the value, so a body that legitimately decodes to
      // `undefined` or `null` is not re-parsed on every call.
      if (!jsonCache) jsonCache = { value: text === "" ? undefined : JSON.parse(text) };
      return jsonCache.value;
    },
    form: () => {
      if (!formCache) {
        formCache = {};
        for (const [key, value] of new URLSearchParams(text)) formCache[key] = value;
      }
      return formCache;
    },
  };
}

/**
 * The URL to present to the channel: the configured public origin with the request's own path and
 * query, or the request's URL when nothing is configured.
 *
 * Only the origin is taken from configuration. The path is the router's business and a deployment
 * that had to restate it would get it wrong the first time someone mounted the routes under a prefix.
 */
function resolvePublicUrl(requestUrl: string, publicUrl?: string): URL {
  const actual = new URL(requestUrl);
  if (!publicUrl) return actual;
  const configured = new URL(publicUrl);
  const merged = new URL(actual.pathname + actual.search, configured.origin);
  return merged;
}

/**
 * A channel's declared subscription reduced to the stream modes a run needs.
 *
 * Chosen by the pipeline rather than by the channel, because the cost lands on the run: a channel that
 * only wants to keep an indicator alive must not make every run pay for token streaming. `values` is
 * always requested because the reply is resolved from the settled state.
 */
export function streamModesFor(channel: Channel): string[] {
  // `custom` is **always** requested, and it is not optional the way the others are: it is the stream
  // `replyWith()` writes to, and the engine only captures a declared reply from frames it actually
  // receives. Leaving it out made the documented first choice of reply source silently impossible —
  // every channel run fell through to the last-AI-message fallback, and a graph with non-message state
  // said nothing at all. It costs one frame per `writer()` call, which is a graph that opted in.
  const modes = ["values", "custom"];
  // `updates` is the cheap progress stream — a frame per node, which is all an indicator needs to know
  // work is happening. Token-level `events` is deliberately never selected; nothing in the signal
  // union exposes tokens, so paying for them would buy a channel nothing at all.
  if (channel.signals?.kinds.includes("progress")) modes.push("updates");
  return modes;
}
