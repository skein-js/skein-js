// Custom auth for the example server, authored against `@langchain/langgraph-sdk`'s `Auth` — the
// exact API LangGraph Platform uses, so this file is drop-in. skein loads it from `langgraph.json`'s
// `auth.path` and applies it to every request across the whole Agent Protocol surface.
//
// Posture: open in local dev, enforced in prod. With no `SKEIN_API_KEY` set the server stays open
// (every caller is `demo-user`) AND threads are NOT owner-scoped, so `skein dev` needs no setup and
// threads created before you enabled auth stay visible. Set `SKEIN_API_KEY` to require an `X-Api-Key`
// header (the browser sends it via `useStream({ apiKey })`); that also turns on `@auth.on("threads")`
// ownership scoping, so a caller only sees and mutates their own threads and runs — as on LangGraph
// Platform. (Turning scoping on hides threads that predate it, since they carry no `owner` metadata.)

import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth";

/** Set this to require an API key; leave unset for an open local demo. */
const REQUIRED_API_KEY = process.env["SKEIN_API_KEY"];

const authenticated = new Auth().authenticate(async (request) => {
  if (REQUIRED_API_KEY && request.headers.get("x-api-key") !== REQUIRED_API_KEY) {
    throw new HTTPException(401, { message: "Invalid or missing X-Api-Key." });
  }

  // A real app would verify a JWT / session here and derive a per-user identity; the demo uses one
  // user so the memory the research agent stores under `configurable.user_id` still lines up.
  return { identity: "demo-user", permissions: [] };
});

// Only scope threads (and their runs) by owner when auth is actually enforced. The returned filter
// hides other users' threads on reads and stamps `owner` onto new ones so later reads match.
export const auth = REQUIRED_API_KEY
  ? authenticated.on("threads", ({ user }) => ({ owner: user.identity }))
  : authenticated;
