// A per-request `SkeinStore` decorator that enforces the ownership filters an `@auth.on.*` handler
// returned: reads are filtered (a resource the caller doesn't own reads as absent — a 404, never a
// 403, so ownership isn't revealed), and creates stamp the filter's values into metadata so later
// filtered reads match. It guards only the `threads` resource family — threads + their runs (runs
// inherit their thread's owner and have no resource of their own). `assistants` and `store` are
// gate-only (the `@auth.on.*` handler can still deny, but no ownership filter is applied): graph
// assistants are auto-registered with no owner and must stay visible to every caller, and store
// items carry no metadata to filter on. Per-owner scoping of those two is a Depth-2 follow-up.
//
// Depth-1 note: filtering happens in-process after a full fetch. Correct and parity-complete;
// pushing filters into SQL for scale is a separate follow-up (docs/roadmap.md).

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

  if (resource === "threads") {
    const threads: ThreadRepo = {
      list: async () => (await inner.threads.list()).filter((thread) => matches(thread.metadata)),
      search: async (query) => {
        // Pagination must count only rows this caller owns, so strip limit/offset from the inner
        // query, apply the ownership filter, then paginate here. (Ownership filtering is in-process
        // today — see the SQL-pushdown follow-up in docs/roadmap.md.)
        const { limit, offset, ...filters } = query;
        const owned = (await inner.threads.search(filters)).filter((thread) =>
          matches(thread.metadata),
        );
        const start = offset ?? 0;
        return owned.slice(start, limit === undefined ? undefined : start + limit);
      },
      get: async (threadId) => {
        const thread = await inner.threads.get(threadId);
        return thread && matches(thread.metadata) ? thread : null;
      },
      create: async (input) => {
        // A caller-supplied `thread_id` must not clobber (memory driver) or collide with (postgres)
        // a thread owned by someone else. The decorator hides foreign threads on read, so a run's
        // `ensureThread` (get-then-create) would otherwise re-create a hidden thread under the
        // caller — a cross-tenant takeover. Reject with the same 404 a hidden thread reads as.
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
      listByThread: async (threadId) =>
        (await inner.runs.listByThread(threadId)).filter((run) => matches(run.metadata)),
      create: (input) => inner.runs.create({ ...input, metadata: stamp(input.metadata) }),
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

    return { ...inner, threads, runs };
  }

  // `assistants` and `store` are gate-only in Depth 1: the `@auth.on.*` handler still runs (it can
  // deny with 403), but we do NOT apply its ownership filter. Assistants are auto-registered from the
  // graphs with no owner metadata, so filtering them would hide the shared/system assistants every
  // caller needs to run; store items carry no metadata to filter on. Per-owner scoping of these two
  // resources is a Depth-2 follow-up (see docs/roadmap.md).
  return inner;
}
