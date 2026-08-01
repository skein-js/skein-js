// Cron math is a pure function of (expression, timezone, instant), so all of it is testable with
// literal dates — no clock, no timers, no infrastructure. The DST cases are the reason this file
// exists: they are where hand-rolled cron code is wrong, and where a library swap would show up.

import { SkeinHttpError } from "@skein-js/core";
import { describe, expect, it } from "vitest";

import {
  advanceCronOccurrence,
  assertValidCronSchedule,
  nextCronOccurrence,
} from "./cron-schedule.js";

describe("assertValidCronSchedule", () => {
  it("accepts a standard 5-field expression", () => {
    expect(() => assertValidCronSchedule("*/5 * * * *")).not.toThrow();
    expect(() => assertValidCronSchedule("0 9 * * 1-5")).not.toThrow();
    expect(() => assertValidCronSchedule("0 */6 * * *", "America/New_York")).not.toThrow();
  });

  // croner accepts all three of these; LangGraph Platform does not, and a drop-in that silently ran
  // `0 0 9 * * *` at a different time than the author's crontab says would be worse than a 422.
  it.each([
    ["6-field seconds-first", "0 0 9 * * *"],
    ["a nickname", "@daily"],
    ["too few fields", "* * *"],
    ["empty", "   "],
  ])("rejects %s", (_label, schedule) => {
    expect(() => assertValidCronSchedule(schedule)).toThrow(SkeinHttpError);
  });

  it("reports the 5-field rule in the message, matching LangGraph", () => {
    expect(() => assertValidCronSchedule("0 0 9 * * *")).toThrow(/5-field/);
  });

  it("rejects an unparseable expression inside five fields", () => {
    expect(() => assertValidCronSchedule("nonsense here is bad")).toThrow(SkeinHttpError);
    expect(() => assertValidCronSchedule("99 * * * *")).toThrow(SkeinHttpError);
  });

  it("rejects an unknown IANA zone", () => {
    expect(() => assertValidCronSchedule("* * * * *", "Mars/Olympus")).toThrow(SkeinHttpError);
  });

  it("answers 422, so a bad schedule is a validation failure rather than a server error", () => {
    try {
      assertValidCronSchedule("@daily");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as SkeinHttpError).status).toBe(422);
    }
  });
});

describe("nextCronOccurrence", () => {
  it("returns the first occurrence strictly after the given instant", () => {
    expect(
      nextCronOccurrence({ schedule: "0 9 * * *", after: new Date("2026-08-01T00:00:00Z") }),
    ).toBe("2026-08-01T09:00:00.000Z");
  });

  it("is exclusive of the instant it is given", () => {
    // Otherwise a claim that advanced from its own occurrence would land right back on it and the
    // cron would fire in a tight loop.
    expect(
      nextCronOccurrence({ schedule: "0 9 * * *", after: new Date("2026-08-01T09:00:00Z") }),
    ).toBe("2026-08-02T09:00:00.000Z");
  });

  it("defaults to UTC when no timezone is given", () => {
    for (const timezone of [undefined, null]) {
      expect(
        nextCronOccurrence({
          schedule: "0 9 * * *",
          timezone,
          after: new Date("2026-08-01T00:00:00Z"),
        }),
      ).toBe("2026-08-01T09:00:00.000Z");
    }
  });

  it("reads the expression in the given IANA zone", () => {
    // 09:00 in New York on 2026-08-03 is EDT (UTC-4), so 13:00Z.
    expect(
      nextCronOccurrence({
        schedule: "0 9 * * *",
        timezone: "America/New_York",
        after: new Date("2026-08-03T00:00:00Z"),
      }),
    ).toBe("2026-08-03T13:00:00.000Z");
  });

  it("honours weekday ranges", () => {
    // 2026-08-01 is a Saturday, so the next weekday 09:00 is Monday the 3rd.
    expect(
      nextCronOccurrence({ schedule: "0 9 * * 1-5", after: new Date("2026-08-01T00:00:00Z") }),
    ).toBe("2026-08-03T09:00:00.000Z");
  });

  // DST spring-forward: on 2026-03-08 New York jumps 02:00 -> 03:00, so 02:30 never happens. The
  // occurrence must shift forward into the same day rather than being skipped entirely — a daily
  // cron silently missing one day a year is the classic scheduler bug.
  it("shifts a daily occurrence through the DST spring-forward gap", () => {
    const beforeGap = nextCronOccurrence({
      schedule: "30 2 * * *",
      timezone: "America/New_York",
      after: new Date("2026-03-06T12:00:00Z"),
    });
    // 2026-03-07 02:30 EST (UTC-5) = 07:30Z.
    expect(beforeGap).toBe("2026-03-07T07:30:00.000Z");

    const acrossGap = nextCronOccurrence({
      schedule: "30 2 * * *",
      timezone: "America/New_York",
      after: new Date("2026-03-07T12:00:00Z"),
    });
    // The 8th still fires — at 03:30 EDT, which is also 07:30Z — rather than being skipped.
    expect(acrossGap).toBe("2026-03-08T07:30:00.000Z");

    const afterGap = nextCronOccurrence({
      schedule: "30 2 * * *",
      timezone: "America/New_York",
      after: new Date("2026-03-08T12:00:00Z"),
    });
    // Back to 02:30, now EDT (UTC-4) = 06:30Z.
    expect(afterGap).toBe("2026-03-09T06:30:00.000Z");
  });

  // DST fall-back: on 2026-11-01 New York repeats 01:00-02:00, so 01:30 happens twice. The cron
  // must fire once that day, not twice.
  it("fires once on the DST fall-back day, not twice", () => {
    const first = nextCronOccurrence({
      schedule: "30 1 * * *",
      timezone: "America/New_York",
      after: new Date("2026-10-31T12:00:00Z"),
    });
    expect(first).toBe("2026-11-01T05:30:00.000Z");

    const second = nextCronOccurrence({
      schedule: "30 1 * * *",
      timezone: "America/New_York",
      after: new Date(first as string),
    });
    // The next occurrence is the *following day*, not the repeated 01:30 an hour later.
    expect(second).toBe("2026-11-02T06:30:00.000Z");
  });

  it("returns null for an unreachable expression", () => {
    // February 30th never comes.
    expect(
      nextCronOccurrence({ schedule: "0 0 30 2 *", after: new Date("2026-01-01T00:00:00Z") }),
    ).toBeNull();
  });

  it("returns null once the next occurrence would fall past end_time", () => {
    expect(
      nextCronOccurrence({
        schedule: "0 9 * * *",
        after: new Date("2026-08-01T00:00:00Z"),
        endTime: "2026-08-01T08:00:00Z",
      }),
    ).toBeNull();
  });

  it("returns null when end_time has already passed", () => {
    expect(
      nextCronOccurrence({
        schedule: "0 9 * * *",
        after: new Date("2026-08-01T00:00:00Z"),
        endTime: "2020-01-01T00:00:00Z",
      }),
    ).toBeNull();
  });

  it("still fires an occurrence falling exactly on end_time", () => {
    // The end is inclusive — "run until then" includes then.
    expect(
      nextCronOccurrence({
        schedule: "0 9 * * *",
        after: new Date("2026-08-01T00:00:00Z"),
        endTime: "2026-08-01T09:00:00Z",
      }),
    ).toBe("2026-08-01T09:00:00.000Z");
  });

  it("runs forever when end_time is absent or null", () => {
    for (const endTime of [undefined, null]) {
      expect(
        nextCronOccurrence({
          schedule: "0 9 * * *",
          after: new Date("2026-08-01T00:00:00Z"),
          endTime,
        }),
      ).toBe("2026-08-01T09:00:00.000Z");
    }
  });
});

describe("advanceCronOccurrence", () => {
  it("advances from the stored occurrence when the scheduler is keeping up", () => {
    expect(
      advanceCronOccurrence({
        schedule: "*/5 * * * *",
        from: "2026-08-01T12:00:00.000Z",
        now: new Date("2026-08-01T12:00:00.100Z"),
      }),
    ).toBe("2026-08-01T12:05:00.000Z");
  });

  // The catch-up rule, and the reason this function exists. A cron an hour behind must land in the
  // future in ONE step; advancing from the stored date alone would inch forward five minutes at a
  // time and replay the whole outage as a burst of runs.
  it("collapses a backlog into a single catch-up rather than backfilling", () => {
    const next = advanceCronOccurrence({
      schedule: "*/5 * * * *",
      from: "2026-08-01T11:00:00.000Z",
      now: new Date("2026-08-01T12:00:00.000Z"),
    });

    expect(next).toBe("2026-08-01T12:05:00.000Z");
    expect(Date.parse(next as string)).toBeGreaterThan(Date.parse("2026-08-01T12:00:00.000Z"));
  });

  it("never returns a time in the past, however far behind the cron is", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const next = advanceCronOccurrence({
      schedule: "* * * * *",
      from: "2020-01-01T00:00:00Z",
      now,
    });

    expect(Date.parse(next as string)).toBeGreaterThan(now.getTime());
  });

  // An instance whose clock runs behind its peers must not compute a "next" they already consider
  // past, or the two would hand the occurrence back and forth every tick.
  it("advances from the stored occurrence when the local clock lags behind it", () => {
    expect(
      advanceCronOccurrence({
        schedule: "0 * * * *",
        from: "2026-08-01T12:00:00.000Z",
        now: new Date("2026-08-01T11:59:00.000Z"),
      }),
    ).toBe("2026-08-01T13:00:00.000Z");
  });

  it("returns null when the cron is exhausted", () => {
    expect(
      advanceCronOccurrence({
        schedule: "*/5 * * * *",
        from: "2026-08-01T12:00:00.000Z",
        now: new Date("2026-08-01T12:00:00.000Z"),
        endTime: "2026-08-01T12:01:00Z",
      }),
    ).toBeNull();
  });

  it("tolerates an unparseable stored occurrence by advancing from now", () => {
    // Defensive: a hand-edited row should not wedge the scheduler on that cron forever.
    const next = advanceCronOccurrence({
      schedule: "0 * * * *",
      from: "not a date",
      now: new Date("2026-08-01T12:30:00.000Z"),
    });

    expect(next).toBe("2026-08-01T13:00:00.000Z");
  });
});
