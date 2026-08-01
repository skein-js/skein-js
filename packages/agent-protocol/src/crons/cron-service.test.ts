// The cron *record*: CRUD, the derived `next_run_date`, and the two places the wire contract is
// fussier than it looks — tri-state PATCH and metadata merge. Firing is the scheduler's, tested
// separately. Everything here runs against the memory store with a frozen clock and no Docker.

import { describe, expect, it } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import type { ProtocolDeps } from "../deps.js";
import { createProtocolServiceFromContext } from "../service.js";

/** Frozen so a derived `next_run_date` is a literal a test can assert, not a moving target. */
const NOW = new Date("2026-08-01T12:00:00.000Z");

async function serviceWithAssistants(overrides: Partial<ProtocolDeps> = {}) {
  const deps = createFixtureDeps({ clock: () => NOW, ...overrides });
  const service = createProtocolServiceFromContext(createContext(deps));
  await service.assistants.registerGraphAssistants();
  return service;
}

/** The graph assistant the fixture resolver registers, so tests can name a real assistant. */
async function anyAssistantId(service: Awaited<ReturnType<typeof serviceWithAssistants>>) {
  const [assistant] = await service.assistants.search({});
  return assistant?.assistant_id as string;
}

describe("cron service", () => {
  describe("create", () => {
    it("creates a stateless cron and derives its next run", async () => {
      const service = await serviceWithAssistants();
      const cron = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
      });

      expect(cron.cron_id).toBeTruthy();
      expect(cron.schedule).toBe("0 9 * * *");
      expect(cron.enabled).toBe(true);
      expect(cron.thread_id ?? null).toBeNull();
      // 09:00 UTC has already passed at the frozen 12:00, so the next one is tomorrow.
      expect(cron.next_run_date).toBe("2026-08-02T09:00:00.000Z");
    });

    // Matches LangGraph, and deliberately differs from skein's own `on_completion` default of
    // "keep" for one-off stateless runs. A frequent schedule keeping every thread accrues six
    // figures of them a year with nobody watching.
    it("defaults a stateless cron to deleting its per-fire thread", async () => {
      const service = await serviceWithAssistants();
      const cron = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
      });

      expect(cron.on_run_completed).toBe("delete");
    });

    it("honours an explicit on_run_completed on a stateless cron", async () => {
      const service = await serviceWithAssistants();
      const cron = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        on_run_completed: "keep",
      });

      expect(cron.on_run_completed).toBe("keep");
    });

    // The thread belongs to the caller, not to the run, so the field does not apply at all.
    it("leaves on_run_completed absent on a thread cron", async () => {
      const service = await serviceWithAssistants();
      const { thread_id } = await service.threads.create();
      const cron = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        thread_id,
        on_run_completed: "delete",
      });

      expect(cron.thread_id).toBe(thread_id);
      expect(cron.on_run_completed).toBeUndefined();
    });

    it("reads the schedule in the given timezone", async () => {
      const service = await serviceWithAssistants();
      const cron = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        timezone: "America/New_York",
      });

      // 09:00 New York is EDT (UTC-4) = 13:00Z, which is still ahead of the frozen 12:00Z — so it
      // fires today rather than tomorrow. The UTC reading of the same expression would not.
      expect(cron.next_run_date).toBe("2026-08-01T13:00:00.000Z");
    });

    it("stores a disabled cron as dormant", async () => {
      const service = await serviceWithAssistants();
      const cron = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        enabled: false,
      });

      expect(cron.enabled).toBe(false);
      expect(cron.next_run_date ?? null).toBeNull();
    });

    it("stores a cron whose end_time has passed as dormant", async () => {
      const service = await serviceWithAssistants();
      const cron = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        end_time: "2020-01-01T00:00:00Z",
      });

      expect(cron.next_run_date ?? null).toBeNull();
    });

    // Split by "what the cron row owns", so a run field skein does not yet know about still reaches
    // the graph on a fire rather than being silently dropped.
    it("stores the run half of the body as the replayed payload", async () => {
      const service = await serviceWithAssistants();
      const cron = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        timezone: "UTC",
        metadata: { owner: "ada" },
        input: { topic: "ai" },
        config: { configurable: { model: "x" } },
      });

      expect(cron.payload).toEqual({
        input: { topic: "ai" },
        config: { configurable: { model: "x" } },
      });
      // Scheduling fields stay on the row, not in the payload.
      expect(cron.payload).not.toHaveProperty("schedule");
      expect(cron.payload).not.toHaveProperty("timezone");
      expect(cron.payload).not.toHaveProperty("metadata");
      expect(cron.payload).not.toHaveProperty("assistant_id");
      expect(cron.metadata).toEqual({ owner: "ada" });
    });

    it("404s an unknown assistant, creating nothing", async () => {
      const service = await serviceWithAssistants();
      await expect(
        service.crons.create({ assistant_id: "ghost", schedule: "0 9 * * *" }),
      ).rejects.toMatchObject({ status: 404 });

      expect(await service.crons.search({})).toEqual([]);
    });

    it("404s an unknown thread", async () => {
      const service = await serviceWithAssistants();
      await expect(
        service.crons.create({
          assistant_id: await anyAssistantId(service),
          schedule: "0 9 * * *",
          thread_id: "ghost",
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("422s a schedule that is not a standard 5-field expression", async () => {
      const service = await serviceWithAssistants();
      const assistant_id = await anyAssistantId(service);

      for (const schedule of ["0 0 9 * * *", "@daily", "nope"]) {
        await expect(service.crons.create({ assistant_id, schedule })).rejects.toMatchObject({
          status: 422,
        });
      }
    });

    it("422s an unknown timezone", async () => {
      const service = await serviceWithAssistants();
      await expect(
        service.crons.create({
          assistant_id: await anyAssistantId(service),
          schedule: "0 9 * * *",
          timezone: "Mars/Olympus",
        }),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("read", () => {
    it("404s an unknown cron on get and delete", async () => {
      const service = await serviceWithAssistants();
      await expect(service.crons.get("ghost")).rejects.toMatchObject({ status: 404 });
      await expect(service.crons.delete("ghost")).rejects.toMatchObject({ status: 404 });
    });

    it("maps snake_case wire filters onto the repo's query", async () => {
      const service = await serviceWithAssistants();
      const assistant_id = await anyAssistantId(service);
      const { thread_id } = await service.threads.create();
      await service.crons.create({ assistant_id, schedule: "0 9 * * *", thread_id });
      await service.crons.create({ assistant_id, schedule: "0 9 * * *", enabled: false });

      expect((await service.crons.search({ thread_id })).length).toBe(1);
      expect((await service.crons.search({ enabled: false })).length).toBe(1);
      expect(await service.crons.count({ enabled: true })).toBe(1);
      expect(await service.crons.count({})).toBe(2);
    });

    it("sorts through to the driver", async () => {
      const service = await serviceWithAssistants();
      const assistant_id = await anyAssistantId(service);
      await service.crons.create({ assistant_id, schedule: "0 9 * * *" });
      await service.crons.create({ assistant_id, schedule: "0 10 * * *" });

      const ascending = await service.crons.search({
        sort_by: "next_run_date",
        sort_order: "asc",
      });
      expect(ascending.map((cron) => cron.schedule)).toEqual(["0 9 * * *", "0 10 * * *"]);
    });
  });

  describe("update", () => {
    it("recomputes next_run_date when the schedule changes", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
      });

      const patched = await service.crons.update(created.cron_id, { schedule: "0 14 * * *" });
      expect(patched.next_run_date).toBe("2026-08-01T14:00:00.000Z");
    });

    it("recomputes next_run_date when the timezone changes", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
      });

      const patched = await service.crons.update(created.cron_id, {
        timezone: "America/New_York",
      });
      // Moves from tomorrow 09:00Z to today 13:00Z — the same wall-clock hour, read in a new zone.
      expect(patched.next_run_date).toBe("2026-08-01T13:00:00.000Z");
    });

    it("goes dormant when disabled", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
      });

      const paused = await service.crons.update(created.cron_id, { enabled: false });
      expect(paused.enabled).toBe(false);
      expect(paused.next_run_date ?? null).toBeNull();
    });

    // Without recomputing on `enabled`, a paused cron would come back armed-but-dormant and never
    // fire again — the bug that makes pause/resume a one-way door.
    it("re-arms when re-enabled", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
      });
      await service.crons.update(created.cron_id, { enabled: false });

      const resumed = await service.crons.update(created.cron_id, { enabled: true });
      expect(resumed.enabled).toBe(true);
      expect(resumed.next_run_date).toBe("2026-08-02T09:00:00.000Z");
    });

    it("goes dormant when an end_time in the past is set", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
      });

      const retired = await service.crons.update(created.cron_id, {
        end_time: "2020-01-01T00:00:00Z",
      });
      expect(retired.next_run_date ?? null).toBeNull();
    });

    it("re-arms when a past end_time is cleared with null", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        end_time: "2020-01-01T00:00:00Z",
      });

      const revived = await service.crons.update(created.cron_id, { end_time: null });
      expect(revived.end_time ?? null).toBeNull();
      expect(revived.next_run_date).toBe("2026-08-02T09:00:00.000Z");
    });

    it("leaves end_time and timezone alone when they are omitted", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        timezone: "America/New_York",
        end_time: "2030-01-01T00:00:00Z",
      });

      const patched = await service.crons.update(created.cron_id, { metadata: { a: 1 } });
      expect(patched.timezone).toBe("America/New_York");
      expect(patched.end_time).toBe("2030-01-01T00:00:00.000Z");
    });

    it("merges metadata rather than replacing it", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        metadata: { owner: "ada", tier: "pro" },
      });

      const patched = await service.crons.update(created.cron_id, { metadata: { tier: "free" } });
      expect(patched.metadata).toEqual({ owner: "ada", tier: "free" });
    });

    // Unlike metadata: a payload is one run request, and a half-replaced one is not a request
    // anybody asked for.
    it("replaces the payload wholesale when run fields are patched", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        input: { topic: "ai" },
        config: { configurable: { model: "x" } },
      });

      const patched = await service.crons.update(created.cron_id, { input: { topic: "bio" } });
      expect(patched.payload).toEqual({ input: { topic: "bio" } });
    });

    it("keeps the payload when the patch carries no run fields", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
        input: { topic: "ai" },
      });

      const patched = await service.crons.update(created.cron_id, { metadata: { a: 1 } });
      expect(patched.payload).toEqual({ input: { topic: "ai" } });
    });

    it("validates a new schedule against the stored timezone, and vice versa", async () => {
      const service = await serviceWithAssistants();
      const created = await service.crons.create({
        assistant_id: await anyAssistantId(service),
        schedule: "0 9 * * *",
      });

      await expect(
        service.crons.update(created.cron_id, { schedule: "@daily" }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        service.crons.update(created.cron_id, { timezone: "Mars/Olympus" }),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("404s an unknown cron", async () => {
      const service = await serviceWithAssistants();
      await expect(service.crons.update("ghost", { schedule: "0 9 * * *" })).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  it("deletes a cron", async () => {
    const service = await serviceWithAssistants();
    const created = await service.crons.create({
      assistant_id: await anyAssistantId(service),
      schedule: "0 9 * * *",
    });

    await service.crons.delete(created.cron_id);
    await expect(service.crons.get(created.cron_id)).rejects.toMatchObject({ status: 404 });
  });
});
