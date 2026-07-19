import { describe, expect, it } from "vitest";

import type { ProtocolRequest } from "../create-handlers.js";

import { copyThreadIdIntoBody, foldThreadId, matchSkeinRoute } from "./routes.js";

function request(overrides: Partial<ProtocolRequest> = {}): ProtocolRequest {
  return {
    method: "post",
    url: "http://localhost/threads/t-1/runs/stream",
    params: {},
    query: {},
    body: {},
    headers: {},
    ...overrides,
  };
}

describe("copyThreadIdIntoBody", () => {
  it("copies the path thread_id into an object body, preserving existing fields", () => {
    const folded = copyThreadIdIntoBody(
      request({ params: { thread_id: "t-1" }, body: { assistant_id: "a-1" } }),
    );
    expect(folded.body).toEqual({ assistant_id: "a-1", thread_id: "t-1" });
  });

  it("replaces a non-object body (array/primitive) with a fresh { thread_id } object", () => {
    expect(
      copyThreadIdIntoBody(request({ params: { thread_id: "t-1" }, body: [1, 2] })).body,
    ).toEqual({ thread_id: "t-1" });
  });

  it("is a no-op (same request instance) when there is no thread_id param", () => {
    const req = request({ body: { assistant_id: "a-1" } });
    expect(copyThreadIdIntoBody(req)).toBe(req);
  });

  it("keeps the deprecated foldThreadId alias pointing at the same function", () => {
    expect(foldThreadId).toBe(copyThreadIdIntoBody);
  });
});

describe("matchSkeinRoute — time-travel state routes", () => {
  it("routes POST /threads/:id/state to updateThreadState", () => {
    const match = matchSkeinRoute("post", "/threads/t-1/state");
    expect(match?.binding.handler).toBe("updateThreadState");
    expect(match?.params).toEqual({ thread_id: "t-1" });
  });

  it("routes GET /threads/:id/state/:checkpoint_id to getThreadStateAtCheckpoint", () => {
    const match = matchSkeinRoute("get", "/threads/t-1/state/ckpt-9");
    expect(match?.binding.handler).toBe("getThreadStateAtCheckpoint");
    expect(match?.params).toEqual({ thread_id: "t-1", checkpoint_id: "ckpt-9" });
  });

  it("keeps GET /threads/:id/state (current tip) distinct from the checkpoint read", () => {
    const match = matchSkeinRoute("get", "/threads/t-1/state");
    expect(match?.binding.handler).toBe("getThreadState");
    expect(match?.params).toEqual({ thread_id: "t-1" });
  });
});
