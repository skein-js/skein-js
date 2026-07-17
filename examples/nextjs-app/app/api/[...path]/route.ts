// A single App Router catch-all serves the whole Agent Protocol, same-origin with the UI. Re-export
// the per-method handlers from `createSkeinRouteHandlers` — that's the entire backend.

import { createSkeinRouteHandlers } from "@skein-js/nextjs";

import { deps } from "../../../lib/skein-deps";

// The background run worker + in-memory drivers need a long-lived Node process (not the edge runtime).
export const runtime = "nodejs";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createSkeinRouteHandlers({ deps });
