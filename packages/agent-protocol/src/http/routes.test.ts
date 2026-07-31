import { describe, expect, it } from "vitest";

import { ROUTE_AUTHZ } from "../auth/route-authz.js";
import type { ProtocolRequest } from "../create-handlers.js";

import {
  copyThreadIdIntoBody,
  createRouteMatcher,
  filterSkeinRoutes,
  foldThreadId,
  matchSkeinRoute,
  skeinRoutes,
} from "./routes.js";

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

describe("the route table itself", () => {
  it("classifies every route into a group, so nothing escapes the http.disable_* flags", () => {
    // A missing `group` is silently un-disableable, and the omission would only show up as a resource
    // a user could not turn off. Every handler in the table is also in ROUTE_AUTHZ, so the two views of
    // the surface stay in step.
    for (const binding of skeinRoutes) {
      expect(binding.group, `${binding.method} ${binding.path} has no group`).toBeDefined();
      expect(ROUTE_AUTHZ[binding.handler], `${binding.handler} has no authz entry`).toBeDefined();
    }
  });

  it("groups the thread-scoped run and streaming paths under runs, as LangGraph does", () => {
    // Grouped by resource *family*, not by path prefix: LangGraph serves `/threads/:id/runs*` and the
    // thread-centric streaming surface from its runs module, so `disable_runs` takes them there too.
    const groupOf = (method: string, path: string) =>
      skeinRoutes.find((binding) => binding.method === method && binding.path === path)?.group;

    expect(groupOf("post", "/threads/:thread_id/runs")).toBe("runs");
    expect(groupOf("post", "/threads/:thread_id/stream")).toBe("runs");
    expect(groupOf("post", "/threads/:thread_id/history")).toBe("threads");
    expect(groupOf("get", "/info")).toBe("meta");
  });
});

describe("filterSkeinRoutes", () => {
  it("removes only the disabled group's routes", () => {
    const filtered = filterSkeinRoutes(skeinRoutes, { store: true });

    expect(filtered.some((binding) => binding.group === "store")).toBe(false);
    // Everything else survives untouched.
    expect(filtered.length).toBe(skeinRoutes.filter((b) => b.group !== "store").length);
    expect(filtered.some((binding) => binding.group === "threads")).toBe(true);
  });

  it("returns the same array when nothing is disabled, so a matcher can be cached on identity", () => {
    // `routeMatcherFor` keys a WeakMap on the table's identity; a fresh copy per call would recompile
    // every route's regex on every request.
    expect(filterSkeinRoutes(skeinRoutes, {})).toBe(skeinRoutes);
    expect(filterSkeinRoutes(skeinRoutes, { store: false })).toBe(skeinRoutes);
  });

  it("makes a disabled route simply not match, so the host app answers instead", () => {
    const match = createRouteMatcher(filterSkeinRoutes(skeinRoutes, { runs: true }));

    expect(match("post", "/threads/t-1/runs")).toBeUndefined();
    expect(match("post", "/runs/wait")).toBeUndefined();
    // The threads resource is untouched by disable_runs.
    expect(match("get", "/threads/t-1")?.binding.handler).toBe("getThread");
  });

  it("can disable several groups at once", () => {
    const match = createRouteMatcher(
      filterSkeinRoutes(skeinRoutes, { assistants: true, meta: true }),
    );

    expect(match("get", "/info")).toBeUndefined();
    expect(match("post", "/assistants/search")).toBeUndefined();
    expect(match("post", "/threads/search")?.binding.handler).toBe("listThreads");
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

  it("routes POST /threads/:id/state/checkpoint to the body-shaped read, not the id-shaped one", () => {
    // The literal `checkpoint` segment must not be captured as a `:checkpoint_id`. It cannot be here —
    // that route is a GET — but the two live one path apart, so the distinction is worth pinning.
    const match = matchSkeinRoute("post", "/threads/t-1/state/checkpoint");
    expect(match?.binding.handler).toBe("getThreadStateAtCheckpointFromBody");
    expect(match?.params).toEqual({ thread_id: "t-1" });
  });
});

describe("matchSkeinRoute — routes the official SDK calls", () => {
  it("routes GET /threads/:id/runs/:id/join to the blocking join, not getRun", () => {
    const match = matchSkeinRoute("get", "/threads/t-1/runs/r-1/join");
    expect(match?.binding.handler).toBe("joinRun");
    expect(match?.params).toEqual({ thread_id: "t-1", run_id: "r-1" });
  });

  it("keeps the blocking join and the SSE join on separate handlers", () => {
    expect(matchSkeinRoute("get", "/threads/t-1/runs/r-1/stream")?.binding.handler).toBe(
      "joinRunStream",
    );
    // The bare run read must not swallow either of the two nested paths.
    expect(matchSkeinRoute("get", "/threads/t-1/runs/r-1")?.binding.handler).toBe("getRun");
  });

  it("serves GET /threads/:id/stream/events as a synonym for the join stream", () => {
    expect(matchSkeinRoute("get", "/threads/t-1/stream/events")?.binding.handler).toBe(
      "getThreadStream",
    );
    expect(matchSkeinRoute("get", "/threads/t-1/stream/events")?.params).toEqual({
      thread_id: "t-1",
    });
  });

  it("does NOT alias POST /stream/events onto the run-creating thread stream", () => {
    // The v2 transport POSTs a *subscription* there and reopens it on every reconnect, while
    // `postThreadStream` starts a run — aliasing them would turn one subscribe into several runs.
    expect(matchSkeinRoute("post", "/threads/t-1/stream/events")).toBeUndefined();
  });

  it("serves thread history on both verbs", () => {
    expect(matchSkeinRoute("post", "/threads/t-1/history")?.binding.handler).toBe(
      "getThreadHistory",
    );
    expect(matchSkeinRoute("get", "/threads/t-1/history")?.binding.handler).toBe(
      "getThreadHistory",
    );
  });

  it("keeps every new route inside a disable_* group", () => {
    // Same guarantee the table-wide test makes, asserted where a hand-added binding would most likely
    // forget it: `/stream/events` is a runs route, `/state/checkpoint` and `/history` are threads.
    const groupOf = (method: string, path: string) =>
      skeinRoutes.find((binding) => binding.method === method && binding.path === path)?.group;

    expect(groupOf("get", "/threads/:thread_id/runs/:run_id/join")).toBe("runs");
    expect(groupOf("get", "/threads/:thread_id/stream/events")).toBe("runs");
    expect(groupOf("post", "/threads/:thread_id/state/checkpoint")).toBe("threads");
    expect(groupOf("get", "/threads/:thread_id/history")).toBe("threads");
  });
});
