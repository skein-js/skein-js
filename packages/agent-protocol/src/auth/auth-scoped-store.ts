// A per-request `SkeinStore` decorator that enforces the ownership filters an `@auth.on.*` handler
// returned: reads are filtered (a resource the caller doesn't own reads as absent — a 404, never a
// 403, so ownership isn't revealed), and creates stamp the filter's values into metadata so later
// filtered reads match. It guards only the `threads` resource family — threads + their runs (runs
// inherit their thread's owner and have no resource of their own). `assistants` and `store` are
// gate-only (the `@auth.on.*` handler can still deny, but no ownership filter is applied): graph
// assistants are auto-registered with no owner and must stay visible to every caller, and store
// items carry no metadata to filter on. Per-owner scoping of those two is a Depth-2 follow-up.
//
// Ownership scoping is pushed into the driver query (`enforcedMetadata`), so a read returns only the
// caller's own rows; the in-process `matchesFilters` pass over the result is what actually enforces it,
// because the translation errs broad. See `auth-filters-to-metadata.ts`.

import {
  SkeinHttpError,
  type AuthEngine,
  type AuthFilters,
  type AuthResource,
  type Metadata,
  type RunRepo,
  type SkeinStore,
  type ThreadRepo,
} from "@skein-js/core";

import { authFiltersToMetadataSubset } from "./auth-filters-to-metadata.js";

/** Merge a filter's values into metadata so a created resource satisfies its own filter. */
function stampFromFilters(metadata: Metadata | undefined, filters: AuthFilters): Metadata {
  const stamped: Metadata = { ...(metadata ?? {}) };
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string") {
      stamped[key] = value;
    } else if (typeof value.$eq === "string") {
      stamped[key] = value.$eq;
    } else if (value.$contains !== undefined) {
      // Satisfy a membership filter by ensuring the required member(s) are in the stamped array;
      // preserve any the caller already supplied (and dedupe), so `matchesFilters` matches the row.
      const required = Array.isArray(value.$contains) ? value.$contains : [value.$contains];
      const current = Array.isArray(stamped[key]) ? (stamped[key] as unknown[]) : [];
      stamped[key] = [...new Set([...current, ...required])];
    }
  }
  return stamped;
}

/**
 * Wrap `inner` so the request's ownership `filters` scope its primary `resource` family. When
 * `filters` is undefined (no `@auth.on.*` handler matched, or no authenticated user), the store is
 * returned unchanged — the common, zero-overhead path.
 */
export function createAuthScopedStore(
  inner: SkeinStore,
  engine: AuthEngine,
  filters: AuthFilters | undefined,
  resource: AuthResource,
): SkeinStore {
  if (!filters) return inner;
  const matches = (metadata: Metadata | null | undefined): boolean =>
    engine.matchesFilters(metadata ?? undefined, filters);
  const stamp = (metadata: Metadata | null | undefined): Metadata =>
    stampFromFilters(metadata ?? undefined, filters);
  // The same filters as a metadata subset a driver can match, so ownership scoping is a WHERE clause
  // rather than a full read plus a JS pass.
  const ownershipMetadata = authFiltersToMetadataSubset(filters);

  if (resource === "threads") {
    const threads: ThreadRepo = {
      // Routed through `search` so the ownership filter is applied by the *driver*: `list` itself takes
      // no filter, and reading a page and filtering it afterwards returns nothing at all to an owner
      // whose threads sit past the page bound. `sortBy: created_at` ascending is `list`'s own ordering.
      list: () => threads.search({ sortBy: "created_at", sortOrder: "asc" }),
      search: async (query) => {
        // The ownership filter goes into the query, so the driver returns only rows this caller owns —
        // one indexed lookup instead of reading every matching row (each carrying a thread's full
        // mirrored graph state) to sift in JS. `limit`/`offset` therefore page owned rows directly.
        //
        // `enforcedMetadata` is *dropped* from the caller's query before the server's own is applied:
        // the search schema passes unknown fields through, so a request body naming it must not be able
        // to influence the scoping — including when the ownership filter translates to nothing.
        const { enforcedMetadata: _fromCaller, ...requested } = query;
        const owned = await inner.threads.search({
          ...requested,
          ...(ownershipMetadata ? { enforcedMetadata: ownershipMetadata } : {}),
        });
        // This is what actually enforces ownership: `authFiltersToMetadataSubset` deliberately errs broad,
        // leaving out any clause it cannot express exactly.
        //
        // It can only ever *shorten* a page, never leak a row — but a short page is not free. Paging is
        // exact only while the translation is (which it is for every shape `AuthFilterValue` declares); a
        // custom engine whose `matchesFilters` is stricter than its own filters would produce sparse
        // pages, and `offset` would then skip matched-but-unowned rows. That is the trade for one query
        // instead of a drain over every row in the table.
        return owned.filter((thread) => matches(thread.metadata));
      },
      /**
       * Counted with the ownership scoping pushed into the driver, like `search` — so a caller is told
       * how many threads *they* have, not how many exist.
       *
       * The one asymmetry with `search`: there is no result set to re-filter here, so a count relies on
       * `authFiltersToMetadataSubset` alone. That translation deliberately errs *broad* (it omits any
       * clause it cannot express exactly), so for a custom engine whose `matchesFilters` is stricter
       * than its own filters the count can exceed what `search` would return. Every shape
       * `AuthFilterValue` declares translates exactly, so the two agree in practice — and erring high
       * on a count is the harmless direction, where erring high on a *read* would leak a row.
       */
      count: async (query) => {
        const { enforcedMetadata: _fromCaller, ...requested } = query;
        return inner.threads.count({
          ...requested,
          ...(ownershipMetadata ? { enforcedMetadata: ownershipMetadata } : {}),
        });
      },
      get: async (threadId) => {
        const thread = await inner.threads.get(threadId);
        return thread && matches(thread.metadata) ? thread : null;
      },
      create: async (input) => {
        // A caller-supplied `thread_id` must not collide with a thread owned by someone else. The
        // decorator hides foreign threads on read, so a run's `ensureThread` (get-then-create) would
        // otherwise re-create a hidden thread under the caller — a cross-tenant takeover.
        //
        // Still needed now that both drivers reject a duplicate id: the driver's 409 says "this id is
        // taken", which for a thread the caller cannot see is an existence oracle. Answering the same
        // 404 a hidden thread already reads as tells them nothing. It also keeps `if_exists:
        // "do_nothing"` honest — that recovers by re-reading through this decorator, so a foreign
        // thread is never handed back.
        if (input?.thread_id !== undefined) {
          const existing = await inner.threads.get(input.thread_id);
          if (existing && !matches(existing.metadata)) {
            throw SkeinHttpError.notFound(`Thread "${input.thread_id}" not found.`);
          }
        }
        return inner.threads.create({ ...input, metadata: stamp(input?.metadata) });
      },
      update: async (threadId, patch) => {
        const thread = await inner.threads.get(threadId);
        if (!thread || !matches(thread.metadata)) {
          throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
        }
        // Re-stamp when the patch touches metadata, so a caller can't drop their own owner tag.
        const next =
          patch.metadata !== undefined ? { ...patch, metadata: stamp(patch.metadata) } : patch;
        return inner.threads.update(threadId, next);
      },
      copy: async (threadId) => {
        const thread = await inner.threads.get(threadId);
        if (!thread || !matches(thread.metadata)) {
          throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
        }
        // The copy inherits the source's metadata (already owner-stamped), so it stays owned by the caller.
        return inner.threads.copy(threadId);
      },
      delete: async (threadId) => {
        const thread = await inner.threads.get(threadId);
        if (!thread || !matches(thread.metadata)) {
          throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
        }
        return inner.threads.delete(threadId);
      },
    };

    const runs: RunRepo = {
      ...inner.runs,
      get: async (runId) => {
        const run = await inner.runs.get(runId);
        return run && matches(run.metadata) ? run : null;
      },
      // The caller's `limit`/`offset` are applied *here*, after the ownership filter, so a page holds
      // owned rows rather than owned-rows-within-a-page. `status` is forwarded to the driver instead
      // (it is not an ownership concern, and pushing it down keeps the read narrow).
      listByThread: async (threadId, query) => {
        const matchingRuns = (
          await inner.runs.listByThread(
            threadId,
            query?.status !== undefined ? { status: query.status } : undefined,
          )
        ).filter((run) => matches(run.metadata));
        const offset = query?.offset ?? 0;
        const end = query?.limit === undefined ? undefined : offset + query.limit;
        return matchingRuns.slice(offset, end);
      },
      // `hasActiveRun` and `listActiveRuns` are deliberately inherited **unfiltered** (via the spread
      // above). They are the per-thread concurrency guard, not a user-facing read: filtering them by
      // ownership would hide another principal's inflight run from the guard, and two runs would then
      // execute on one thread and interleave their checkpoint writes. Nothing leaks — the thread itself
      // is ownership-gated, so a caller cannot reach the guard for a thread it does not own, and
      // `POST /runs/cancel` re-authorizes every run it sweeps through the filtered `get`.
      create: (input) => inner.runs.create({ ...input, metadata: stamp(input.metadata) }),
      // Stamped the same way as `create`, so a run created through the `reject` guard is owned by its
      // caller too. The guard's inflight check is deliberately NOT ownership-filtered — see the note on
      // `listActiveRuns` above: it must see every inflight run on the thread, whoever started it.
      createIfThreadIdle: (input) =>
        inner.runs.createIfThreadIdle({ ...input, metadata: stamp(input.metadata) }),
      // `error` must be forwarded: dropping it here compiles fine and would silently discard every
      // run failure reason on every auth-enabled deployment.
      setStatus: async (runId, status, error) => {
        const run = await inner.runs.get(runId);
        if (!run || !matches(run.metadata)) {
          throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
        }
        return inner.runs.setStatus(runId, status, error);
      },
      delete: async (runId) => {
        const run = await inner.runs.get(runId);
        if (!run || !matches(run.metadata)) {
          throw SkeinHttpError.notFound(`Run "${runId}" not found.`);
        }
        return inner.runs.delete(runId);
      },
    };

    // `maxPageSize` is carried explicitly. Both drivers expose it as a class **getter**, and object
    // spread copies own enumerable properties only — a prototype accessor is silently dropped, so the
    // spread alone would hand back a store whose bound reads as `undefined`. That is invisible at the
    // type level (the field is optional) and would quietly disable `cancelMany`'s truncation reporting
    // on exactly the auth-enabled deployments where it matters.
    return { ...inner, threads, runs, maxPageSize: inner.maxPageSize };
  }

  if (resource === "crons") {
    const crons = {
      // `listDue`, `claimAndCreateRun`, `claimNextRun`, `getAuth` and `maxOverdueMs` are inherited
      // **unfiltered** through this spread, for the same reason `listActiveRuns` is above: they are
      // scheduler machinery, not user-facing reads, and a filtered version would hide a cron from the
      // very loop that has to fire it. Nothing leaks either — this decorator is only ever built
      // per-request in `authorizing-handlers.ts`, while the scheduler runs off the base context and
      // never sees a filtered store at all.
      ...inner.crons,
      get: async (cronId: string) => {
        const cron = await inner.crons.get(cronId);
        return cron && matches(cron.metadata) ? cron : null;
      },
      search: async (query: Parameters<SkeinStore["crons"]["search"]>[0]) => {
        // Ownership goes into the driver query, so paging walks owned rows rather than
        // owned-rows-within-a-page. The caller's own `enforcedMetadata` is dropped first: it is the
        // server's field, and honouring a caller-supplied one would let them widen their own scope.
        const { enforcedMetadata: _fromCaller, ...requested } = query;
        const found = await inner.crons.search({
          ...requested,
          ...(ownershipMetadata ? { enforcedMetadata: ownershipMetadata } : {}),
        });
        // The in-process pass is what actually enforces it — the metadata translation errs broad.
        return found.filter((cron) => matches(cron.metadata));
      },
      count: async (query: Parameters<SkeinStore["crons"]["count"]>[0]) => {
        const { enforcedMetadata: _fromCaller, ...requested } = query;
        return inner.crons.count({
          ...requested,
          ...(ownershipMetadata ? { enforcedMetadata: ownershipMetadata } : {}),
        });
      },
      create: (input: Parameters<SkeinStore["crons"]["create"]>[0]) =>
        inner.crons.create({ ...input, metadata: stamp(input.metadata) }),
      update: async (cronId: string, patch: Parameters<SkeinStore["crons"]["update"]>[1]) => {
        const cron = await inner.crons.get(cronId);
        if (!cron || !matches(cron.metadata)) {
          throw SkeinHttpError.notFound(`Cron "${cronId}" not found.`);
        }
        // Re-stamp when the patch touches metadata, so a caller can't drop their own owner tag and
        // orphan the cron out of their own listing.
        const next =
          patch.metadata !== undefined ? { ...patch, metadata: stamp(patch.metadata) } : patch;
        return inner.crons.update(cronId, next);
      },
      delete: async (cronId: string) => {
        const cron = await inner.crons.get(cronId);
        if (!cron || !matches(cron.metadata)) {
          throw SkeinHttpError.notFound(`Cron "${cronId}" not found.`);
        }
        return inner.crons.delete(cronId);
      },
    };

    // A thread cron must not be attachable to a thread the caller cannot see. This route's resource
    // is `crons`, so the `threads` branch above does not run and `inner.threads` would be unscoped —
    // which would let `POST /threads/{tid}/runs/crons` schedule runs onto another tenant's thread.
    // Only the one read the cron service performs needs gating: nothing here creates or writes a
    // thread, and the fired run does its own stamping under the `threads` resource at fire time.
    const threads: ThreadRepo = {
      ...inner.threads,
      get: async (threadId) => {
        const thread = await inner.threads.get(threadId);
        return thread && matches(thread.metadata) ? thread : null;
      },
    };

    // `maxPageSize` carried explicitly for the same prototype-getter reason as the threads branch.
    return { ...inner, crons, threads, maxPageSize: inner.maxPageSize };
  }

  // `assistants` and `store` are gate-only in Depth 1: the `@auth.on.*` handler still runs (it can
  // deny with 403), but we do NOT apply its ownership filter. Assistants are auto-registered from the
  // graphs with no owner metadata, so filtering them would hide the shared/system assistants every
  // caller needs to run; store items carry no metadata to filter on. Per-owner scoping of these two
  // resources is a Depth-2 follow-up (see docs/roadmap.md).
  return inner;
}
