// Metadata containment, mirroring Postgres' JSONB `@>` so the memory driver, the conformance suite
// and the Postgres driver all agree on what a metadata filter matches.

/**
 * True if `subject` contains `filter`, mirroring Postgres' JSONB `@>` operator so the memory driver,
 * the conformance suite, and the Postgres driver all agree on metadata/values matching. Containment is
 * recursive: an object matches on a *subset* of its keys (nested objects included), an array matches as
 * a set (every filter element is contained in some subject element), and scalars match by equality. An
 * empty (or absent) filter matches everything.
 */
export function isMetadataSubset(subject: unknown, filter: unknown): boolean {
  if (filter === undefined || filter === null) return true;
  return jsonbContains(subject, filter);
}

function jsonbContains(subject: unknown, filter: unknown): boolean {
  // Scalars (and null): plain equality, like `'1'::jsonb @> '1'::jsonb`.
  if (filter === null || typeof filter !== "object") return subject === filter;
  // Array filter: every element must be contained in some element of the subject array (set semantics).
  if (Array.isArray(filter)) {
    if (!Array.isArray(subject)) return false;
    return filter.every((wanted) => subject.some((candidate) => jsonbContains(candidate, wanted)));
  }
  // Object filter: match on a subset of keys, recursively. An empty object matches any value.
  const entries = Object.entries(filter as Record<string, unknown>);
  if (entries.length === 0) return true;
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) return false;
  const row = subject as Record<string, unknown>;
  return entries.every(([key, value]) => key in row && jsonbContains(row[key], value));
}
