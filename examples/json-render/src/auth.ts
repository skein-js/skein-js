import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth";

// Demo identity only. Replace with verified JWT/session authentication when deploying.
export const auth = new Auth()
  .authenticate(async (request) => {
    const identity = request.headers.get("x-user");
    if (!identity) throw new HTTPException(401, { message: "Provide a demo x-user identity" });
    return { identity, permissions: [] };
  })
  .on("threads", ({ user }) => ({ owner: user.identity }))
  .on("store", () => false);
