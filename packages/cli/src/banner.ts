// The `skein dev` startup banner, printed once the server is listening. Skein-branded and compact:
// a welcome header and the served URLs (drawn directly with the shared color helper), then the
// graphs it registered, optional auth, run concurrency, and the bound address — routed through the
// dev `Logger` so those status lines share the exact `info:` styling of the runtime logs.

import type { Logger } from "@skein-js/agent-protocol";

import { bold, cyan, dim, green } from "./colors.js";

/** What the banner needs to describe the running dev server. */
export interface BannerInfo {
  host: string;
  port: number;
  /** Declared graph ids — one `Registering graph with id '…'` line each. */
  graphIds: string[];
  /** The `auth.path` from `langgraph.json`, when an auth block is configured. */
  authPath?: string;
  /**
   * How many queued runs the single background worker executes at once (`--concurrency`). There is
   * always exactly one worker per process; this is its concurrency, not a process count — which is
   * why the line below says so, rather than copying `langgraph dev`'s "Starting N workers" (it really
   * does spawn N loops; we don't).
   */
  runConcurrency: number;
}

/** Print the startup banner. Decorative header + URLs go straight to stdout; the status lines use
 * `logger` so they match the `info:` styling of the request/run logs that follow. */
export function printBanner(info: BannerInfo, logger: Logger): void {
  const { host, port, graphIds, authPath, runConcurrency } = info;
  const base = `http://${host}:${port}`;

  console.log();
  console.log(`${bold(green("skein"))} ${dim("· Agent Protocol dev server")}`);
  console.log();
  console.log(`${dim("API ")}  ${cyan(base)}`);
  console.log(`${dim("Docs")}  ${cyan(`${base}/docs`)}`);
  console.log();

  for (const id of graphIds) logger.info(`Registering graph with id '${id}'`);
  if (authPath) logger.info(`Loading auth from ${authPath}`);
  logger.info(
    runConcurrency === 1
      ? "Starting 1 worker"
      : `Starting 1 worker, up to ${runConcurrency} concurrent runs`,
  );
  logger.info(`Server running at ${base}`);
}
