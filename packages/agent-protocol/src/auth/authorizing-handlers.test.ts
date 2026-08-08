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

import { ROUTE_AUTHZ } from "./route-authz.js";

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

  it("serves GET /info unauthenticated, as @langchain/langgraph-api does", async () => {
    // Its auth middleware opens with an explicit `if (c.req.path === "/info") return next()`. `/info` is
    // a capability handshake — Studio and monitoring clients probe it *before* they have credentials — so
    // 401-ing it would break connecting to an auth-enabled skein server that `langgraph dev` answers.
    const response = await runtime.handlers.getServerInfo(
      makeReq({ method: "GET", body: undefined }),
    );

    expect(response.status).toBe(200);
    expect((response as { body: { context: string } }).body.context).toBe("js");
  });

  it("still guards every other handler when /info is exempt", async () => {
    // The exemption is one named handler, not a hole in the wrapper.
    await expectStatus(runtime.handlers.listThreads(makeReq({ method: "POST", body: {} })), 401);
    await expectStatus(
      runtime.handlers.searchAssistants(makeReq({ method: "POST", body: {} })),
      401,
    );
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

// A characterization test, not an endorsement: the `store` resource is gate-only, so an authenticated
// caller reads every tenant's items. Pinned in code because the shape of the exposure is easy to
// mis-describe — it is *not* about namespace wildcards. A wildcard matches one segment positionally, so
// `["memories","*"]` is a strict *subset* of what the shorter literal `["memories"]` already returns,
// and an omitted prefix returns everything. Refusing wildcards would therefore be capability loss with
// no security benefit, which is why there is no such guard.
//
// The fix is a deployment's own `@auth.on.store` handler, which can deny outright or rewrite the namespace
// it is handed — see the `@auth.on.store rewriting value` block below. skein ships no scoping mechanism of
// its own, because who owns which namespace is a policy only the deployment knows. So these expectations
// describe a deployment that registered *no* store handler, and they stay as they are.
describe("store reads are not tenant-scoped without a store handler", () => {
  const seed = async (target: ProtocolRuntime): Promise<void> => {
    for (const owner of ["alice", "bob"]) {
      await target.handlers.putStoreItem(
        asUser(owner, {
          method: "PUT",
          body: { namespace: ["memories", owner], key: "note", value: { text: `${owner}-secret` } },
        }),
      );
    }
  };

  const textsFor = async (target: ProtocolRuntime, body: unknown): Promise<string[]> => {
    const response = await target.handlers.searchStoreItems(
      asUser("alice", { method: "POST", body }),
    );
    const { items } = (response as { body: { items: { value: { text: string } }[] } }).body;
    return items.map((item) => item.value.text).sort();
  };

  it("lets one tenant read another's items by literal prefix, by wildcard, or by no prefix at all", async () => {
    const runtime = createProtocolRuntime(createFixtureDeps({ auth: fakeEngine() }));
    await seed(runtime);

    const both = ["alice-secret", "bob-secret"];
    expect(await textsFor(runtime, { namespace_prefix: ["memories"] })).toEqual(both);
    expect(await textsFor(runtime, { namespace_prefix: ["memories", "*"] })).toEqual(both);
    expect(await textsFor(runtime, {})).toEqual(both);

    // A full-depth literal prefix does narrow — which is why an `@auth.on.store` handler has to
    // *require* one rather than merely reject the shapes that look dangerous.
    expect(await textsFor(runtime, { namespace_prefix: ["memories", "alice"] })).toEqual([
      "alice-secret",
    ]);
  });

  it("returns every tenant's namespace names from listNamespaces", async () => {
    const runtime = createProtocolRuntime(createFixtureDeps({ auth: fakeEngine() }));
    await seed(runtime);

    const response = await runtime.handlers.listStoreNamespaces(
      asUser("alice", { method: "POST", body: {} }),
    );
    const { namespaces } = (response as { body: { namespaces: string[][] } }).body;

    expect(namespaces).toEqual([
      ["memories", "alice"],
      ["memories", "bob"],
    ]);
  });

  it("still lets an `@auth.on.store` handler deny, which is the available control", async () => {
    // The handler sees the namespace because `authValue` merges query + params + body. This is the
    // pattern docs/agent-protocol.md tells multi-tenant deployments to use.
    const gated = createProtocolRuntime(
      createFixtureDeps({ auth: fakeEngine({ deny: (resource) => resource === "store" }) }),
    );
    await expectStatus(
      gated.handlers.searchStoreItems(asUser("alice", { method: "POST", body: {} })),
      403,
    );
  });
});

// LangGraph documents store authorization as *rewriting* `value` rather than returning ownership filters —
// the store is the one resource whose scoping is namespace-shaped, so a metadata filter has nothing to match
// on. skein honours that mutation on both fields it derives (`namespace` and `key`), which is what a ported
// LangGraph auth module expects. Before this it was discarded: the handler ran, scoped nothing, and looked
// like it had.
describe("@auth.on.store rewriting value", () => {
  /** An engine whose store handler rewrites the namespace's first segment to the caller, as the docs show. */
  const rewriting = (
    mutate: (value: Record<string, unknown>, identity: string) => void,
  ): AuthEngine => ({
    ...fakeEngine(),
    authorize: async ({ resource, value, context }) => {
      if (resource === "store" && context)
        mutate(value as Record<string, unknown>, context.user.identity);
      return { filters: undefined, value };
    },
  });

  const rootedAtCaller = (value: Record<string, unknown>, identity: string) => {
    const namespace = Array.isArray(value["namespace"]) ? (value["namespace"] as string[]) : [];
    value["namespace"] = [identity, ...namespace.slice(1)];
  };

  it("writes to the namespace the handler chose, not the one the caller asked for", async () => {
    const runtime = createProtocolRuntime(createFixtureDeps({ auth: rewriting(rootedAtCaller) }));

    // Alice asks to write under `["bob","memories"]`; the handler reroutes her to her own root.
    await runtime.handlers.putStoreItem(
      asUser("alice", {
        method: "PUT",
        body: { namespace: ["bob", "memories"], key: "note", value: { text: "alice" } },
      }),
    );

    // Nothing landed under bob.
    expect(
      await runtime.service.store.get(["bob", "memories"], "note").catch(() => null),
    ).toBeNull();
    const own = await runtime.service.store.get(["alice", "memories"], "note");
    expect(own.value).toEqual({ text: "alice" });
  });

  it("reroutes a search prefix, so a caller cannot read another tenant's items", async () => {
    const runtime = createProtocolRuntime(createFixtureDeps({ auth: rewriting(rootedAtCaller) }));
    await runtime.service.store.put(["alice", "memories"], "a", { text: "alice" });
    await runtime.service.store.put(["bob", "memories"], "b", { text: "bob" });

    // Asking for bob's prefix; the handler rewrites the first segment to alice.
    const response = await runtime.handlers.searchStoreItems(
      asUser("alice", { method: "POST", body: { namespace_prefix: ["bob", "memories"] } }),
    );
    const { items } = (response as { body: { items: { value: { text: string } }[] } }).body;

    expect(items.map((item) => item.value.text)).toEqual(["alice"]);
  });

  it("reroutes a GET that used query params, by adding the body the endpoint prefers", async () => {
    // `storeItemTarget` reads a body namespace ahead of the query, so a rewrite lands even when the
    // caller addressed the item the query way.
    const runtime = createProtocolRuntime(createFixtureDeps({ auth: rewriting(rootedAtCaller) }));
    await runtime.service.store.put(["alice", "memories"], "note", { text: "alice" });

    const response = await runtime.handlers.getStoreItem(
      asUser("alice", { query: { namespace: "bob.memories", key: "note" } }),
    );

    expect((response as { body: { value: { text: string } } }).body.value).toEqual({
      text: "alice",
    });
  });

  it("detects an in-place rewrite, on every route including the query ones", async () => {
    // Aliasing the pre-authorize array made `value.namespace[0] = identity` invisible — and inconsistently
    // so: for `put`/`search` the array was the body's own so the mutation took effect anyway, while for
    // `get`/`delete` it was a fresh array parsed from the query and the rewrite silently did nothing.
    // Scoping that works on three routes and fails on two is the worst available outcome.
    const runtime = createProtocolRuntime(
      createFixtureDeps({
        auth: rewriting((value, identity) => {
          const namespace = value["namespace"] as string[];
          namespace[0] = identity; // in place, not a reassignment
        }),
      }),
    );
    await runtime.service.store.put(["alice", "memories"], "note", { text: "alice" });
    await runtime.service.store.put(["bob", "memories"], "note", { text: "bob" });

    // A query-addressed DELETE: alice asks for bob's item, the handler reroutes her to her own.
    await runtime.handlers.deleteStoreItem(
      asUser("alice", { method: "DELETE", query: { namespace: "bob.memories", key: "note" } }),
    );

    // Bob's survives; alice's is the one that went.
    expect((await runtime.service.store.get(["bob", "memories"], "note")).value).toEqual({
      text: "bob",
    });
    await expect(runtime.service.store.get(["alice", "memories"], "note")).rejects.toThrow();
  });

  it("leaves the request alone when the handler does not touch the namespace", async () => {
    const runtime = createProtocolRuntime(createFixtureDeps({ auth: rewriting(() => undefined) }));

    await runtime.handlers.putStoreItem(
      asUser("alice", {
        method: "PUT",
        body: { namespace: ["shared"], key: "note", value: { text: "as asked" } },
      }),
    );

    expect((await runtime.service.store.get(["shared"], "note")).value).toEqual({
      text: "as asked",
    });
  });

  it("refuses a rewrite that is not a string array, rather than silently scoping nothing", async () => {
    // A handler that meant to scope and got the shape wrong must not fall through to the caller's own
    // namespace — that is the failure this whole feature exists to prevent.
    const runtime = createProtocolRuntime(
      createFixtureDeps({
        auth: rewriting((value) => {
          value["namespace"] = "alice/memories";
        }),
      }),
    );

    await expect(
      runtime.handlers.putStoreItem(
        asUser("alice", {
          method: "PUT",
          body: { namespace: ["bob"], key: "note", value: {} },
        }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isSkeinHttpError(error) && error.code === "store_namespace_rewrite_invalid",
    );
  });

  it("honours a rewritten `value.key`, which redirects which item is addressed", async () => {
    // The same idiom one field over. Dropping a key rewrite would be the identical failure — a handler
    // that scoped by key prefix, ran, and looked like it had.
    const runtime = createProtocolRuntime(
      createFixtureDeps({
        auth: rewriting((value, identity) => {
          value["key"] = `${identity}:${String(value["key"])}`;
        }),
      }),
    );

    await runtime.handlers.putStoreItem(
      asUser("alice", {
        method: "PUT",
        body: { namespace: ["shared"], key: "note", value: { text: "alice" } },
      }),
    );

    expect((await runtime.service.store.get(["shared"], "alice:note")).value).toEqual({
      text: "alice",
    });
    await expect(runtime.service.store.get(["shared"], "note")).rejects.toThrow();
  });

  it("refuses a `value.key` rewrite on a route that addresses no single item", async () => {
    // `store:search` has no key to redirect, so the endpoint has nowhere to put one. Refusing says that;
    // ignoring it would be the silent drop this whole feature exists to prevent.
    const runtime = createProtocolRuntime(
      createFixtureDeps({
        auth: rewriting((value) => {
          value["key"] = "note";
        }),
      }),
    );

    await expect(
      runtime.handlers.searchStoreItems(
        asUser("alice", { method: "POST", body: { namespace_prefix: ["shared"] } }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isSkeinHttpError(error) && error.code === "store_key_rewrite_invalid",
    );
  });

  it("does not mistake a caller's own body `key` for a rewrite on a search route", async () => {
    // The store schemas are `.passthrough()`, so a stray `key` in a search body reaches `value` untouched.
    // Reading that as a handler mutation would let any caller provoke the 500 above.
    const runtime = createProtocolRuntime(createFixtureDeps({ auth: rewriting(() => undefined) }));
    await runtime.service.store.put(["shared"], "note", { text: "shared" });

    const response = await runtime.handlers.searchStoreItems(
      asUser("alice", { method: "POST", body: { namespace_prefix: ["shared"], key: 42 } }),
    );

    const { items } = (response as { body: { items: { value: { text: string } }[] } }).body;
    expect(items.map((item) => item.value.text)).toEqual(["shared"]);
  });

  it("serves a custom AuthEngine that does not hand back the object it was given", async () => {
    // `AuthEngine.authorize` promises only `{ filters?, value: unknown }` — an embedder's own engine may
    // return a fresh object, and skein's own is the only one that echoes. Reading a missing `namespace` off
    // such a reply as "the handler deleted it" 500-ed every `/store/*` request on a deployment that never
    // rewrote anything.
    const runtime = createProtocolRuntime(
      createFixtureDeps({
        auth: {
          ...fakeEngine(),
          authorize: async () => ({ filters: undefined, value: { unrelated: true } }),
        },
      }),
    );

    await runtime.handlers.putStoreItem(
      asUser("alice", {
        method: "PUT",
        body: { namespace: ["shared"], key: "note", value: { text: "as asked" } },
      }),
    );

    expect((await runtime.service.store.get(["shared"], "note")).value).toEqual({
      text: "as asked",
    });
  });

  it("does not read a rewrite off an engine that hands back a copy of the request body", async () => {
    // The narrow-but-real reason the identity guard covers `namespace` too, not just `key`. The store
    // schemas are `.passthrough()`, so alice can plant a decoy `namespace` on a *search* — the field the
    // endpoint ignores in favour of `namespace_prefix`. An engine returning a defensive copy of the raw body
    // would surface that decoy as if the handler had chosen it, redirecting the search to a namespace the
    // caller picked while the handler was shown the one the server derived. That is the very bypass
    // `authValue` closes, arriving through the back door.
    const runtime = createProtocolRuntime(
      createFixtureDeps({
        auth: {
          ...fakeEngine(),
          authorize: async ({ value }) => ({
            filters: undefined,
            value: { ...(value as Record<string, unknown>) },
          }),
        },
      }),
    );
    await runtime.service.store.put(["alice"], "a", { text: "alice" });
    await runtime.service.store.put(["bob"], "b", { text: "bob" });

    const response = await runtime.handlers.searchStoreItems(
      asUser("alice", {
        method: "POST",
        body: { namespace_prefix: ["alice"], namespace: ["bob"] },
      }),
    );

    // Served from the prefix the caller actually sent, not from the decoy.
    const { items } = (response as { body: { items: { value: { text: string } }[] } }).body;
    expect(items.map((item) => item.value.text)).toEqual(["alice"]);
  });

  it("gives store routes no `fallbackResource`, so no second handler can rewrite through them", () => {
    // Both `authorize` calls are handed the *same* `value` object, so a fallback handler's mutation would be
    // read as the store handler's — turning the fallback into a namespace-rewrite channel for a resource
    // that never opted into being one. `createAuthorizingHandlers` reads the rewrite before the fallback
    // runs for that reason; this pins the invariant that makes the situation unreachable today, so adding a
    // store fallback later trips here rather than silently gaining the channel.
    const storeRoutes = Object.entries(ROUTE_AUTHZ).filter(
      ([, route]) => route.resource === "store",
    );

    expect(storeRoutes.length).toBeGreaterThan(0);
    for (const [name, route] of storeRoutes) {
      expect(
        route.fallbackResource,
        `${name} must not inherit a fallback resource`,
      ).toBeUndefined();
    }
  });
});

// An authorization decision is only as good as the payload it reads, and every request schema here is
// `.passthrough()` — so the fields naming the resource must be the *server's* reading, not the caller's.
// Two instances, one shape: store routes get `namespace`/`key` normalized to what the endpoint will
// actually use (also the shape `@langchain/langgraph-sdk/auth` declares, so a handler ported from
// LangGraph Platform works unchanged), and path params win over a same-named body field.
describe("auth payload is server-derived, not caller-supplied", () => {
  /** The handler docs/agent-protocol.md prescribes: require a namespace rooted at the principal. */
  const scopedByNamespace = (): AuthEngine => ({
    ...fakeEngine(),
    authorize: async ({ resource, value, context }) => {
      if (resource === "store" && context) {
        const namespace = (value as { namespace?: unknown }).namespace;
        const rooted =
          Array.isArray(namespace) &&
          namespace.length > 0 &&
          namespace[0] === context.user.identity;
        if (!rooted) throw SkeinHttpError.forbidden("Out of scope.");
      }
      return { filters: undefined, value };
    },
  });

  let runtime: ProtocolRuntime;

  beforeEach(async () => {
    runtime = createProtocolRuntime(createFixtureDeps({ auth: scopedByNamespace() }));
    // Seeded through the store service directly: the point here is the authz payload, and going via
    // `putStoreItem` as bob would be refused by the very handler under test.
    for (const owner of ["alice", "bob"]) {
      await runtime.service.store.put([owner, "memories"], "note", { text: `${owner}-secret` });
    }
  });

  it("closes the decoy bypass: a body `namespace` cannot stand in for the field search uses", async () => {
    // Before normalization this returned every tenant's items — the handler was satisfied by
    // `namespace: ["alice"]` while the endpoint searched from an absent `namespace_prefix`.
    await expectStatus(
      runtime.handlers.searchStoreItems(
        asUser("alice", { method: "POST", body: { namespace: ["alice"] } }),
      ),
      403,
    );
    await expectStatus(
      runtime.handlers.searchStoreItems(
        asUser("alice", { method: "POST", body: { namespace: "alice" } }),
      ),
      403,
    );
  });

  it("refuses a search that names no namespace, which would read every tenant", async () => {
    await expectStatus(
      runtime.handlers.searchStoreItems(asUser("alice", { method: "POST", body: {} })),
      403,
    );
    await expectStatus(
      runtime.handlers.listStoreNamespaces(asUser("alice", { method: "POST", body: {} })),
      403,
    );
  });

  it("admits a search scoped to the caller's own root, and only their items come back", async () => {
    const response = await runtime.handlers.searchStoreItems(
      asUser("alice", { method: "POST", body: { namespace_prefix: ["alice"] } }),
    );
    const { items } = (response as { body: { items: { value: { text: string } }[] } }).body;
    expect(items.map((item) => item.value.text)).toEqual(["alice-secret"]);
  });

  it("refuses another tenant's root on every store route", async () => {
    const bobsNamespace = { namespace: "bob.memories", key: "note" };
    await expectStatus(
      runtime.handlers.getStoreItem(asUser("alice", { query: bobsNamespace })),
      403,
    );
    await expectStatus(
      runtime.handlers.deleteStoreItem(asUser("alice", { method: "DELETE", query: bobsNamespace })),
      403,
    );
    // The SDK's own delete shape — a JSON body — must authorize identically, or the body path is a way
    // around the handler that guards the query path.
    await expectStatus(
      runtime.handlers.deleteStoreItem(
        asUser("alice", {
          method: "DELETE",
          body: { namespace: ["bob", "memories"], key: "note" },
        }),
      ),
      403,
    );
    await expectStatus(
      runtime.handlers.putStoreItem(
        asUser("alice", {
          method: "PUT",
          body: { namespace: ["bob", "memories"], key: "note", value: { text: "overwritten" } },
        }),
      ),
      403,
    );
    await expectStatus(
      runtime.handlers.searchStoreItems(
        asUser("alice", { method: "POST", body: { namespace_prefix: ["bob"] } }),
      ),
      403,
    );
    await expectStatus(
      runtime.handlers.listStoreNamespaces(
        asUser("alice", { method: "POST", body: { prefix: ["bob"] } }),
      ),
      403,
    );
  });

  it("does not let a body field shadow a path param, which pointed authz at the wrong thread", async () => {
    // The request bodies are `.passthrough()`, so a caller could send `{"thread_id": "mine"}` to
    // `POST /threads/{victim}/runs`: authz saw the attacker's thread while the handler — which reads
    // `requireParam(req.params, "thread_id")` — ran on the victim's. A handler returning ownership
    // filters was still covered by the scoped store, but a check-only handler was not covered at all.
    let seen: unknown;
    const capturing: AuthEngine = {
      ...fakeEngine(),
      authorize: async ({ value }) => {
        seen = (value as { thread_id?: unknown }).thread_id;
        return { filters: undefined, value };
      },
    };
    const captured = createProtocolRuntime(createFixtureDeps({ auth: capturing }));

    await expectStatus(
      captured.handlers.getRun(
        asUser("alice", {
          params: { thread_id: "victim-thread", run_id: "r1" },
          body: { thread_id: "attacker-owned" },
        }),
      ),
      404,
    );

    expect(seen).toBe("victim-thread");
  });

  it("stamps `key` from the same read as `namespace`, so both name the item the endpoint uses", async () => {
    // Same class as the namespace bug: authorizing one key while the endpoint deletes another.
    let seen: { namespace?: unknown; key?: unknown } = {};
    const capturing: AuthEngine = {
      ...fakeEngine(),
      authorize: async ({ resource, value }) => {
        if (resource === "store") seen = value as { namespace?: unknown; key?: unknown };
        return { filters: undefined, value };
      },
    };
    const captured = createProtocolRuntime(createFixtureDeps({ auth: capturing }));

    await captured.handlers.deleteStoreItem(
      asUser("alice", {
        method: "DELETE",
        body: { namespace: ["alice", "memories"], key: "note" },
      }),
    );

    expect(seen).toMatchObject({ namespace: ["alice", "memories"], key: "note" });
  });

  it("hands the query routes an array, as the SDK declares — not the dot-joined wire string", async () => {
    // `value.namespace.join(".")` in a ported handler would throw a TypeError on a string, surfacing
    // as a 500 from inside authorize on every `GET /store/items`.
    let seen: unknown;
    const capturing: AuthEngine = {
      ...fakeEngine(),
      authorize: async ({ resource, value }) => {
        if (resource === "store") seen = (value as { namespace?: unknown }).namespace;
        return { filters: undefined, value };
      },
    };
    const captured = createProtocolRuntime(createFixtureDeps({ auth: capturing }));
    await captured.service.store.put(["alice", "memories"], "note", { text: "alice-secret" });

    await captured.handlers.getStoreItem(
      asUser("alice", { query: { namespace: "alice.memories", key: "note" } }),
    );

    expect(seen).toEqual(["alice", "memories"]);
  });
});
