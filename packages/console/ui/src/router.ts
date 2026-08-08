// A ~40-line hash router, in place of a routing dependency.
//
// Hash routing is not a size shortcut, it is a mounting decision: `#/threads/abc` never leaves the
// browser, so no adapter needs an SPA history fallback and a deep link works identically whether the
// console is served from `/console/`, from a host app's own prefix, or from a static site.

import { useCallback, useSyncExternalStore } from "react";

/** A parsed route: the path segments after `#/`, e.g. `["threads", "abc"]`. */
export type Route = readonly string[];

function currentHash(): string {
  return window.location.hash.replace(/^#\/?/, "");
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/**
 * The current route as decoded segments, plus any query on the hash, re-rendering whenever it changes.
 *
 * A hash route can carry its own query string (`#/threads?status=interrupted`). It is the only way to
 * deep-link a *filtered* view, which is what makes "3 waiting for you" on the overview a link rather
 * than an instruction to go and filter the list yourself.
 */
export function useRoute(): {
  segments: Route;
  query: URLSearchParams;
  navigate: (path: string) => void;
} {
  const raw = useSyncExternalStore(subscribe, currentHash, () => "");
  const navigate = useCallback((path: string) => {
    window.location.hash = `#/${path.replace(/^\/+/, "")}`;
  }, []);
  const [path, search = ""] = raw.split("?");
  const segments = (path ?? "")
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent);
  return { segments, query: new URLSearchParams(search), navigate };
}

/** Build an `href` for a route, so links stay real anchors (middle-click and copy-link keep working). */
export function routeHref(path: string): string {
  return `#/${path.replace(/^\/+/, "")}`;
}
