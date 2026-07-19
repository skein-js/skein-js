// Strip a mount prefix from a request pathname. Every adapter that mounts a catch-all and matches the
// route table by hand (the NestJS middleware, the Next.js catch-all handlers) needs this same step:
// the framework hands it the full external path, while `skeinRoutes` is anchored at the protocol
// root. Adapters that mount each route explicitly (Express, Fastify) get this from their router for
// free and don't need it. See docs/building-an-adapter.md.

/**
 * A prefix as `""` (no mount) or leading-slash/no-trailing-slash (`/api`, `/api/v1`). Hosts supply
 * prefixes unnormalized — NestJS's `setGlobalPrefix("api")` stores exactly `"api"` — so normalizing
 * here is what makes the strip work regardless of how the prefix was written.
 *
 * Only `""` and `"/"` mean "no mount". Anything else is normalized as a real prefix, including
 * whitespace: a `basePath` of `" "` yields `"/ "`, which matches nothing, so a malformed mount fails
 * closed (404) rather than silently serving the whole protocol at the app root.
 */
function normalizeBasePath(basePath: string): string {
  if (basePath === "" || basePath === "/") return "";
  const withLeadingSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
  // Strip *all* trailing slashes: `"/api//"` must normalize to `/api`, not `/api/` (which would then
  // match nothing and 404 every protocol path).
  return withLeadingSlash.replace(/\/+$/, "");
}

/**
 * The pathname relative to `basePath`, or `null` when the path is not under the mount — which the
 * caller should treat as "not ours" and pass through untouched, so the host app's own routes still
 * resolve. An empty (or `/`) base path passes the pathname through unchanged.
 */
export function stripBasePath(pathname: string, basePath: string): string | null {
  const prefix = normalizeBasePath(basePath);
  if (prefix === "") return pathname;
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return null;
}
