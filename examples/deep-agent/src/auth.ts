// Who is calling. skein loads this from `langgraph.json`'s `auth.path` — it is the same `Auth` API
// LangGraph Platform uses — and stamps the result onto every run as `langgraph_auth_user`, where the
// Deep Agent's durable memory reads it (see `memory-namespace.ts`).
//
// A demo identity, read from an `x-user` header so a test (or curl) can act as two people. A real
// deployment verifies a JWT or session here instead; nothing downstream changes.

import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth";

/** Who a request with no `x-user` header is. */
export const DEMO_USER = "demo-user";

export const auth = new Auth()
  .authenticate(async (request) => {
    const identity = request.headers.get("x-user") ?? DEMO_USER;
    if (identity.length === 0) throw new HTTPException(401, { message: "Missing caller identity" });
    return { identity, permissions: [] };
  })
  // Each caller sees only their own threads (and so their own runs), as on LangGraph Platform.
  .on("threads", ({ user }) => ({ owner: user.identity }))
  // The graph accesses memory through its injected store, with its own namespace callback. The
  // example does not need a second, HTTP path around that isolation boundary.
  .on("store", () => false);
