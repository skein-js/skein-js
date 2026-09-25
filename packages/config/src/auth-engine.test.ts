import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth";
import { isSkeinHttpError } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { loadAuthEngine } from "./auth-engine.js";
import { SkeinConfigError } from "./errors.js";

/** Load an engine from an in-memory module, bypassing the filesystem via the importer seam. */
function engineFor(auth: unknown, options: { disableStudioAuth?: boolean } = {}) {
  return loadAuthEngine(
    { path: "./auth.ts:auth", disable_studio_auth: options.disableStudioAuth },
    { configDir: "/app", importModule: () => Promise.resolve({ auth }) },
  );
}

describe("loadAuthEngine", () => {
  it("returns undefined when no auth block is configured", async () => {
    expect(await loadAuthEngine(undefined, { configDir: "/app" })).toBeUndefined();
  });

  it("rejects an export that is not an Auth instance", async () => {
    await expect(engineFor({ not: "an auth" })).rejects.toBeInstanceOf(SkeinConfigError);
  });

  it("normalizes a string identity to a full user", async () => {
    const auth = new Auth().authenticate(() => "user-1");
    const engine = await engineFor(auth);
    const context = await engine!.authenticate(new Request("http://x/threads"));
    expect(context).toEqual({
      user: {
        identity: "user-1",
        display_name: "user-1",
        is_authenticated: true,
        permissions: [],
      },
      scopes: [],
    });
  });

  it("normalizes an object identity and carries permissions as scopes", async () => {
    const auth = new Auth().authenticate(() => ({ identity: "u2", permissions: ["read"] }));
    const engine = await engineFor(auth);
    const context = await engine!.authenticate(new Request("http://x/threads"));
    expect(context?.scopes).toEqual(["read"]);
    expect(context?.user.identity).toBe("u2");
    expect(context?.user.is_authenticated).toBe(true);
  });

  it("converts a thrown HTTPException into a SkeinHttpError with its status", async () => {
    const auth = new Auth().authenticate(() => {
      throw new HTTPException(401, { message: "no key" });
    });
    const engine = await engineFor(auth);
    await expect(engine!.authenticate(new Request("http://x/threads"))).rejects.toSatisfy(
      (error: unknown) => isSkeinHttpError(error) && error.status === 401,
    );
  });

  it("returns no user when the Auth has no authenticate handler", async () => {
    const auth = new Auth().on("threads:create", () => ({ owner: "u" }));
    const engine = await engineFor(auth);
    expect(await engine!.authenticate(new Request("http://x/threads"))).toBeUndefined();
  });

  const userContext = {
    user: { identity: "u", display_name: "u", is_authenticated: true, permissions: [] },
    scopes: [],
  };

  it("returns a filter from a matching on-handler", async () => {
    const auth = new Auth().authenticate(() => "u").on("threads:create", () => ({ owner: "u" }));
    const engine = await engineFor(auth);
    const result = await engine!.authorize({
      resource: "threads",
      action: "create",
      value: {},
      context: userContext,
    });
    expect(result.filters).toEqual({ owner: "u" });
  });

  it("denies with 403 when an on-handler returns false", async () => {
    const auth = new Auth().authenticate(() => "u").on("threads:delete", () => false);
    const engine = await engineFor(auth);
    await expect(
      engine!.authorize({ resource: "threads", action: "delete", value: {}, context: userContext }),
    ).rejects.toSatisfy((error: unknown) => isSkeinHttpError(error) && error.status === 403);
  });

  it("prefers the exact resource:action handler over a broader one", async () => {
    const auth = new Auth()
      .authenticate(() => "u")
      .on("*", () => ({ scope: "wildcard" }))
      .on("threads", () => ({ scope: "resource" }))
      .on("threads:create", () => ({ scope: "exact" }));
    const engine = await engineFor(auth);
    const result = await engine!.authorize({
      resource: "threads",
      action: "create",
      value: {},
      context: userContext,
    });
    expect(result.filters).toEqual({ scope: "exact" });
  });

  it("allows (no filters) when no handler matches or there is no user", async () => {
    const auth = new Auth().authenticate(() => "u").on("store:put", () => ({ owner: "u" }));
    const engine = await engineFor(auth);
    const noHandler = await engine!.authorize({
      resource: "threads",
      action: "read",
      value: {},
      context: userContext,
    });
    expect(noHandler.filters).toBeUndefined();
    const noUser = await engine!.authorize({
      resource: "store",
      action: "put",
      value: {},
      context: undefined,
    });
    expect(noUser.filters).toBeUndefined();
  });

  it("matches metadata against filters with $eq/$contains semantics", async () => {
    const engine = await engineFor(new Auth().authenticate(() => "u"));
    expect(engine!.matchesFilters({ owner: "u" }, { owner: "u" })).toBe(true);
    expect(engine!.matchesFilters({ owner: "other" }, { owner: "u" })).toBe(false);
    expect(engine!.matchesFilters(undefined, undefined)).toBe(true);
    expect(engine!.matchesFilters({ tags: ["a", "b"] }, { tags: { $contains: "a" } })).toBe(true);
    expect(engine!.matchesFilters({ tags: ["a"] }, { tags: { $contains: "z" } })).toBe(false);
  });

  it("carries the disable_studio_auth flag onto the engine", async () => {
    const auth = new Auth().authenticate(() => "u");
    expect((await engineFor(auth, { disableStudioAuth: true }))!.studioAuthDisabled).toBe(true);
    expect((await engineFor(auth, { disableStudioAuth: false }))!.studioAuthDisabled).toBe(false);
    expect((await engineFor(auth))!.studioAuthDisabled).toBe(true);
  });
});
