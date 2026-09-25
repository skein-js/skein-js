import { SkeinHttpError, type AuthEngine } from "@skein-js/core";
import { describe, expect, it, vi } from "vitest";

import {
  createDevUiAccessKeys,
  DEV_UI_KEY_GRACE_MS,
  devUiAccessEnabled,
  isLoopbackHost,
  requireStudioCredentials,
  withDevUiAccessKey,
} from "./dev-ui-auth.js";

function strictEngine(): AuthEngine {
  return {
    enabled: true,
    studioAuthDisabled: false,
    authenticate: vi.fn(async () => {
      throw SkeinHttpError.unauthorized("credentials required");
    }),
    authorize: vi.fn(async ({ value, context }) => ({
      value,
      filters: context ? { owner: context.user.identity } : undefined,
    })),
    matchesFilters: () => true,
  };
}

describe("development UI access", () => {
  it("accepts the CLI flag or the langgraph.json setting", () => {
    expect(devUiAccessEnabled()).toBe(false);
    expect(devUiAccessEnabled(false, false)).toBe(false);
    expect(devUiAccessEnabled(true, false)).toBe(true);
    expect(devUiAccessEnabled(false, true)).toBe(true);
  });

  it("generates a fresh, high-entropy key", () => {
    const first = createDevUiAccessKeys().currentKey;
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createDevUiAccessKeys().currentKey).not.toBe(first);
  });

  it("accepts only the exact key and still runs authorization as the dev UI principal", async () => {
    const original = strictEngine();
    const keys = createDevUiAccessKeys();
    const engine = withDevUiAccessKey(original, keys);
    const context = await engine.authenticate(
      new Request("http://localhost/threads", { headers: { "x-api-key": keys.currentKey } }),
    );
    expect(context?.user.identity).toBe("skein-dev-ui-user");
    expect(original.authenticate).not.toHaveBeenCalled();
    expect(
      await engine.authorize({ resource: "threads", action: "create", value: {}, context }),
    ).toEqual({ value: {}, filters: { owner: "skein-dev-ui-user" } });
    await expect(
      engine.authenticate(
        new Request("http://localhost/threads", { headers: { "x-api-key": "wrong-key" } }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("forces real credentials for the legacy Studio header", () => {
    expect(requireStudioCredentials(strictEngine()).studioAuthDisabled).toBe(true);
    expect(withDevUiAccessKey(strictEngine(), createDevUiAccessKeys()).studioAuthDisabled).toBe(
      true,
    );
  });

  it("rotates the key and expires the previous key after a one-minute grace period", () => {
    let clock = 0;
    const keys = createDevUiAccessKeys(() => clock);
    const first = keys.currentKey;
    const second = keys.rotate();
    expect(second).not.toBe(first);
    expect(keys.matches(first)).toBe(true);
    clock = DEV_UI_KEY_GRACE_MS;
    expect(keys.matches(first)).toBe(false);
    expect(keys.matches(second)).toBe(true);
  });

  it("allows the dev key only on a loopback listener", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.2")).toBe(false);
  });
});
