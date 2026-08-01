// The crons resource: create/read/search/count/update/delete for schedules that fire runs on a
// cadence. Firing them is the scheduler's job (cron-scheduler.ts); this service owns the *record*.
//
// Crons are a LangGraph Platform extension rather than part of the open Agent Protocol spec — the
// OSS `@langchain/langgraph-api` registers the routes and throws "Not implemented" on every one. The
// contract skein matches is the LangSmith Deployment OpenAPI spec plus the `@langchain/langgraph-sdk`
// types, which is the same oracle the rest of the wire surface uses (see docs/reuse.md).
//
// Two invariants live here rather than in a driver, because both need the cron parser:
//
//   * `next_run_date` is derived, never accepted from a caller. It is recomputed on create and on
//     every patch that could move it (`schedule`, `timezone`, `enabled`, `end_time`) — without that,
//     re-enabling a paused cron would leave it dormant forever.
//   * `next_run_date === null` means *dormant*: disabled, or no occurrence left before `end_time`.
//     That is what the wire returns and what drops the row out of the scheduler's due scan.

import {
  SkeinHttpError,
  type Cron,
  type CronAuth,
  type CronCreate,
  type CronSearchQuery,
  type CronUpdate,
  type Metadata,
  type Thread,
} from "@skein-js/core";

import type { ProtocolContext } from "../context.js";

import { assertValidCronSchedule, nextCronOccurrence } from "./cron-schedule.js";

/** A cron create as it arrives from either create route (already validated). */
export interface CreateCronInput {
  assistant_id: string;
  schedule: string;
  /** Absent means a *stateless* cron: every fire gets its own thread. */
  thread_id?: string;
  timezone?: string | null;
  end_time?: string | null;
  enabled?: boolean;
  on_run_completed?: "delete" | "keep";
  metadata?: Metadata;
  /** Everything else on the body — the run payload each fire replays. */
  [key: string]: unknown;
}

/** A cron patch (already validated). Absent leaves a field alone; `null` clears a nullable one. */
export interface UpdateCronInput {
  schedule?: string;
  timezone?: string | null;
  end_time?: string | null;
  enabled?: boolean;
  on_run_completed?: "delete" | "keep";
  metadata?: Metadata;
  [key: string]: unknown;
}

/** Search/count filters as they arrive from the wire (snake_case), before mapping to the repo. */
export interface SearchCronsInput {
  assistant_id?: string;
  thread_id?: string;
  enabled?: boolean;
  metadata?: Metadata;
  limit?: number;
  offset?: number;
  sort_by?: CronSearchQuery["sortBy"];
  sort_order?: "asc" | "desc";
}

export interface CronService {
  create(input: CreateCronInput): Promise<Cron>;
  get(cronId: string): Promise<Cron>;
  search(query: SearchCronsInput): Promise<Cron[]>;
  count(query: SearchCronsInput): Promise<number>;
  update(cronId: string, patch: UpdateCronInput): Promise<Cron>;
  delete(cronId: string): Promise<void>;
}

/**
 * The keys the cron row owns. Everything else on the create body is the run payload — split this way
 * rather than by listing the payload's own keys, so a run field skein does not yet know about still
 * reaches the graph when the cron fires instead of being silently dropped.
 */
const CRON_ROW_KEYS = new Set([
  "assistant_id",
  "schedule",
  "thread_id",
  "timezone",
  "end_time",
  "enabled",
  "on_run_completed",
  "metadata",
  "cron_id",
]);

/** The run-create body a fire replays, i.e. the request minus the scheduling fields. */
function toStoredPayload(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !CRON_ROW_KEYS.has(key) && value !== undefined),
  );
}

/**
 * Canonicalize an accepted timestamp to ISO-8601 UTC, so both drivers store the same string.
 *
 * Without this the drivers disagree on what they hand back: Postgres round-trips `end_time` through
 * `timestamptz` and returns `2030-01-01T00:00:00.000Z`, while the memory driver stores whatever the
 * caller typed (`2030-01-01T00:00:00Z`, or any valid offset form). Normalizing once here — above
 * both drivers, where the wire contract lives — is what keeps a response from depending on which
 * store a deployment happens to run.
 *
 * Zod has already checked the format, so an unparseable value is not reachable from the HTTP layer;
 * it is passed through rather than thrown on, since this is a normalizer and not a validator.
 */
function toIsoUtc(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

export function createCronService(ctx: ProtocolContext): CronService {
  const { deps, authUser, authScopes } = ctx;

  const requireCron = async (cronId: string): Promise<Cron> => {
    const cron = await deps.store.crons.get(cronId);
    if (!cron) throw SkeinHttpError.notFound(`Cron "${cronId}" not found.`);
    return cron;
  };

  /**
   * The thread a cron is being attached to, as *this caller* is allowed to see it — or `null` when
   * they may not run on it, which reads the same as it not existing.
   *
   * Consults the `threads` resource directly (see the call site for why the request's own scoped
   * store is not enough). With no auth engine configured this is a plain read, so `skein dev` is
   * unaffected.
   */
  const readThreadForCaller = async (
    threadId: string,
    assistantId: string,
  ): Promise<Thread | null> => {
    const thread = await deps.store.threads.get(threadId);
    if (!thread || !deps.auth?.enabled || !authUser) return thread;
    const { filters } = await deps.auth.authorize({
      resource: "threads",
      action: "create_run",
      // The same `value` shape the scheduler passes at fire time, `assistant_id` included. A handler
      // that gates on `value.assistant_id` — the documented way to express per-assistant permissions
      // — would otherwise be asked a different question here than at every subsequent fire, and a
      // cron accepted at create would then fail on every occurrence forever (or the reverse).
      value: { thread_id: threadId, assistant_id: assistantId },
      context: { user: authUser, scopes: authScopes ?? [] },
    });
    // No filters means the caller's thread handler allowed this outright (or scopes nothing).
    if (!filters) return thread;
    return deps.auth.matchesFilters(thread.metadata ?? undefined, filters) ? thread : null;
  };

  /**
   * Where a cron should point right now, given its schedule and switches. The single place the
   * dormant rule is applied, so create and patch cannot disagree about it.
   */
  const resolveNextRunDate = (cron: {
    schedule: string;
    timezone?: string | null;
    end_time?: string | null;
    enabled: boolean;
  }): string | null =>
    cron.enabled
      ? nextCronOccurrence({
          schedule: cron.schedule,
          timezone: cron.timezone,
          // Strictly after *now*, so a cron created at 09:00:00 with `0 9 * * *` waits for tomorrow
          // rather than firing immediately for an occurrence that is already happening.
          after: deps.clock(),
          endTime: cron.end_time,
        })
      : null;

  return {
    create: async (input) => {
      assertValidCronSchedule(input.schedule, input.timezone);

      // Resolved before the thread is touched, so a bad assistant id never leaves a cron behind.
      const assistant = await deps.store.assistants.get(input.assistant_id);
      if (!assistant) {
        throw SkeinHttpError.notFound(`Assistant "${input.assistant_id}" not found.`);
      }
      // A thread cron must name a thread that exists **and that this caller may run on**.
      //
      // Authorized against `threads:create_run` explicitly rather than relying on the request's own
      // scoped store, and that is not belt-and-braces — it closes a real hole. This route authorizes
      // under the `crons` resource, so the store handed to this service scopes *crons*; its `threads`
      // repo carries only the read gate the crons branch adds, and that gate compares against the
      // **crons** filters. Where a deployment's cron and thread handlers return different filter
      // shapes, that gate is weaker than thread ownership. Asking the thread resource directly is the
      // only way to get the answer thread ownership would give — and it asks it with the same
      // resource, action and `value` shape the scheduler uses, so create-time and fire-time agree.
      //
      // A 404 rather than a 403 for a thread the caller cannot see, matching how every other
      // ownership-scoped read hides a foreign row rather than confirming it exists.
      if (input.thread_id !== undefined) {
        const thread = await readThreadForCaller(input.thread_id, assistant.assistant_id);
        if (!thread) throw SkeinHttpError.notFound(`Thread "${input.thread_id}" not found.`);
      }

      const enabled = input.enabled ?? true;
      const timezone = input.timezone ?? null;
      const endTime = toIsoUtc(input.end_time) ?? null;
      const stateless = input.thread_id === undefined;

      const cronCreate: CronCreate = {
        assistant_id: assistant.assistant_id,
        schedule: input.schedule,
        thread_id: input.thread_id ?? null,
        timezone,
        end_time: endTime,
        enabled,
        next_run_date: resolveNextRunDate({
          schedule: input.schedule,
          timezone,
          end_time: endTime,
          enabled,
        }),
        // Resolved here and persisted, so the wire row always says what will actually happen.
        //
        // Defaults to `"delete"` for a stateless cron, matching LangGraph — and deliberately unlike
        // skein's own `on_completion` default of `"keep"` for one-off stateless runs. A cron is the
        // case where the difference matters: a five-minutely schedule keeping every thread accrues
        // six figures of them a year, and nobody is watching. Documented in docs/crons.md.
        //
        // A thread cron gets nothing at all: the thread is the caller's, not the run's.
        ...(stateless ? { on_run_completed: input.on_run_completed ?? "delete" } : {}),
        payload: toStoredPayload(input),
        metadata: input.metadata ?? {},
        user_id: authUser?.identity ?? null,
        // The principal each fire replays. Beside the row and never on the wire — see `CronAuth`.
        ...(authUser ? { auth: { user: authUser, scopes: authScopes } satisfies CronAuth } : {}),
      };

      return deps.store.crons.create(cronCreate);
    },

    get: requireCron,

    search: async (query) =>
      deps.store.crons.search({
        assistant_id: query.assistant_id,
        thread_id: query.thread_id,
        enabled: query.enabled,
        metadata: query.metadata,
        limit: query.limit,
        offset: query.offset,
        sortBy: query.sort_by,
        sortOrder: query.sort_order,
      }),

    count: async (query) =>
      deps.store.crons.count({
        assistant_id: query.assistant_id,
        thread_id: query.thread_id,
        enabled: query.enabled,
        metadata: query.metadata,
      }),

    update: async (cronId, patch) => {
      const existing = await requireCron(cronId);

      // Validate against the *resolved* pair, not the patch alone: changing only the timezone has to
      // be checked against the stored schedule, and vice versa.
      const schedule = patch.schedule ?? existing.schedule;
      const timezone = patch.timezone !== undefined ? patch.timezone : (existing.timezone ?? null);
      if (patch.schedule !== undefined || patch.timezone !== undefined) {
        assertValidCronSchedule(schedule, timezone);
      }

      const endTime =
        patch.end_time !== undefined
          ? (toIsoUtc(patch.end_time) ?? null)
          : (existing.end_time ?? null);
      const enabled = patch.enabled ?? existing.enabled;

      // Recomputed whenever the patch touches anything that moves the next occurrence. Leaving it
      // alone here is the bug that makes a re-enabled cron never fire again.
      const movesNextRun =
        patch.schedule !== undefined ||
        patch.timezone !== undefined ||
        patch.enabled !== undefined ||
        patch.end_time !== undefined;

      const storedPayload = toStoredPayload(patch);

      const cronUpdate: CronUpdate = {
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.end_time !== undefined ? { end_time: endTime } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.on_run_completed !== undefined
          ? { on_run_completed: patch.on_run_completed }
          : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        // Replaced wholesale rather than merged, unlike metadata: the payload is one run request, and
        // a half-replaced one (new `input`, stale `config`) is not a request anybody asked for.
        // Absent when the patch carries no run fields, so a metadata-only patch keeps the payload.
        ...(Object.keys(storedPayload).length > 0 ? { payload: storedPayload } : {}),
        ...(movesNextRun
          ? {
              next_run_date: resolveNextRunDate({ schedule, timezone, end_time: endTime, enabled }),
            }
          : {}),
      };

      return deps.store.crons.update(cronId, cronUpdate);
    },

    delete: async (cronId) => {
      // Read first so deleting an unknown cron is a 404 rather than a silent 200 — the wire contract
      // documents 404 for this route, and a client that mistypes an id should hear about it.
      await requireCron(cronId);
      await deps.store.crons.delete(cronId);
    },
  };
}
