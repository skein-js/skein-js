// A temporary development credential for the console and LangGraph Studio. A caller-controlled
// header such as `x-auth-scheme` cannot identify a UI securely; possession of this random key can.

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { AuthContext, AuthEngine } from "@skein-js/core";

function devUiContext(): AuthContext {
  return {
    user: {
      identity: "skein-dev-ui-user",
      display_name: "skein-dev-ui-user",
      is_authenticated: true,
      permissions: [],
    },
    scopes: [],
  };
}

export const DEV_UI_KEY_ROTATION_MS = 15 * 60 * 1000;
export const DEV_UI_KEY_GRACE_MS = 60 * 1000;

/** The CLI flag can enable the key for one run; config makes it the project's dev default. */
export function devUiAccessEnabled(cliFlag?: boolean, configFlag?: boolean): boolean {
  return cliFlag === true || configFlag === true;
}

function createDevUiAccessKey(): string {
  return randomBytes(32).toString("base64url");
}

function matchesKey(candidate: string, expectedKey: string): boolean {
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(expectedKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface DevUiAccessKeys {
  readonly currentKey: string;
  rotate(): string;
  matches(candidate: string): boolean;
}

export function createDevUiAccessKeys(now: () => number = Date.now): DevUiAccessKeys {
  let currentKey = createDevUiAccessKey();
  let previousKey: string | undefined;
  let previousExpiresAt = 0;
  return {
    get currentKey() {
      return currentKey;
    },
    rotate() {
      previousKey = currentKey;
      previousExpiresAt = now() + DEV_UI_KEY_GRACE_MS;
      currentKey = createDevUiAccessKey();
      return currentKey;
    },
    matches(candidate) {
      return (
        matchesKey(candidate, currentKey) ||
        (previousKey !== undefined &&
          now() < previousExpiresAt &&
          matchesKey(candidate, previousKey))
      );
    },
  };
}

/** The key replaces only authentication; normal `@auth.on.*` authorization still applies. */
export function withDevUiAccessKey(engine: AuthEngine, keys: DevUiAccessKeys): AuthEngine {
  return {
    ...engine,
    // Reject the legacy Studio header bypass, so Studio uses the same key as the console.
    studioAuthDisabled: true,
    async authenticate(request) {
      const candidate = request.headers.get("x-api-key");
      if (candidate !== null && keys.matches(candidate)) return devUiContext();
      return engine.authenticate(request);
    },
  };
}

/** The CLI never trusts Studio's self-declared header, including on production startup. */
export function requireStudioCredentials(engine: AuthEngine): AuthEngine {
  return { ...engine, studioAuthDisabled: true };
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
