import type { RunSearchQuery } from "@skein-js/core";

/** Fixed identifiers/operators, bound values: no query input is interpolated into SQL. */
export function runSearchWhere(query: RunSearchQuery): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const [column, value, operator] of [
    ["status", query.status, "="],
    ["assistant_id", query.assistantId, "="],
    ["thread_id", query.threadId, "="],
    ["created_at", query.createdAfter, ">="],
    ["created_at", query.createdBefore, "<"],
    ["updated_at", query.updatedAfter, ">="],
    ["updated_at", query.updatedBefore, "<"],
  ] as const) {
    if (value === undefined) continue;
    params.push(value);
    clauses.push(`${column} ${operator} $${params.length}`);
  }
  if (query.enforcedMetadata && Object.keys(query.enforcedMetadata).length > 0) {
    params.push(JSON.stringify(query.enforcedMetadata));
    clauses.push(`metadata @> $${params.length}::jsonb`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}
