// Serving `@skein-js/console` from the dev server.
//
// The mount lives here, in the CLI, rather than in `@skein-js/express`: the console is ~700 kB of
// compiled assets, and every Express user should not install it because they mounted the protocol.
// The adapters get the console through the same `resolveConsoleRequest` helper when a host app opts
// in — see docs/console.md.

import { consoleAssetHeaders, normalizeMountPath, resolveConsoleRequest } from "@skein-js/console";
import type { SkeinExpressServer } from "@skein-js/express";

/**
 * The Express app, reached through the adapter's own type rather than by importing `express` here.
 * The CLI depends on `@skein-js/express`, not on Express itself, and adding a direct dependency just
 * to name a parameter would be the wrong direction.
 */
type ExpressApp = SkeinExpressServer["app"];

export interface ConsoleMountResult {
  /** The path the console is served under, for the banner. */
  mountPath: string;
}

/**
 * Mount the console on an Express app.
 *
 * Registered with `app.use` *after* the protocol router, so it can never shadow a protocol route: a
 * request only reaches the console if nothing else claimed it, and the console answers `next()` for
 * anything outside its mount path.
 */
export function mountConsole(
  app: ExpressApp,
  options: { mountPath?: string } = {},
): ConsoleMountResult {
  const mountPath = normalizeMountPath(options.mountPath);

  app.use((req, res, next) => {
    // Assets only. A POST to the console mount is not a console request — let it 404 like any other
    // unrouted verb rather than answering it with HTML.
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    // `req.url` carries the query; `req.path` does not. The bare-mount redirect needs it, or
    // `/console?baseUrl=…` loses its override on the way to `/console/`.
    const search = req.originalUrl.slice(req.originalUrl.indexOf("?") + 1);
    const resolution = resolveConsoleRequest(req.path, {
      mountPath,
      ...(req.originalUrl.includes("?") ? { search } : {}),
    });
    if (resolution.kind === "miss") return next();
    if (resolution.kind === "redirect") return res.redirect(302, resolution.location);

    const { asset } = resolution;
    res.set(consoleAssetHeaders(asset));
    // HEAD must carry the headers but no body; Express would otherwise send one and Node would strip
    // it, which is correct by accident rather than on purpose.
    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).send(Buffer.from(asset.bytes));
  });

  return { mountPath };
}
