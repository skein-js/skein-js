// Cron authorization, against an engine that resolves handlers the way the **real** one does.
//
// This file exists because of a vulnerability that the existing auth tests could not see. Their
// `fakeEngine` returns ownership filters for every resource, so every resource looked scoped. The
// config-loaded engine does not: it matches `@auth.on` callbacks by exact event key
// (`resource:action` → `resource` → `*:action` → `*`), so a deployment that registered
// `.on("threads", …)` — the idiomatic pattern, and what this repo's own chat-app example does — has
// no callback for `crons` and `authorize` answers "no filters". The dispatcher reads that as
// "nothing to scope" rather than "deny", and served the whole crons resource unscoped: any
// authenticated caller could enumerate, mutate, and delete every tenant's schedules, and attach one
// to a thread they could not even read.
//
// So the engine here is deliberately key-accurate rather than convenient.

import {
  SkeinHttpError,
  isSkeinHttpError,
  type AuthEngine,
  type AuthFilters,
} from "@skein-js/core";
import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import type { ProtocolRequest } from "../create-handlers.js";
import { createProtocolRuntime, type ProtocolRuntime } from "../runtime.js";

/**
 * An engine whose `authorize` resolves callbacks by **exact event key**, exactly as
 * `@skein-js/config`'s does. `registered` is the set of `@auth.on(...)` event strings a deployment
 * declared, so a test can reproduce "they only scoped threads".
 */
function keyAccurateEngine(
  registered: Record<string, (identity: string) => AuthFilters>,
): AuthEngine {
  return {
    enabled: true,
    studioAuthDisabled: false,
    authenticate: async (request) => {
      const identity = request.headers.get("x-user");
      if (!identity) throw SkeinHttpError.unauthorized("missing credentials");
      return {
        user: { identity, display_name: identity, is_authenticated: true, permissions: [] },
        scopes: [],
      };
    },
    authorize: async ({ resource, action, value, context }) => {
      // The real chain, verbatim.
      const key = [`${resource}:${action}`, resource, `*:${action}`, "*"].find(
        (candidate) => registered[candidate],
      );
      const handler = key ? registered[key] : undefined;
      if (!handler || !context) return { filters: undefined, value };
      return { filters: handler(context.user.identity), value };
    },
    matchesFilters: (metadata, filters) => {
      if (!filters) return true;
      return Object.entries(filters).every(([key, clause]) => metadata?.[key] === clause);
    },
  };
}

/** The deployment shape that was vulnerable: thread ownership only, no cron handler at all. */
const threadsOnly = (): AuthEngine =>
  keyAccurateEngine({ threads: (identity) => ({ owner: identity }) });

function makeReq(overrides: Partial<ProtocolRequest> = {}): ProtocolRequest {
  return {
    method: "POST",
    url: "http://localhost:2024/",
    params: {},
    query: {},
    body: {},
    headers: {},
    ...overrides,
  };
}

const asUser = (identity: string, overrides: Partial<ProtocolRequest> = {}): ProtocolRequest =>
  makeReq({ ...overrides, headers: { "x-user": identity, ...overrides.headers } });

async function withRuntime(engine: AuthEngine): Promise<{
  runtime: ProtocolRuntime;
  assistantId: string;
}> {
  const runtime = createProtocolRuntime(createFixtureDeps({ auth: engine }));
  await runtime.service.assistants.registerGraphAssistants();
  const [assistant] = await runtime.service.assistants.search({});
  return { runtime, assistantId: assistant?.assistant_id as string };
}

const bodyOf = (response: { kind: string; body?: unknown }): never | unknown => {
  if (response.kind !== "json") throw new Error("expected a JSON response");
  return response.body;
};

async function createCronAs(
  runtime: ProtocolRuntime,
  identity: string,
  body: Record<string, unknown>,
): Promise<{ cron_id: string; thread_id?: string | null }> {
  const response = await runtime.handlers.createCron(asUser(identity, { body }));
  return bodyOf(response) as { cron_id: string; thread_id?: string | null };
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => isSkeinHttpError(error) && error.status === status,
  );
}

describe("cron authorization", () => {
  describe("a deployment that scoped only threads", () => {
    it("scopes cron search to the caller, rather than serving every tenant's", async () => {
      const { runtime, assistantId } = await withRuntime(threadsOnly());
      await createCronAs(runtime, "alice", { assistant_id: assistantId, schedule: "0 9 * * *" });
      await createCronAs(runtime, "mallory", { assistant_id: assistantId, schedule: "0 9 * * *" });

      const found = bodyOf(
        await runtime.handlers.searchCrons(asUser("mallory", { body: {} })),
      ) as unknown[];

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ user_id: "mallory" });
    });

    it("counts only the caller's crons", async () => {
      const { runtime, assistantId } = await withRuntime(threadsOnly());
      await createCronAs(runtime, "alice", { assistant_id: assistantId, schedule: "0 9 * * *" });
      await createCronAs(runtime, "mallory", { assistant_id: assistantId, schedule: "0 9 * * *" });

      expect(bodyOf(await runtime.handlers.countCrons(asUser("mallory", { body: {} })))).toBe(1);
    });

    it("hides another tenant's cron on read, as a 404", async () => {
      const { runtime, assistantId } = await withRuntime(threadsOnly());
      const victim = await createCronAs(runtime, "alice", {
        assistant_id: assistantId,
        schedule: "0 9 * * *",
      });

      await expectStatus(
        runtime.handlers.getCron(
          asUser("mallory", { method: "GET", params: { cron_id: victim.cron_id } }),
        ),
        404,
      );
    });

    it("refuses to update or delete another tenant's cron", async () => {
      const { runtime, assistantId } = await withRuntime(threadsOnly());
      const victim = await createCronAs(runtime, "alice", {
        assistant_id: assistantId,
        schedule: "0 9 * * *",
      });

      await expectStatus(
        runtime.handlers.updateCron(
          asUser("mallory", {
            method: "PATCH",
            params: { cron_id: victim.cron_id },
            body: { enabled: false },
          }),
        ),
        404,
      );
      await expectStatus(
        runtime.handlers.deleteCron(
          asUser("mallory", { method: "DELETE", params: { cron_id: victim.cron_id } }),
        ),
        404,
      );
      // Still there, still armed.
      expect(
        bodyOf(
          await runtime.handlers.getCron(
            asUser("alice", { method: "GET", params: { cron_id: victim.cron_id } }),
          ),
        ),
      ).toMatchObject({ enabled: true });
    });

    // The severe half: a schedule writes runs into a thread, forever. Attaching one to a thread the
    // caller cannot even read would let them inject turns into another tenant's conversation.
    it("refuses to attach a schedule to another tenant's thread", async () => {
      const { runtime, assistantId } = await withRuntime(threadsOnly());
      const victimThread = bodyOf(
        await runtime.handlers.createThread(asUser("alice", { body: {} })),
      ) as { thread_id: string };

      // Sanity: the thread itself is properly hidden from mallory.
      await expectStatus(
        runtime.handlers.getThread(
          asUser("mallory", { method: "GET", params: { thread_id: victimThread.thread_id } }),
        ),
        404,
      );

      await expectStatus(
        runtime.handlers.createCron(
          asUser("mallory", {
            params: { thread_id: victimThread.thread_id },
            body: {
              assistant_id: assistantId,
              schedule: "* * * * *",
              thread_id: victimThread.thread_id,
              input: { messages: "pwned" },
            },
          }),
        ),
        404,
      );
    });

    it("still allows attaching a schedule to the caller's own thread", async () => {
      const { runtime, assistantId } = await withRuntime(threadsOnly());
      const ownThread = bodyOf(
        await runtime.handlers.createThread(asUser("alice", { body: {} })),
      ) as {
        thread_id: string;
      };

      const cron = await createCronAs(runtime, "alice", {
        assistant_id: assistantId,
        schedule: "* * * * *",
        thread_id: ownThread.thread_id,
      });

      expect(cron.thread_id).toBe(ownThread.thread_id);
    });
  });

  describe("a deployment with its own cron handlers", () => {
    it("uses the cron handler's filters rather than the thread fallback", async () => {
      const engine = keyAccurateEngine({
        threads: (identity) => ({ owner: identity }),
        // Deliberately a different key, so which handler ran is observable.
        crons: (identity) => ({ cronOwner: identity }),
      });
      const { runtime, assistantId } = await withRuntime(engine);
      await createCronAs(runtime, "alice", { assistant_id: assistantId, schedule: "0 9 * * *" });

      const found = bodyOf(await runtime.handlers.searchCrons(asUser("alice", { body: {} }))) as {
        metadata: Record<string, unknown>;
      }[];

      expect(found).toHaveLength(1);
      expect(found[0]?.metadata).toMatchObject({ cronOwner: "alice" });
      expect(found[0]?.metadata).not.toHaveProperty("owner");
    });

    // The narrower variant: with cron filters present the fallback does not run, so the crons
    // branch's thread gate compares against *cron* filters. Thread ownership is asked for directly
    // by the service for exactly this reason.
    it("still refuses a foreign thread when the cron and thread filters disagree", async () => {
      const engine = keyAccurateEngine({
        threads: (identity) => ({ owner: identity }),
        // Every caller shares one cron scope, so the crons branch's gate would let anything through.
        crons: () => ({ tenant: "shared" }),
      });
      const { runtime, assistantId } = await withRuntime(engine);
      const victimThread = bodyOf(
        await runtime.handlers.createThread(asUser("alice", { body: {} })),
      ) as { thread_id: string };

      await expectStatus(
        runtime.handlers.createCron(
          asUser("mallory", {
            params: { thread_id: victimThread.thread_id },
            body: {
              assistant_id: assistantId,
              schedule: "* * * * *",
              thread_id: victimThread.thread_id,
            },
          }),
        ),
        404,
      );
    });

    it("honours an explicit denial from the cron handler", async () => {
      const engine: AuthEngine = {
        ...keyAccurateEngine({ threads: (identity) => ({ owner: identity }) }),
        authorize: async ({ resource }) => {
          if (resource === "crons") throw SkeinHttpError.forbidden("no crons for you");
          return { filters: undefined, value: {} };
        },
      };
      const { runtime, assistantId } = await withRuntime(engine);

      await expectStatus(
        runtime.handlers.createCron(
          asUser("alice", { body: { assistant_id: assistantId, schedule: "0 9 * * *" } }),
        ),
        403,
      );
    });
  });

  describe("with no auth engine", () => {
    it("leaves crons open, so `skein dev` is unaffected", async () => {
      const runtime = createProtocolRuntime(createFixtureDeps());
      await runtime.service.assistants.registerGraphAssistants();
      const [assistant] = await runtime.service.assistants.search({});

      const response = await runtime.handlers.createCron(
        makeReq({ body: { assistant_id: assistant?.assistant_id, schedule: "0 9 * * *" } }),
      );

      expect(response.status).toBe(200);
    });
  });
});
