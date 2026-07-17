// A single catch-all Pages Router route serves the whole Agent Protocol. `createSkeinPagesHandler`
// matches skein's paths (mounted at /api here) and streams SSE straight onto the Node response.

import { createSkeinPagesHandler } from "@skein-js/nextjs";

import { deps } from "../../lib/skein-deps";

// `bodyParser` so `req.body` is parsed JSON; `externalResolver` tells Next this route settles the
// response itself (silences the "API resolved without sending a response" warning for SSE streams).
export const config = {
  api: {
    bodyParser: true,
    externalResolver: true,
  },
};

export default createSkeinPagesHandler({ deps });
