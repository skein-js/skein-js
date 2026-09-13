import { Auth } from "@langchain/langgraph-sdk/auth";

// Channel requests do not call this authenticate callback: the provider signature supplies the
// principal. Declaring an Auth block still matters because it enables Skein's normal authorization
// pipeline and stamps that verified principal into the graph's configurable values.
export const auth = new Auth().authenticate(async () => ({
  identity: "local-api-user",
  permissions: [],
}));
