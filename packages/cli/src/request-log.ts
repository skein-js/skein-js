// Whether the server logs a line per HTTP request.
//
// `dev` wants it: watching traffic is most of what a dev server is for. `start` does not — it must pass
// a logger so a failed run is reported at all, but two lines per request bury those reports, and on a
// platform that bills by log volume they are the bulk of it. Before this, the two were the same switch.

/** `true`/`1` and `false`/`0`, so either spelling works in a Dockerfile or a platform's env editor. */
function booleanFromEnv(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

/**
 * The one precedence chain: an explicit `--request-log` / `--no-request-log` wins, else
 * `SKEIN_REQUEST_LOG`, else the command's own default.
 *
 * A malformed `SKEIN_REQUEST_LOG` falls through to the default rather than throwing: unlike a pool size
 * or a timeout, getting this wrong cannot corrupt anything or wedge a deployment, so refusing to boot a
 * production server over a logging preference would be the more damaging failure.
 */
export function resolveRequestLog(
  explicit: boolean | undefined,
  fallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return explicit ?? booleanFromEnv(env["SKEIN_REQUEST_LOG"]) ?? fallback;
}
