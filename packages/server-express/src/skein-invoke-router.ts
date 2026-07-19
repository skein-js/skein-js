// The simplified serving surface on Express: mount every declared graph as a plain endpoint
// (`POST /invoke/:graph_id`) that runs it to completion and returns its final state. Separate from
// `skeinRouter` on purpose — this is the whole surface for a non-chat service (no threads,
// assistants, or runs), and mounting both is just two `app.use` calls. See
// docs/serving-a-single-graph.md.

import {
  createGraphInvokeHandler,
  graphInvokeRoutes,
  type GraphInvokeOptions,
  type ProtocolDeps,
} from "@skein-js/agent-protocol";
import { resolveRuntimeDeps, type SkeinRuntimeOptions } from "@skein-js/server-kit";
import cors from "cors";
import express from "express";
import type { Request, Response, Router } from "express";

import { sendErrorResponse } from "./error-response.js";
import { sendProtocolResponse } from "./send-protocol-response.js";
import { toProtocolRequest } from "./to-protocol-request.js";

export type SkeinInvokeRouterOptions = SkeinRuntimeOptions &
  GraphInvokeOptions & {
    /** Path prefix for the endpoint; defaults to `/invoke` (→ `POST /invoke/:graph_id`). */
    prefix?: string;
  };

export interface SkeinInvokeRouter {
  /** Mount on an Express app: `app.use(router)`. */
  router: Router;
  /** The resolved dependencies, so a caller can reuse them (e.g. to also mount `skeinRouter`). */
  deps: ProtocolDeps;
}

/**
 * Build a `Router` serving `POST <prefix>/:graph_id`. No assistants are seeded and no background run
 * worker is started — an invoke-only service needs neither.
 */
export async function skeinInvokeRouter(
  options: SkeinInvokeRouterOptions,
): Promise<SkeinInvokeRouter> {
  const { deps, cors: corsFromConfig } = await resolveRuntimeDeps(options);
  const invoke = createGraphInvokeHandler(deps, { streamMode: options.streamMode });

  const router = express.Router();
  // Explicit option wins; otherwise fall back to the config's `http.cors`, else off.
  const corsSetting = options.cors ?? corsFromConfig ?? false;
  if (corsSetting) router.use(cors(corsSetting === true ? { origin: true } : corsSetting));
  router.use(express.json());

  for (const binding of graphInvokeRoutes(options.prefix)) {
    router[binding.method](binding.path, async (req: Request, res: Response) => {
      // Abort the graph when the client goes away, so a disconnect doesn't leave it running to
      // completion (burning model tokens) for a response nobody will read.
      const disconnected = new AbortController();
      res.once("close", () => disconnected.abort(new Error("client disconnected")));
      try {
        const request = { ...toProtocolRequest(req), signal: disconnected.signal };
        await sendProtocolResponse(await invoke(request), res);
      } catch (error) {
        sendErrorResponse(error, res, options.logger);
      }
    });
  }

  return { router, deps };
}
