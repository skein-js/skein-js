// A graph that failed to load, turned into an answer a caller can act on.
//
// A `GraphResolver` rejects with whatever the on-ramp threw — for `@skein-js/config` that is a
// `SkeinConfigError` naming the module, wrapping the graph's real failure. None of that is a
// `SkeinHttpError`, so every adapter fell through to its "unhandled fault" branch: a bare
// `{"status":500,"message":"Internal Server Error"}` for the caller, and a full stack + cause chain
// logged on *every* request — which, for a console polling `GET /threads/{id}/state` against a graph
// that cannot load, is the same wall of text forever.
//
// Used on the surfaces that answer over HTTP directly (thread state/history, assistant
// introspection, the single-graph invoke handler). NOT on the run path: a failed run already reports
// itself through `toRunError`, which carries the whole `cause` chain to the `error` frame and the run
// row, so wrapping there would only add a link to a depth-capped chain and rename the error.

import { rootCauseMessage, SkeinHttpError, isSkeinHttpError } from "@skein-js/core";

import type { GraphResolver, ResolvedGraph } from "../deps.js";

/**
 * Map a graph-load failure onto a `SkeinHttpError`. A `SkeinHttpError` from the resolver passes
 * through untouched — an unknown graph id is already a deliberate 4xx and must not become a 500.
 *
 * `exposeReason` decides how much of *why* reaches the caller, and draws the same line
 * `exposeErrorStacks` already draws for stacks:
 *
 * - **on** (`skein dev`) — the root cause's own sentence, so the console says "GOOGLE_API_KEY is not
 *   set" instead of "Internal Server Error".
 * - **off** (`skein start`, every embedded server) — the graph id and nothing else. A load failure's
 *   message is not ours and routinely names server paths (`Cannot find module '/srv/app/dist/…'`) or
 *   internal hosts (`ECONNREFUSED 10.0.3.14:5432`), which a production caller has no business seeing.
 *
 * Either way the *stack* never travels, the original error is kept as `cause` so a logger still has
 * the whole chain, and the operator loses nothing: the adapters log every 5xx.
 */
export function graphLoadHttpError(
  cause: unknown,
  graphId: string,
  exposeReason: boolean,
): unknown {
  if (isSkeinHttpError(cause)) return cause;
  const reason = exposeReason ? `: ${rootCauseMessage(cause)}` : ".";
  return new SkeinHttpError(500, `Graph "${graphId}" failed to load${reason}`, {
    code: "graph_load_failed",
    cause,
  });
}

/**
 * Load a graph by id, mapping a load failure through {@link graphLoadHttpError}.
 *
 * `exposeReason` defaults to `false` — the safe end. A caller that wants the reason on the wire has
 * to say so, which in practice means passing `deps.exposeErrorStacks === true`.
 */
export async function loadGraphOrThrow(
  graphs: GraphResolver,
  graphId: string,
  exposeReason = false,
): Promise<ResolvedGraph> {
  try {
    return await graphs.load(graphId);
  } catch (cause) {
    throw graphLoadHttpError(cause, graphId, exposeReason);
  }
}
