// Relative-time formatting, both directions.
//
// `formatRelative` used to compute `now - date` and test `< 60`, so a future date landed on the
// seconds rung with a negative count: a cron due in two hours rendered `-7200s ago`. Crons is the only
// view that renders a future timestamp, and the next-occurrence column is the reason that view exists.
//
// `now` is injected rather than mocked so every case is a pure assertion on a string.

import { describe, expect, it } from "vitest";

import { formatRelative } from "./parts.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const at = (secondsFromNow: number): Date => new Date(NOW + secondsFromNow * 1000);

describe("formatRelative — past", () => {
  it("keeps the terse rungs byte-for-byte", () => {
    // Unchanged output matters: eight of the nine `Timestamp` call sites render `created_at` or
    // `updated_at`, and none of them should move because Crons needed fixing.
    expect(formatRelative(at(0), NOW)).toBe("0s ago");
    expect(formatRelative(at(-45), NOW)).toBe("45s ago");
    expect(formatRelative(at(-90), NOW)).toBe("2m ago");
    expect(formatRelative(at(-7200), NOW)).toBe("2h ago");
  });

  it("falls through to a calendar date past a day, as it always did", () => {
    // A distant past row is read off a calendar, so this rung deliberately does *not* gain `d`/`mo`.
    expect(formatRelative(at(-5 * 86_400), NOW)).toBe(
      new Date(NOW - 5 * 86_400_000).toLocaleDateString(),
    );
  });
});

describe("formatRelative — future", () => {
  it("reads forwards instead of signing the count", () => {
    // The bug, at the rung it was reported on: `-7200s ago` for a schedule due in two hours.
    expect(formatRelative(at(7200), NOW)).toBe("in 2h");
    expect(formatRelative(at(30), NOW)).toBe("in 30s");
    expect(formatRelative(at(120), NOW)).toBe("in 2m");
  });

  it("keeps counting past a day, so a far-off schedule stays legible", () => {
    // `crons.tsx` exists to make "never, or a year away" look different from healthy. `in 8760h`
    // does not, and neither would a bare date.
    expect(formatRelative(at(3 * 86_400), NOW)).toBe("in 3d");
    expect(formatRelative(at(60 * 86_400), NOW)).toBe("in 2mo");
    expect(formatRelative(at(365 * 86_400), NOW)).toBe("in 12mo");
  });
});

describe("formatRelative — rung tops promote instead of rounding into their own ceiling", () => {
  it("never renders a count at its rung's ceiling", () => {
    // The rung ceiling applies to the *rounded* count, not the raw seconds. Bounding the seconds let
    // a value round up into its own ceiling: an hourly cron just under the hour read `in 60m`, and a
    // daily one `in 24h`. Hourly is the commonest schedule there is, so this is the live case.
    expect(formatRelative(at(3599), NOW)).toBe("in 1h");
    expect(formatRelative(at(-3599), NOW)).toBe("1h ago");
    expect(formatRelative(at(86_399), NOW)).toBe("in 1d");
    expect(formatRelative(at(30 * 86_400 - 1), NOW)).toBe("in 1mo");
  });

  it("promotes a nearly-day-old past row to a date rather than `24h ago`", () => {
    // The one place past output moves, and deliberately: the same promotion that makes `in 24h` read
    // `in 1d` sends the last half hour before a day old to the calendar rung instead.
    expect(formatRelative(at(-86_399), NOW)).toBe(new Date(NOW - 86_399_000).toLocaleDateString());
  });
});

describe("formatRelative — the sub-minute boundary in both directions", () => {
  it("renders a small clock skew as ahead, not as a negative past", () => {
    // Not hypothetical: when the server clock leads the browser's, a just-created row is a few
    // seconds in the future and used to render `-3s ago`.
    expect(formatRelative(at(3), NOW)).toBe("in 3s");
  });

  it("crosses each rung boundary without changing sign", () => {
    expect(formatRelative(at(-59), NOW)).toBe("59s ago");
    expect(formatRelative(at(-60), NOW)).toBe("1m ago");
    expect(formatRelative(at(59), NOW)).toBe("in 59s");
    expect(formatRelative(at(60), NOW)).toBe("in 1m");
    expect(formatRelative(at(86_400), NOW)).toBe("in 1d");
  });
});
