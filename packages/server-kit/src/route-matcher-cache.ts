// A memoized `RouteMatcher` per route table, for the adapters that dispatch from a catch-all route
// (Next.js App/Pages Router, the Fetch server) rather than from a framework router.
//
// Those adapters resolve their runtime lazily and match inside the request path, so building the
// matcher there would recompile a regex per route on *every request*. They used to import the
// module-level `matchSkeinRoute`, which was compiled once — but that always matches the full protocol,
// and a server with `http.disable_*` flags has to match its own, narrower table.

import { createRouteMatcher, type RouteBinding, type RouteMatcher } from "@skein-js/agent-protocol";

/**
 * Keyed on the table's identity, which is what makes this reliable: `filterSkeinRoutes` returns the
 * *same array* when nothing is disabled, and a resolved runtime is a memoized singleton — so a server
 * compiles its matcher once for its whole lifetime. Weak, so a discarded runtime's table (a Next.js
 * runtime evicted after a failed resolve) does not pin its matcher.
 */
const matchers = new WeakMap<readonly RouteBinding[], RouteMatcher>();

/** The matcher for `routes`, compiled on first use and reused thereafter. */
export function routeMatcherFor(routes: readonly RouteBinding[]): RouteMatcher {
  const existing = matchers.get(routes);
  if (existing) return existing;
  const matcher = createRouteMatcher(routes);
  matchers.set(routes, matcher);
  return matcher;
}
