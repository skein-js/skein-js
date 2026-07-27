// Percentiles over a sample array. Small enough to keep local — pulling a stats dependency into a
// private benchmark would be more moving parts than the four lines it replaces.

/**
 * Nearest-rank percentile of `samples`. Returns 0 for an empty input so a scenario that produced no
 * measurements reports a zero rather than a `NaN` that poisons every downstream diff.
 *
 * Sorts a copy: callers reuse their sample arrays across metrics.
 */
export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)] ?? 0;
}

/** Largest sample, or 0 when there are none. */
export function peak(samples: readonly number[]): number {
  return samples.reduce((highest, sample) => (sample > highest ? sample : highest), 0);
}
