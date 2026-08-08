// Resolving a request path to a bundled console asset. Transport-neutral by design: this package
// knows nothing about Express, Fetch, or any framework — it answers "what bytes, what content type,
// what cache header" and lets an adapter do the sending.

import { CONSOLE_ASSETS } from "./assets.generated.js";

/** One file of the built console SPA, compiled into the bundle. */
export interface ConsoleAsset {
  contentType: string;
  /** How `body` is encoded: text assets stay readable, binary ones are base64. */
  encoding: "utf8" | "base64";
  /** Size of the decoded file, so a caller can set Content-Length without decoding first. */
  byteLength: number;
  body: string;
}

/** A resolved asset, ready to send. */
export interface ResolvedConsoleAsset extends ConsoleAsset {
  /** The file it resolved to, e.g. `index.html` or `assets/console.js`. */
  file: string;
  /** `Cache-Control` for this file. */
  cacheControl: string;
  /** The decoded bytes. */
  bytes: Uint8Array;
}

/**
 * What a request to the console mount resolved to.
 *
 * `redirect` exists because the SPA references its assets *relatively* (so one build can be mounted
 * anywhere). A browser at `/console` resolves `./assets/console.js` against `/`, which is the wrong
 * place; at `/console/` it resolves correctly. So a bare mount path must redirect to its slashed
 * form rather than serve HTML that will fetch nothing.
 */
export type ConsoleResolution =
  | { kind: "asset"; asset: ResolvedConsoleAsset }
  | { kind: "redirect"; location: string }
  | { kind: "miss" };

/**
 * Immutable for hashed-looking asset paths, revalidated for everything else.
 *
 * The console builds to stable filenames (`assets/console.js`), so `immutable` would pin a stale
 * console in every browser that ever loaded one — the entry points must revalidate. Only files whose
 * names already carry a content hash are safe to cache forever.
 */
const HASHED_FILENAME = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

function cacheControlFor(file: string): string {
  return HASHED_FILENAME.test(file)
    ? "public, max-age=31536000, immutable"
    : "no-cache, must-revalidate";
}

/** `?a=1`, `a=1` and `` all normalize to something safe to append to a path. */
function normalizeSearch(search: string | undefined): string {
  if (search === undefined || search === "" || search === "?") return "";
  return search.startsWith("?") ? search : `?${search}`;
}

function decode(asset: ConsoleAsset): Uint8Array {
  return asset.encoding === "base64"
    ? Uint8Array.from(atob(asset.body), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(asset.body);
}

/** Every file path the bundled console contains, e.g. `["assets/console.js", "index.html"]`. */
export function consoleAssetFiles(): readonly string[] {
  return Object.keys(CONSOLE_ASSETS);
}

/**
 * Resolve a path *within the console mount* (the request path with the mount prefix already removed)
 * to an asset.
 *
 * - `""` → redirect to the slashed mount, so relative asset URLs resolve (see {@link ConsoleResolution}).
 * - `"/"` → `index.html`.
 * - `"/assets/console.js"` → that file.
 * - anything else → `miss`. Deliberately *not* an SPA fallback to index.html: the console routes on
 *   the URL hash, so a real deep link never arrives here, and answering 200-with-HTML for an unknown
 *   path would mask a broken asset reference as a blank page.
 */
export function resolveConsoleAsset(
  pathWithinMount: string,
  options: { mountPath?: string; search?: string } = {},
): ConsoleResolution {
  const mountPath = options.mountPath ?? "/console";
  if (pathWithinMount === "") {
    // Carry the query across. `/console?baseUrl=…` is the documented way to point a console at a
    // remote deployment, and dropping the query on the redirect silently discarded exactly that.
    const search = normalizeSearch(options.search);
    return { kind: "redirect", location: `${mountPath}/${search}` };
  }

  const requested = pathWithinMount.replace(/^\/+/, "");
  const file = requested === "" ? "index.html" : requested;
  const asset = Object.prototype.hasOwnProperty.call(CONSOLE_ASSETS, file)
    ? CONSOLE_ASSETS[file]
    : undefined;
  if (asset === undefined) return { kind: "miss" };

  return {
    kind: "asset",
    asset: { ...asset, file, cacheControl: cacheControlFor(file), bytes: decode(asset) },
  };
}
