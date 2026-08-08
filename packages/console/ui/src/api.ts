// How the console decides which server it is talking to, and the one client it talks with.
//
// The console is a *static* bundle: the same bytes are served by every skein server and can also be
// hosted on a static site. So the target cannot be baked in at build time — it is resolved at boot,
// in this order:
//
//   1. `?baseUrl=…` on the URL, persisted so it survives hash navigation. This is the remote-hosting
//      path (a console on a static host pointed at your deployment).
//   2. A previously persisted `baseUrl`.
//   3. Same origin — the default, and the only one that needs no CORS and no configuration.
//
// (3) assumes the console is mounted at `<api-base>/console`, so the API base is the console's own
// directory with its last segment removed: `/console/` → `/`, `/api/console/` → `/api`. That is the
// only coupling between this bundle and where a server chooses to mount it.

import { Client } from "@langchain/langgraph-sdk";

const BASE_URL_STORAGE_KEY = "skein-console:baseUrl";
const API_KEY_STORAGE_KEY = "skein-console:apiKey";
/** The server the stored API key belongs to. See {@link resolveApiKey}. */
const API_KEY_OWNER_STORAGE_KEY = "skein-console:apiKeyFor";

/** Strip the trailing mount segment off the page's directory to get the server root. */
function sameOriginApiBase(): string {
  const directory = window.location.pathname.replace(/[^/]*$/, ""); // drop any filename
  const segments = directory.split("/").filter((segment) => segment !== "");
  segments.pop(); // the mount segment itself (`console` by default)
  const base = segments.length > 0 ? `/${segments.join("/")}` : "";
  return `${window.location.origin}${base}`;
}

/**
 * Read `?baseUrl=` once at boot and remember it, so the choice survives hash navigation.
 *
 * A cross-origin value has to be confirmed by a human first. Without that gate, opening a link like
 * `…/console/?baseUrl=https://attacker.example` silently repoints the console at someone else's
 * server — and the very first thing the console does on load is call `/info`, which would carry the
 * stored API key straight there. The key is separately bound to its own server (see
 * {@link resolveApiKey}), so this prompt is the second of two locks, not the only one.
 */
function readBaseUrlOverride(): string | undefined {
  const fromQuery = new URLSearchParams(window.location.search).get("baseUrl");
  if (fromQuery !== null && fromQuery !== "") {
    if (isSameOrigin(fromQuery) || confirmForeignTarget(fromQuery)) {
      window.localStorage.setItem(BASE_URL_STORAGE_KEY, fromQuery);
      return fromQuery;
    }
    return window.localStorage.getItem(BASE_URL_STORAGE_KEY) ?? undefined;
  }
  return window.localStorage.getItem(BASE_URL_STORAGE_KEY) ?? undefined;
}

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Asked once per boot, and only for a target the page did not come from. */
function confirmForeignTarget(url: string): boolean {
  return window.confirm(
    `This link points the console at a different server:\n\n${url}\n\n` +
      `Only continue if you recognise it. Your saved API key will not be sent there.`,
  );
}

/** The server this console is pointed at, without a trailing slash. */
export function resolveApiUrl(): string {
  const resolved = readBaseUrlOverride() ?? sameOriginApiBase();
  return resolved.replace(/\/+$/, "");
}

/** Point the console at a different server (or, with `undefined`, back at its own origin). */
export function setApiUrl(url: string | undefined): void {
  if (url === undefined || url === "") window.localStorage.removeItem(BASE_URL_STORAGE_KEY);
  else window.localStorage.setItem(BASE_URL_STORAGE_KEY, url);
}

/**
 * An API key for servers running with custom `auth`. Held in localStorage rather than a cookie because
 * the console is a static bundle with no server of its own to set one.
 *
 * **Bound to the server it was entered for.** A key is a credential, and the target is settable from a
 * URL (`?baseUrl=`) — so without this binding, one crafted link would make the console post the key to
 * an attacker's origin on load. Storing the owner alongside the key means a mismatched target simply
 * gets no key: the request goes out unauthenticated and fails, which is the correct outcome.
 */
export function resolveApiKey(): string | undefined {
  const key = window.localStorage.getItem(API_KEY_STORAGE_KEY);
  if (key === null || key === "") return undefined;
  const owner = window.localStorage.getItem(API_KEY_OWNER_STORAGE_KEY);
  return owner !== null && owner === resolveApiUrl() ? key : undefined;
}

export function setApiKey(key: string | undefined): void {
  if (key === undefined || key === "") {
    window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    window.localStorage.removeItem(API_KEY_OWNER_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(API_KEY_STORAGE_KEY, key);
  // Whichever server is current when the key is entered is the one it belongs to.
  window.localStorage.setItem(API_KEY_OWNER_STORAGE_KEY, resolveApiUrl());
}

/**
 * The real `@langchain/langgraph-sdk` client — deliberately, rather than a hand-rolled fetch layer.
 * The console is meant to be pressure on the wire contract: if the SDK cannot express a view, that is
 * a gap in the server, and we want to feel it here rather than paper over it with a bespoke request.
 */
export function createConsoleClient(): Client {
  const apiKey = resolveApiKey();
  return new Client({ apiUrl: resolveApiUrl(), ...(apiKey ? { apiKey } : {}) });
}

/** `GET /info` — the capability handshake. The SDK exposes no accessor for it, so: a plain fetch. */
export interface ServerInfo {
  version?: string;
  flags?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function fetchServerInfo(signal?: AbortSignal): Promise<ServerInfo> {
  const apiKey = resolveApiKey();
  const response = await fetch(`${resolveApiUrl()}/info`, {
    headers: apiKey ? { "x-api-key": apiKey } : {},
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`GET /info failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as ServerInfo;
}
