// The firing loop. Every case here runs on the memory store with a frozen clock and no Docker,
// which is the point: catch-up, contention, and the ways the loop can die are all things you want
// covered by the pre-commit gate rather than by a container suite nobody runs locally.

import { SkeinHttpError, type AuthEngine, type QueuedRun, type SkeinStore } from "@skein-js/core";
import { MemoryRunQueue, MemorySkeinStore } from "@skein-js/storage-memory";
import { describe, expect, it, vi } from "vitest";

import { createFixtureDeps } from "../__fixtures__/deps.js";
import { createContext } from "../context.js";
import type { ProtocolDeps } from "../deps.js";
import { createProtocolServiceFromContext } from "../service.js";

import {
  createCronScheduler,
  type CronScheduler,
  type CronSchedulerOptions,
} from "./cron-scheduler.js";

// Anchored to real time rather than to a fixed literal, because the memory store stamps `created_at`
// with its own `new Date()` while the outbox sweep reads the injected clock — and the sweep compares
// the two. Pinning the scheduler's clock to a date in the past or future would make every existing
// run look stale (or impossibly new) purely as an artifact of the test.
//
// Time still only moves when a test says so: `advance` is the single way it changes.
const startOfTest = () => new Date();

/** Far enough ahead that an hourly cron has certainly come due. */
const AN_HOUR_AND_A_BIT = 61 * 60_000;

/**
 * The outbox sweep's grace window, set wide enough that advancing the clock to make a cron due does
 * not also make every existing run look abandoned. Tests that are *about* the sweep shrink it.
 *
 * Only a test needs this: in production the scheduler's clock and the store's are the same wall
 * clock, so a run's age is its real age.
 */
const NEVER_SWEEP = 365 * 24 * 60 * 60_000;

/** A queue that records what was enqueued instead of running it, so a tick is observable. */
class RecordingQueue extends MemoryRunQueue {
  readonly enqueued: QueuedRun[] = [];
  override async enqueue(run: QueuedRun): Promise<void> {
    this.enqueued.push(run);
    await super.enqueue(run);
  }
}

interface Harness {
  scheduler: CronScheduler;
  service: ReturnType<typeof createProtocolServiceFromContext>;
  store: SkeinStore;
  queue: RecordingQueue;
  assistantId: string;
  clock: { now: Date };
  /** Move the scheduler's clock forward, which is how a test makes a cron come due. */
  advance: (ms: number) => void;
}

async function harness(
  overrides: Partial<ProtocolDeps> = {},
  schedulerOptions: CronSchedulerOptions = {},
): Promise<Harness> {
  const clock = { now: startOfTest() };
  const queue = new RecordingQueue();
  const store = overrides.store ?? new MemorySkeinStore();
  const deps = createFixtureDeps({ store, queue, clock: () => clock.now, ...overrides });
  const ctx = createContext(deps);
  const service = createProtocolServiceFromContext(ctx);
  await service.assistants.registerGraphAssistants();
  const [assistant] = await service.assistants.search({});
  return {
    scheduler: createCronScheduler(ctx, {
      jitterSeed: 0,
      unqueuedRunGraceMs: NEVER_SWEEP,
      ...schedulerOptions,
    }),
    service,
    store: deps.store,
    queue,
    assistantId: assistant?.assistant_id as string,
    clock,
    advance: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
}

describe("cron scheduler", () => {
  describe("firing", () => {
    it("fires a due cron and enqueues its run", async () => {
      const h = await harness();
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });
      h.advance(AN_HOUR_AND_A_BIT);

      const summary = await h.scheduler.tickOnce();

      expect(summary.fired).toBe(1);
      expect(summary.claimsLost).toBe(0);
      expect(h.queue.enqueued).toHaveLength(1);
    });

    it("advances the cron past the occurrence it just fired", async () => {
      const h = await harness();
      const cron = await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
      });
      h.advance(AN_HOUR_AND_A_BIT);

      await h.scheduler.tickOnce();

      const advanced = await h.service.crons.get(cron.cron_id);
      // Strictly in the future, and on an hour boundary — the next occurrence of `0 * * * *`.
      expect(Date.parse(advanced.next_run_date as string)).toBeGreaterThan(h.clock.now.getTime());
      expect(advanced.next_run_date).toMatch(/T\d{2}:00:00\.000Z$/);
    });

    it("does not fire a cron that is not due yet", async () => {
      const h = await harness();
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });

      const summary = await h.scheduler.tickOnce();

      expect(summary.scanned).toBe(0);
      expect(h.queue.enqueued).toEqual([]);
    });

    it("does not fire a disabled cron", async () => {
      const h = await harness();
      const cron = await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
      });
      await h.service.crons.update(cron.cron_id, { enabled: false });
      h.advance(8 * AN_HOUR_AND_A_BIT);

      expect((await h.scheduler.tickOnce()).fired).toBe(0);
    });

    // The catch-up rule. A scheduler down for hours must produce ONE run, not one per missed
    // occurrence — the outage replaying as a burst is worse than the outage.
    it("fires once after a long outage and lands in the future", async () => {
      const h = await harness();
      const cron = await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "*/5 * * * *",
      });
      // Six hours later: 72 occurrences were missed.
      h.advance(6 * AN_HOUR_AND_A_BIT);

      const summary = await h.scheduler.tickOnce();

      expect(summary.fired).toBe(1);
      expect(h.queue.enqueued).toHaveLength(1);
      const advanced = await h.service.crons.get(cron.cron_id);
      expect(Date.parse(advanced.next_run_date as string)).toBeGreaterThan(h.clock.now.getTime());
    });

    it("retires a cron whose end_time has passed after its last fire", async () => {
      const h = await harness();
      const cron = await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
      });
      // Anchored to the cron's own next occurrence rather than to a wall-clock offset: it has to
      // land *after* the upcoming fire and *before* the one an hour later, and where those two sit
      // depends on what minute the suite happens to run at.
      await h.service.crons.update(cron.cron_id, {
        end_time: new Date(Date.parse(cron.next_run_date as string) + 60_000).toISOString(),
      });
      h.advance(AN_HOUR_AND_A_BIT);

      const summary = await h.scheduler.tickOnce();

      expect(summary.fired).toBe(1);
      expect(summary.exhausted).toBe(1);
      // Dormant: it fired its last occurrence and there is no next one.
      expect((await h.service.crons.get(cron.cron_id)).next_run_date ?? null).toBeNull();
    });

    it("creates a fresh thread per fire for a stateless cron", async () => {
      const h = await harness();
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });

      h.advance(AN_HOUR_AND_A_BIT);
      await h.scheduler.tickOnce();
      h.advance(AN_HOUR_AND_A_BIT);
      await h.scheduler.tickOnce();

      const threadIds = new Set(h.queue.enqueued.map((run) => run.thread_id));
      expect(threadIds.size).toBe(2);
    });

    it("reuses the cron's thread for a thread cron", async () => {
      const h = await harness();
      const thread = await h.service.threads.create();
      await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
        thread_id: thread.thread_id,
      });

      h.advance(AN_HOUR_AND_A_BIT);
      await h.scheduler.tickOnce();
      h.advance(AN_HOUR_AND_A_BIT);
      await h.scheduler.tickOnce();

      expect(h.queue.enqueued.map((run) => run.thread_id)).toEqual([
        thread.thread_id,
        thread.thread_id,
      ]);
    });

    // The documented trace key: `runs.search({ metadata: { cron_id } })` is how a client finds what
    // a schedule has produced.
    it("stamps cron_id onto the fired run and its thread", async () => {
      const h = await harness();
      const cron = await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
      });
      h.advance(AN_HOUR_AND_A_BIT);
      await h.scheduler.tickOnce();

      const queued = h.queue.enqueued[0] as QueuedRun;
      const run = await h.store.runs.get(queued.run_id);
      const thread = await h.store.threads.get(queued.thread_id);

      expect(run?.metadata).toMatchObject({ cron_id: cron.cron_id });
      expect(thread?.metadata).toMatchObject({ cron_id: cron.cron_id });
    });

    it("replays the stored payload into the run's kwargs", async () => {
      const h = await harness();
      await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
        input: { topic: "ai" },
        config: { configurable: { model: "x" } },
      });
      h.advance(AN_HOUR_AND_A_BIT);
      await h.scheduler.tickOnce();

      const kwargs = await h.store.runs.getKwargs((h.queue.enqueued[0] as QueuedRun).run_id);
      expect(kwargs?.input).toEqual({ topic: "ai" });
      expect(kwargs?.config).toEqual({ configurable: { model: "x" } });
    });

    it("carries the stateless cron's thread disposition onto the run", async () => {
      const h = await harness();
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });
      h.advance(AN_HOUR_AND_A_BIT);
      await h.scheduler.tickOnce();

      const kwargs = await h.store.runs.getKwargs((h.queue.enqueued[0] as QueuedRun).run_id);
      // Defaulted to "delete" at create time, so the per-fire thread does not accumulate.
      expect(kwargs?.delete_thread_on_completion).toBe(true);
    });

    // Thread crons queue behind an active run rather than 422ing — LangGraph's `ThreadCronCreate`
    // default, and the only sane one for an unattended schedule.
    it("defaults a thread cron's run to enqueue rather than reject", async () => {
      const h = await harness();
      const thread = await h.service.threads.create();
      await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
        thread_id: thread.thread_id,
      });
      h.advance(AN_HOUR_AND_A_BIT);
      await h.scheduler.tickOnce();

      const run = await h.store.runs.get((h.queue.enqueued[0] as QueuedRun).run_id);
      expect(run?.multitask_strategy).toBe("enqueue");
    });
  });

  // A cron's run is created inside `claimAndCreateRun` — a cron-repo method the scoped store
  // inherits unfiltered — so it bypasses the decorator's own `runs.create` stamping. Without an
  // explicit stamp the creator cannot see the output of their own schedule through an
  // ownership-scoped read, which is what docs/crons.md promises.
  describe("auth-scoped firing", () => {
    /** An engine that scopes threads by owner, mirroring the idiomatic `.on("threads", …)`. */
    const ownerScopedEngine = (): AuthEngine => ({
      enabled: true,
      studioAuthDisabled: false,
      authenticate: async () => undefined,
      authorize: async ({ value, context }) => ({
        filters: context ? { owner: context.user.identity } : undefined,
        value,
      }),
      matchesFilters: (metadata, filters) =>
        !filters || Object.entries(filters).every(([key, clause]) => metadata?.[key] === clause),
    });

    const alice = {
      identity: "alice",
      display_name: "alice",
      is_authenticated: true,
      permissions: [],
    };

    it("stamps the creating principal's owner tag onto the fired run and its thread", async () => {
      const h = await harness({ auth: ownerScopedEngine() });
      // Written through the store with an `auth` sidecar — the shape the service persists when the
      // request that created the cron carried a principal.
      const withAuth = await h.store.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
        next_run_date: new Date(h.clock.now.getTime() + 60_000).toISOString(),
        auth: { user: alice, scopes: [] },
      });
      h.advance(AN_HOUR_AND_A_BIT);

      const summary = await h.scheduler.tickOnce();
      expect(summary.fired).toBe(1);

      const queued = h.queue.enqueued[0] as QueuedRun;
      const run = await h.store.runs.get(queued.run_id);
      const thread = await h.store.threads.get(queued.thread_id);

      expect(run?.metadata).toMatchObject({ owner: "alice", cron_id: withAuth.cron_id });
      expect(thread?.metadata).toMatchObject({ owner: "alice" });
    });

    it("replays the principal into the run's kwargs, so the graph sees it", async () => {
      const h = await harness({ auth: ownerScopedEngine() });
      await h.store.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
        next_run_date: new Date(h.clock.now.getTime() + 60_000).toISOString(),
        auth: { user: alice, scopes: ["runs:write"] },
      });
      h.advance(AN_HOUR_AND_A_BIT);

      await h.scheduler.tickOnce();

      const kwargs = await h.store.runs.getKwargs((h.queue.enqueued[0] as QueuedRun).run_id);
      expect(kwargs?.auth_user).toMatchObject({ identity: "alice" });
      expect(kwargs?.auth_scopes).toEqual(["runs:write"]);
    });

    // A revoked principal's schedule stops producing runs, and resumes if re-granted — which is why
    // the filters are re-derived at fire time instead of frozen onto the cron.
    it("stops firing when the principal's handler now denies", async () => {
      const denying: AuthEngine = {
        ...ownerScopedEngine(),
        authorize: async () => {
          throw SkeinHttpError.forbidden("revoked");
        },
      };
      const h = await harness({ auth: denying });
      const cron = await h.store.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
        next_run_date: new Date(h.clock.now.getTime() + 60_000).toISOString(),
        auth: { user: alice, scopes: [] },
      });
      h.advance(AN_HOUR_AND_A_BIT);

      const summary = await h.scheduler.tickOnce();

      expect(summary.fired).toBe(0);
      expect(summary.failed).toBe(1);
      expect(h.queue.enqueued).toEqual([]);
      // Left enabled and advanced, so re-granting resumes it rather than needing a human.
      const after = await h.service.crons.get(cron.cron_id);
      expect(after.enabled).toBe(true);
      expect(Date.parse(after.next_run_date as string)).toBeGreaterThan(h.clock.now.getTime());
    });
  });

  describe("contention", () => {
    // The multi-instance story in one test: two schedulers over one store, same due cron, exactly
    // one run. No leader election, no lock — just the compare-and-swap.
    it("fires an occurrence exactly once across two schedulers", async () => {
      const store = new MemorySkeinStore();
      const a = await harness({ store });
      const b = await harness({ store });
      await a.service.crons.create({ assistant_id: a.assistantId, schedule: "0 * * * *" });
      a.advance(AN_HOUR_AND_A_BIT);
      b.advance(AN_HOUR_AND_A_BIT);

      const [first, second] = await Promise.all([a.scheduler.tickOnce(), b.scheduler.tickOnce()]);

      expect(first.fired + second.fired).toBe(1);
      expect(first.claimsLost + second.claimsLost).toBe(1);
      expect(a.queue.enqueued.length + b.queue.enqueued.length).toBe(1);
    });

    // A lost claim must not leave the speculative thread behind, or a contended deployment would
    // accrue empty threads forever.
    it("cleans up the speculative thread when the claim is lost", async () => {
      const store = new MemorySkeinStore();
      const a = await harness({ store });
      const b = await harness({ store });
      await a.service.crons.create({ assistant_id: a.assistantId, schedule: "0 * * * *" });
      a.advance(AN_HOUR_AND_A_BIT);
      b.advance(AN_HOUR_AND_A_BIT);

      await Promise.all([a.scheduler.tickOnce(), b.scheduler.tickOnce()]);

      // Exactly one thread: the winner's. The loser took its own back.
      expect(await store.threads.count({})).toBe(1);
    });
  });

  describe("failure handling", () => {
    it("counts a failed fire, leaves the cron enabled, and still advances it", async () => {
      const h = await harness();
      const cron = await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
      });
      // Deleting the assistant out from under the cron is the realistic version of "the fire throws".
      await h.store.assistants.delete(h.assistantId);
      vi.spyOn(h.store.threads, "create").mockRejectedValueOnce(new Error("boom"));
      h.advance(AN_HOUR_AND_A_BIT);

      const summary = await h.scheduler.tickOnce();

      expect(summary.failed).toBe(1);
      expect(summary.fired).toBe(0);
      const after = await h.service.crons.get(cron.cron_id);
      // Still enabled — auto-disabling would turn a transient blip into a silently dead schedule.
      expect(after.enabled).toBe(true);
      // But advanced, so it does not re-select on every tick forever and starve the batch.
      expect(Date.parse(after.next_run_date as string)).toBeGreaterThan(h.clock.now.getTime());
    });

    it("keeps firing the other crons when one fails", async () => {
      const h = await harness();
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });
      vi.spyOn(h.store.threads, "create").mockRejectedValueOnce(new Error("boom"));
      h.advance(AN_HOUR_AND_A_BIT);

      const summary = await h.scheduler.tickOnce();

      expect(summary.failed).toBe(1);
      expect(summary.fired).toBe(1);
    });
  });

  describe("liveness", () => {
    it("reports no lag when nothing is overdue", async () => {
      const h = await harness();
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });

      expect((await h.scheduler.tickOnce()).lagMs).toBeNull();
    });

    // The alert signal: with the scheduler dead this number climbs without bound, which is what
    // distinguishes "nothing is due" from "nothing is running the crons".
    it("reports how far behind the most overdue cron is", async () => {
      const h = await harness();
      const cron = await h.service.crons.create({
        assistant_id: h.assistantId,
        schedule: "0 * * * *",
      });
      // Simulate a dead scheduler: the occurrence passed and nobody advanced it.
      const missed = new Date(h.clock.now.getTime() - 300_000).toISOString();
      await h.store.crons.update(cron.cron_id, { next_run_date: missed });

      // Read lag without firing, by scanning with the scheduler's own query.
      expect(await h.store.crons.maxOverdueMs(h.clock.now.toISOString())).toBe(300_000);
    });

    it("clears the lag once the backlog is fired", async () => {
      const h = await harness();
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });
      h.advance(6 * AN_HOUR_AND_A_BIT);

      expect((await h.scheduler.tickOnce()).lagMs).toBeNull();
    });
  });

  describe("the outbox sweep", () => {
    // The at-least-once half: a run committed but never enqueued (the instance died in between) is
    // found and re-enqueued rather than silently lost.
    it("re-enqueues a pending run that never reached the queue", async () => {
      const h = await harness({}, { unqueuedRunGraceMs: 300_000 });
      const thread = await h.service.threads.create();
      await h.store.runs.create({ thread_id: thread.thread_id, assistant_id: h.assistantId });
      // Past the grace window, so the sweep stops assuming it is merely queued behind a busy worker.
      h.advance(10 * 60_000);

      const summary = await h.scheduler.tickOnce();

      expect(summary.requeued).toBe(1);
      expect(h.queue.enqueued).toHaveLength(1);
    });

    it("leaves a freshly created pending run alone", async () => {
      const h = await harness({}, { unqueuedRunGraceMs: 300_000 });
      const thread = await h.service.threads.create();
      await h.store.runs.create({ thread_id: thread.thread_id, assistant_id: h.assistantId });

      expect((await h.scheduler.tickOnce()).requeued).toBe(0);
    });

    // A run the engine has picked up is not lost, and handing a second worker the same run before
    // it settles would be worse than the problem being solved.
    it("never re-enqueues a running run", async () => {
      const h = await harness({}, { unqueuedRunGraceMs: 300_000 });
      const thread = await h.service.threads.create();
      const run = await h.store.runs.create({
        thread_id: thread.thread_id,
        assistant_id: h.assistantId,
      });
      await h.store.runs.setStatus(run.run_id, "running");
      h.advance(10 * 60_000);

      expect((await h.scheduler.tickOnce()).requeued).toBe(0);
    });

    it("never re-enqueues a finished run", async () => {
      const h = await harness({}, { unqueuedRunGraceMs: 300_000 });
      const thread = await h.service.threads.create();
      const run = await h.store.runs.create({
        thread_id: thread.thread_id,
        assistant_id: h.assistantId,
      });
      await h.store.runs.setStatus(run.run_id, "success");
      h.advance(10 * 60_000);

      expect((await h.scheduler.tickOnce()).requeued).toBe(0);
    });

    // What makes re-enqueueing safe at all: both queues dedupe on run_id, so a run that WAS queued
    // and gets swept anyway does not execute twice.
    it("does not double-queue a run that is already waiting", async () => {
      const h = await harness();
      const thread = await h.service.threads.create();
      const run = await h.store.runs.create({
        thread_id: thread.thread_id,
        assistant_id: h.assistantId,
      });
      const queue = new MemoryRunQueue();
      await queue.enqueue({ run_id: run.run_id, thread_id: thread.thread_id });
      await queue.enqueue({ run_id: run.run_id, thread_id: thread.thread_id });

      const delivered: string[] = [];
      const consumer = queue.consume(async (queued) => {
        delivered.push(queued.run_id);
      });
      await vi.waitFor(() => expect(delivered.length).toBeGreaterThan(0));
      await consumer.close();

      expect(delivered).toEqual([run.run_id]);
    });
  });

  describe("the loop", () => {
    it("is a no-op when disabled", async () => {
      const h = await harness();
      const ctx = createContext(createFixtureDeps({ store: h.store, queue: h.queue }));
      const disabled = createCronScheduler(ctx, { enabled: false });
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });
      h.advance(8 * AN_HOUR_AND_A_BIT);

      disabled.start();
      await vi.waitFor(() => expect(true).toBe(true));
      await disabled.stop();

      expect(h.queue.enqueued).toEqual([]);
    });

    it("ticks on its interval once started", async () => {
      const h = await harness();
      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });
      h.advance(AN_HOUR_AND_A_BIT);
      const scheduler = createCronScheduler(
        createContext(
          createFixtureDeps({ store: h.store, queue: h.queue, clock: () => h.clock.now }),
        ),
        { tickMs: 5, jitterSeed: 0 },
      );

      scheduler.start();
      await vi.waitFor(() => expect(h.queue.enqueued.length).toBeGreaterThan(0));
      await scheduler.stop();
    });

    it("fires nothing more after stop()", async () => {
      const h = await harness();
      const scheduler = createCronScheduler(
        createContext(
          createFixtureDeps({ store: h.store, queue: h.queue, clock: () => h.clock.now }),
        ),
        { tickMs: 5, jitterSeed: 0 },
      );
      scheduler.start();
      await scheduler.stop();

      await h.service.crons.create({ assistant_id: h.assistantId, schedule: "0 * * * *" });
      h.advance(8 * AN_HOUR_AND_A_BIT);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(h.queue.enqueued).toEqual([]);
    });

    // THE resilience case. A tick that rejects must not end scheduling for the life of the
    // process — the failure mode where the server keeps reporting healthy and nothing ever fires
    // again, with nothing in the logs after the first error.
    it("keeps ticking after a tick throws", async () => {
      const h = await harness();
      const store = h.store;
      let calls = 0;
      vi.spyOn(store.crons, "listDue").mockImplementation(async (query) => {
        calls += 1;
        if (calls === 1) throw new Error("transient store failure");
        return new MemorySkeinStore().crons.listDue(query);
      });
      const scheduler = createCronScheduler(
        createContext(createFixtureDeps({ store, queue: h.queue, clock: () => h.clock.now })),
        { tickMs: 5, jitterSeed: 0 },
      );

      scheduler.start();
      // The second call is only reachable if the first failure still scheduled a successor.
      await vi.waitFor(() => expect(calls).toBeGreaterThan(1));
      await scheduler.stop();
    });

    // `finally` survives a throw but not a hang: without the timeout, one stalled store call would
    // wedge the scheduler permanently.
    it("times out a hung tick and keeps ticking", async () => {
      const h = await harness();
      const store = h.store;
      let calls = 0;
      vi.spyOn(store.crons, "listDue").mockImplementation(async (query) => {
        calls += 1;
        // Never settles — a stalled connection, not a thrown error.
        if (calls === 1) return new Promise(() => undefined);
        return new MemorySkeinStore().crons.listDue(query);
      });
      const scheduler = createCronScheduler(
        createContext(createFixtureDeps({ store, queue: h.queue, clock: () => h.clock.now })),
        { tickMs: 5, tickTimeoutMs: 20, jitterSeed: 0 },
      );

      scheduler.start();
      await vi.waitFor(() => expect(calls).toBeGreaterThan(1), { timeout: 2000 });
      await scheduler.stop();
    });

    it("warns once at startup when the store is not durable", async () => {
      const h = await harness();
      const warn = vi.fn();
      const ctx = createContext(
        createFixtureDeps({
          store: h.store,
          queue: h.queue,
          logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
        }),
      );
      const scheduler = createCronScheduler(ctx, { tickMs: 10_000, jitterSeed: 0 });

      scheduler.start();
      await scheduler.stop();

      // A schedule that quietly stops is worse than one that was never created, so this is loud.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("non-durable"));
    });
  });
});
