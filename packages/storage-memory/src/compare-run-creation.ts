import type { Run } from "@skein-js/core";

/** Match Postgres C and SQLite binary collation, including identifiers outside the BMP. */
export function compareRunCreation(first: Run, second: Run): number {
  if (first.created_at !== second.created_at) return first.created_at < second.created_at ? 1 : -1;
  const firstId = Array.from(first.run_id);
  const secondId = Array.from(second.run_id);
  for (let index = 0; index < Math.min(firstId.length, secondId.length); index++) {
    const difference = secondId[index]!.codePointAt(0)! - firstId[index]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return secondId.length - firstId.length;
}
