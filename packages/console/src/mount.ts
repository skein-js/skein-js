// Turning a request into a console response, one level up from `resolveConsoleAsset`.
//
// Every adapter needs the same three steps — is this path mine, strip my prefix, resolve — so they
// live here once rather than in each transport shim.

import { resolveConsoleAsset, type ConsoleResolution } from "./assets.js";

/** Where the console is mounted. Defaults to `/console`, alongside the protocol's own routes. */
export interface ConsoleMountOptions {
  /**
   * The request's query string, so the bare-mount redirect can carry it. Without it a request for
   * `/console?baseUrl=…` redirects to `/console/` and loses the override it was carrying.
   */
  search?: string;
  /**
   * Path the console is served under, without a trailing slash. The SPA derives the API base by
   * dropping this path's last segment, so a mount of `/admin/console` targets `/admin` — which is
   * what makes the console work inside a host app that mounts skein under its own prefix.
   */
  mountPath?: string;
}

const DEFAULT_MOUNT_PATH = "/console";

/** Normalize a mount path: leading slash, no trailing slash, `/console` when unset. */
export function normalizeMountPath(mountPath: string | undefined): string {
  if (mountPath === undefined || mountPath === "" || mountPath === "/") return DEFAULT_MOUNT_PATH;
  const withLeadingSlash = mountPath.startsWith("/") ? mountPath : `/${mountPath}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/**
 * Resolve a full request pathname against the console mount.
 *
 * Returns `miss` when the path belongs to something else, so an adapter can simply fall through to
 * the rest of its routes — mounting the console must never shadow a protocol route or a host app's
 * own pages.
 */
export function resolveConsoleRequest(
  pathname: string,
  options: ConsoleMountOptions = {},
): ConsoleResolution {
  const mountPath = normalizeMountPath(options.mountPath);
  if (pathname === mountPath) {
    return resolveConsoleAsset("", {
      mountPath,
      ...(options.search !== undefined ? { search: options.search } : {}),
    });
  }
  if (!pathname.startsWith(`${mountPath}/`)) return { kind: "miss" };
  return resolveConsoleAsset(pathname.slice(mountPath.length), { mountPath });
}

/**
 * The response headers for a resolved asset. Kept here so every adapter sends the same ones — a
 * console that is correct on Express and uncacheable on Fetch is a bug waiting to be reported twice.
 */
export function consoleAssetHeaders(asset: {
  contentType: string;
  byteLength: number;
  cacheControl: string;
}): Record<string, string> {
  return {
    "content-type": asset.contentType,
    "content-length": String(asset.byteLength),
    "cache-control": asset.cacheControl,
    // The console is same-origin with the API it drives and loads no third-party code; both headers
    // are cheap insurance for a UI that renders whatever a graph put in a thread's state.
    "x-content-type-options": "nosniff",
  };
}
