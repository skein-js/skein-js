// Unit tests for the shared mount-prefix strip. The normalization cases are the load-bearing ones:
// NestJS's `setGlobalPrefix` stores whatever the host passed ("api", "/api/"), so a strip that only
// understood a canonical "/api" would silently pass every protocol path through as "not ours".

import { describe, expect, it } from "vitest";

import { stripBasePath } from "./base-path.js";

describe("stripBasePath", () => {
  it("passes the pathname through when nothing is mounted", () => {
    expect(stripBasePath("/threads", "")).toBe("/threads");
    expect(stripBasePath("/threads", "/")).toBe("/threads");
  });

  it("strips the prefix from a nested path", () => {
    expect(stripBasePath("/api/threads", "/api")).toBe("/threads");
    expect(stripBasePath("/api/threads/abc/runs", "/api")).toBe("/threads/abc/runs");
  });

  it("maps the bare mount root to `/`", () => {
    expect(stripBasePath("/api", "/api")).toBe("/");
  });

  it("returns null for a path outside the mount, so the caller passes it through", () => {
    expect(stripBasePath("/threads", "/api")).toBeNull();
    expect(stripBasePath("/other/threads", "/api")).toBeNull();
  });

  it("does not strip a prefix that is only a string-prefix of the segment", () => {
    // `/apifoo` starts with `/api` textually but is a different first segment.
    expect(stripBasePath("/apifoo", "/api")).toBeNull();
    expect(stripBasePath("/apifoo/threads", "/api")).toBeNull();
  });

  it("normalizes a prefix written without a leading slash", () => {
    // What `app.setGlobalPrefix("api")` actually stores.
    expect(stripBasePath("/api/threads", "api")).toBe("/threads");
  });

  it("normalizes a prefix written with a trailing slash", () => {
    expect(stripBasePath("/api/threads", "/api/")).toBe("/threads");
    expect(stripBasePath("/api/threads", "api/")).toBe("/threads");
  });

  it("normalizes a prefix with repeated trailing slashes", () => {
    // Stripping only one would leave `/api/`, which matches nothing and 404s every protocol path.
    expect(stripBasePath("/api/threads", "/api//")).toBe("/threads");
    expect(stripBasePath("/api/threads", "api///")).toBe("/threads");
  });

  it("fails closed on a whitespace-only prefix rather than serving at the root", () => {
    // A stray space in a config value must not silently mount the whole protocol at `/`.
    expect(stripBasePath("/api/threads", " ")).toBeNull();
    expect(stripBasePath("/threads", " ")).toBeNull();
  });

  it("strips a multi-segment prefix", () => {
    expect(stripBasePath("/api/v1/threads", "/api/v1")).toBe("/threads");
    expect(stripBasePath("/api/v1", "/api/v1")).toBe("/");
    expect(stripBasePath("/api/v2/threads", "/api/v1")).toBeNull();
  });
});
