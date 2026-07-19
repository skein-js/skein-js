// Auth applied through the transport-neutral handler table: authentication (401), studio bypass,
// per-resource authorization (403), cross-user isolation (owner-scoped reads hide as 404, writes
// stamp ownership), and — the subtle one — background-run cancellation still working when the
// per-request store is swapped but the cancellation registry is shared.

import {
  SkeinHttpError,
  isSkeinHttpError,
  type AuthEngine,
  type AuthFilters,
} from "@skein-js/core";
import { MemorySkeinStore } from "@skein-js/storage-memory";
import { beforeEach, describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import type { ProtocolRequest } from "../create-handlers.js";
import { createProtocolRuntime, type ProtocolRuntime } from "../runtime.js";

interface FakeEngineOptions {
  studioAuthDisabled?: boolean;
  deny?: (resource: string, action: string) => boolean;
  /** The filter an on-handler returns for the caller; defaults to `{ owner: identity }`. */
  filterFor?: (identity: string) => AuthFilters;
}

/** An engine that reads the caller from an `x-user` header and scopes every resource by `owner`. */
function fakeEngine(options: FakeEngineOptions = {}): AuthEngine {
  const filterFor = options.filterFor ?? ((identity: string) => ({ owner: identity }));
  return {
    enabled: true,
    studioAuthDisabled: options.studioAuthDisabled ?? false,
    authenticate: async (request) => {
      const identity = request.headers.get("x-user");
      if (!identity) throw SkeinHttpError.unauthorized("missing credentials");
      return {
        user: { identity, display_name: identity, is_authenticated: true, permissions: [] },
        scopes: [],
      };
    },
    authorize: async ({ resource, action, value, context }) => {
      if (options.deny?.(resource, action)) throw SkeinHttpError.forbidden("denied");
      if (!context) return { filters: undefined, value };
      return { filters: filterFor(context.user.identity), value };
    },
    matchesFilters: (metadata, filters) => {
      if (!filters) return true;
      return Object.entries(filters).every(([key, clause]) => {
        const actual = metadata?.[key];
        if (typeof clause === "string") return actual === clause;
        if (typeof clause === "object" && typeof clause.$eq === "string")
          return actual === clause.$eq;
        if (typeof clause === "object" && clause.$contains !== undefined) {
          const required = Array.isArray(clause.$contains) ? clause.$contains : [clause.$contains];
          return Array.isArray(actual) && required.every((member) => actual.includes(member));
        }
        return true;
      });
    },
  };
}

/** A `ProtocolRequest` with sane defaults; `headers.x-user` selects the caller. */
function makeReq(overrides: Partial<ProtocolRequest> = {}): ProtocolRequest {
  return {
    method: "GET",
    url: "http://localhost:2024/",
    params: {},
    query: {},
    body: undefined,
    headers: {},
    ...overrides,
  };
}

const asUser = (identity: string, overrides: Partial<ProtocolRequest> = {}): ProtocolRequest =>
  makeReq({ ...overrides, headers: { "x-user": identity, ...overrides.headers } });

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => isSkeinHttpError(error) && error.status === status,
  );
}

describe("authorizing handlers", () => {
  let runtime: ProtocolRuntime;

  beforeEach(async () => {
    runtime = createProtocolRuntime(createFixtureDeps({ auth: fakeEngine() }));
    await runtime.service.assistants.registerGraphAssistants();
  });

  it("rejects a request with no credentials as 401", async () => {
    await expectStatus(runtime.handlers.createThread(makeReq({ method: "POST", body: {} })), 401);
  });

  it("stamps the owner onto a created thread", async () => {
    const response = await runtime.handlers.createThread(
      asUser("alice", { method: "POST", body: {} }),
    );
    const thread = (response as { body: { metadata: Record<string, unknown> } }).body;
    expect(thread.metadata.owner).toBe("alice");
  });

  it("hides another user's thread as 404 on read, patch, and delete", async () => {
    const created = await runtime.handlers.createThread(
      asUser("alice", { method: "POST", body: {} }),
    );
    const threadId = (created as { body: { thread_id: string } }).body.thread_id;

    const asBob = (overrides: Partial<ProtocolRequest>) =>
      asUser("bob", { params: { thread_id: threadId }, ...overrides });

    await expectStatus(runtime.handlers.getThread(asBob({})), 404);
    await expectStatus(runtime.handlers.patchThread(asBob({ method: "PATCH", body: {} })), 404);
    await expectStatus(runtime.handlers.deleteThread(asBob({ method: "DELETE" })), 404);

    // The owner still reaches it.
    const own = await runtime.handlers.getThread(
      asUser("alice", { params: { thread_id: threadId } }),
    );
    expect((own as { body: { thread_id: string } }).body.thread_id).toBe(threadId);
  });

  it("lists only the caller's own threads", async () => {
    await runtime.handlers.createThread(asUser("alice", { method: "POST", body: {} }));
    await runtime.handlers.createThread(asUser("alice", { method: "POST", body: {} }));
    await runtime.handlers.createThread(asUser("bob", { method: "POST", body: {} }));

    const listed = await runtime.handlers.listThreads(
      asUser("alice", { method: "POST", body: {} }),
    );
    const threads = (listed as { body: { metadata: Record<string, unknown> }[] }).body;
    expect(threads).toHaveLength(2);
    expect(threads.every((thread) => thread.metadata.owner === "alice")).toBe(true);
  });

  it("denies with 403 when an on-handler refuses the action", async () => {
    const denying = createProtocolRuntime(
      createFixtureDeps({ auth: fakeEngine({ deny: (_r, action) => action === "delete" }) }),
    );
    const created = await denying.handlers.createThread(
      asUser("alice", { method: "POST", body: {} }),
    );
    const threadId = (created as { body: { thread_id: string } }).body.thread_id;
    await expectStatus(
      denying.handlers.deleteThread(
        asUser("alice", { method: "DELETE", params: { thread_id: threadId } }),
      ),
      403,
    );
  });

  it("denies a read-only principal from forking state (updateThreadState is a write)", async () => {
    const denying = createProtocolRuntime(
      createFixtureDeps({ auth: fakeEngine({ deny: (_r, action) => action === "update" }) }),
    );
    const created = await denying.handlers.createThread(
      asUser("alice", { method: "POST", body: {} }),
    );
    const threadId = (created as { body: { thread_id: string } }).body.thread_id;

    // A state fork maps to the `update` action, so the update-denying principal is refused.
    await expectStatus(
      denying.handlers.updateThreadState(
        asUser("alice", { method: "POST", params: { thread_id: threadId }, body: { values: {} } }),
      ),
      403,
    );
    // Reading state at a checkpoint is a `read` action — not denied by the update-only ban.
    const read = await denying.handlers.getThreadStateAtCheckpoint(
      asUser("alice", { params: { thread_id: threadId, checkpoint_id: "c1" } }),
    );
    expect((read as { body: unknown }).body).toBeDefined();
  });

  it("hides another user's thread state and blocks forking it as 404", async () => {
    const created = await runtime.handlers.createThread(
      asUser("alice", { method: "POST", body: {} }),
    );
    const threadId = (created as { body: { thread_id: string } }).body.thread_id;

    await expectStatus(
      runtime.handlers.getThreadStateAtCheckpoint(
        asUser("bob", { params: { thread_id: threadId, checkpoint_id: "c1" } }),
      ),
      404,
    );
    await expectStatus(
      runtime.handlers.updateThreadState(
        asUser("bob", { method: "POST", params: { thread_id: threadId }, body: { values: {} } }),
      ),
      404,
    );
  });

  describe("studio auth", () => {
    it("admits studio traffic without credentials when studio auth is enabled", async () => {
      const created = await runtime.handlers.createThread(
        makeReq({ method: "POST", body: {}, headers: { "x-auth-scheme": "langsmith" } }),
      );
      expect((created as { body: { metadata: Record<string, unknown> } }).body.metadata.owner).toBe(
        "langgraph-studio-user",
      );
    });

    it("requires real credentials for studio traffic when studio auth is disabled", async () => {
      const strict = createProtocolRuntime(
        createFixtureDeps({ auth: fakeEngine({ studioAuthDisabled: true }) }),
      );
      await expectStatus(
        strict.handlers.createThread(
          makeReq({ method: "POST", body: {}, headers: { "x-auth-scheme": "langsmith" } }),
        ),
        401,
      );
    });
  });

  // The authenticated caller (with any custom fields) must survive into the run's stored kwargs so
  // the run engine can inject `configurable.langgraph_auth_user`, matching LangGraph Platform. Kwargs
  // are stored at creation (before any worker runs), so we inspect the underlying store directly.
  describe("principal injection", () => {
    // Own the store so we can read back the stored kwargs; the auth wrapper only swaps it per request.
    const store = new MemorySkeinStore();
    const withAuth = async (auth: AuthEngine) => {
      const runtime = createProtocolRuntime(createFixtureDeps({ store, auth }));
      await runtime.service.assistants.registerGraphAssistants();
      return runtime;
    };
    const startBackgroundRun = async (runtime: ProtocolRuntime, req: ProtocolRequest) => {
      const created = await runtime.handlers.createThread({ ...req, method: "POST", body: {} });
      const threadId = (created as { body: { thread_id: string } }).body.thread_id;
      const started = await runtime.handlers.createBackgroundRun({
        ...req,
        method: "POST",
        params: { thread_id: threadId },
        body: { assistant_id: "echo", input: {} },
      });
      const runId = (started as { body: { run_id: string } }).body.run_id;
      return store.runs.getKwargs(runId);
    };

    it("stamps the caller (with custom fields) onto run kwargs on the owner-scoped path", async () => {
      const engine: AuthEngine = {
        ...fakeEngine(),
        authenticate: async (request) => {
          const identity = request.headers.get("x-user");
          if (!identity) throw SkeinHttpError.unauthorized("missing credentials");
          return {
            user: {
              identity,
              display_name: identity,
              is_authenticated: true,
              permissions: [],
              workspaceId: "ws-1",
            },
            scopes: [],
          };
        },
      };
      const kwargs = await startBackgroundRun(await withAuth(engine), asUser("alice"));
      expect(kwargs?.auth_user?.identity).toBe("alice");
      expect(kwargs?.auth_user?.["workspaceId"]).toBe("ws-1");
    });

    it("stamps the caller even when authorization returns no ownership filters", async () => {
      const openEngine: AuthEngine = {
        ...fakeEngine(),
        authorize: async ({ value }) => ({ filters: undefined, value }),
      };
      const kwargs = await startBackgroundRun(await withAuth(openEngine), asUser("bob"));
      expect(kwargs?.auth_user?.identity).toBe("bob");
    });

    it("stamps the synthetic studio user for studio traffic", async () => {
      const kwargs = await startBackgroundRun(
        await withAuth(fakeEngine()),
        makeReq({ headers: { "x-auth-scheme": "langsmith" } }),
      );
      expect(kwargs?.auth_user?.identity).toBe("langgraph-studio-user");
    });
  });

  it("cancels an owned background run — shared cancellation registry survives the store swap", async () => {
    const created = await runtime.handlers.createThread(
      asUser("alice", { method: "POST", body: {} }),
    );
    const threadId = (created as { body: { thread_id: string } }).body.thread_id;

    const started = await runtime.handlers.createBackgroundRun(
      asUser("alice", {
        method: "POST",
        params: { thread_id: threadId },
        body: { assistant_id: "echo", input: {} },
      }),
    );
    const run = (started as { body: { run_id: string; metadata: Record<string, unknown> } }).body;
    expect(run.metadata.owner).toBe("alice");

    // A different user cannot see the run.
    await expectStatus(
      runtime.handlers.getRun(
        asUser("bob", { params: { thread_id: threadId, run_id: run.run_id } }),
      ),
      404,
    );

    const cancelled = await runtime.handlers.cancelRun(
      asUser("alice", { method: "POST", params: { thread_id: threadId, run_id: run.run_id } }),
    );
    expect((cancelled as { body: { status: string } }).body.status).toBe("cancelled");
  });

  it("does not let a wait/stream run hijack another user's thread via a supplied thread_id", async () => {
    const created = await runtime.handlers.createThread(
      asUser("alice", { method: "POST", body: {} }),
    );
    const aliceThreadId = (created as { body: { thread_id: string } }).body.thread_id;

    // Bob runs against Alice's thread_id (the thread-scoped `/threads/{id}/runs/wait` path folds the
    // id into the body). The scoped store hides Alice's thread, so `ensureThread` must NOT recreate it
    // under Bob — it must 404 rather than clobber (memory) or re-own the thread.
    await expectStatus(
      runtime.handlers.createWaitRun(
        asUser("bob", {
          method: "POST",
          params: { thread_id: aliceThreadId },
          body: { assistant_id: "echo", thread_id: aliceThreadId, input: {} },
        }),
      ),
      404,
    );

    // Alice's thread is untouched: still hers, still readable by her.
    const stillHers = await runtime.handlers.getThread(
      asUser("alice", { params: { thread_id: aliceThreadId } }),
    );
    expect((stillHers as { body: { metadata: Record<string, unknown> } }).body.metadata.owner).toBe(
      "alice",
    );
  });

  it("stamps a `$contains` ownership filter so the creator can read their own new thread", async () => {
    const membership = createProtocolRuntime(
      createFixtureDeps({
        auth: fakeEngine({ filterFor: (identity) => ({ readers: { $contains: identity } }) }),
      }),
    );
    const created = await membership.handlers.createThread(
      asUser("alice", { method: "POST", body: {} }),
    );
    const thread = (created as { body: { thread_id: string; metadata: Record<string, unknown> } })
      .body;
    expect(thread.metadata.readers).toEqual(["alice"]);

    // The creator immediately reads it back (before the fix, the un-stamped thread was hidden → 404).
    const readBack = await membership.handlers.getThread(
      asUser("alice", { params: { thread_id: thread.thread_id } }),
    );
    expect((readBack as { body: { thread_id: string } }).body.thread_id).toBe(thread.thread_id);
  });
});
