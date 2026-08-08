// Register the schedules, and kick one sweep off so the demo has something to show immediately.
//
// A script rather than a README instruction, because "create a cron" is the step people skip and then
// wonder why nothing happens.
//
// It registers *four* schedules, not one, because a Crons view with a single row demonstrates almost
// nothing. Between them they cover every knob the resource has: a frequent schedule, a second one on
// the same graph with different input, a timezone-aware daily digest on a *different* graph, and one
// that starts paused so pause/resume has something to act on.
//
//   pnpm seed
//   TRIAGE_SCHEDULE="* * * * *" pnpm seed     # every minute, if you do not want to wait
//   SKEIN_API_URL=http://127.0.0.1:2113 pnpm seed

import { Client } from "@langchain/langgraph-sdk";

const apiUrl = process.env["SKEIN_API_URL"] ?? "http://127.0.0.1:2024";
const sweepSchedule = process.env["TRIAGE_SCHEDULE"] ?? "*/5 * * * *";
const repo = process.env["TRIAGE_REPO"] ?? "skein-js/skein-js";
// The digest reads better in the operator's own timezone than in UTC, and it is the field most people
// do not realize the Crons resource supports.
const timezone = process.env["TRIAGE_TIMEZONE"] ?? "Africa/Nairobi";

const client = new Client({ apiUrl });

interface Schedule {
  assistant: string;
  schedule: string;
  input: Record<string, unknown>;
  what: string;
  timezone?: string;
  enabled?: boolean;
  endTime?: string;
}

/** Two weeks out — enough to show `end_time` as a real value without expiring during a demo. */
const inTwoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

const schedules: Schedule[] = [
  {
    assistant: "sweep",
    schedule: sweepSchedule,
    input: { repo, limit: 5 },
    what: "the workhorse — picks up new items and dispatches one run each",
  },
  {
    // Same graph, different input: `force` re-dispatches items already decided, which is where the
    // idempotency replay is visible (`0 dispatched, N replayed`).
    assistant: "sweep",
    schedule: "0 * * * *",
    input: { repo, limit: 10, force: true },
    what: "hourly deep pass — re-checks decided items; watch it replay rather than re-run",
    endTime: inTwoWeeks,
  },
  {
    // A different graph entirely, so the Crons view is not one graph repeated.
    assistant: "assistant",
    schedule: "0 9 * * *",
    timezone,
    input: {
      messages: [{ role: "human", content: "Summarize what was triaged in the last day." }],
    },
    what: `daily digest at 09:00 ${timezone}`,
  },
  {
    assistant: "sweep",
    schedule: "*/2 * * * *",
    input: { repo, limit: 20, force: true },
    enabled: false,
    what: "starts paused — resume it from the console's Crons view to see a schedule come alive",
  },
];

// Replace what a previous run of this script registered, rather than stacking a second copy of every
// schedule on top. Deleting only what we are about to recreate leaves anything you added by hand.
const existing = await client.crons.search({ limit: 100 });
for (const cron of existing) {
  if (schedules.some((entry) => entry.assistant === cron.assistant_id)) {
    await client.crons.delete(cron.cron_id);
  }
}

for (const entry of schedules) {
  const cron = await client.crons.create(entry.assistant, {
    schedule: entry.schedule,
    input: entry.input,
    ...(entry.timezone ? { timezone: entry.timezone } : {}),
    ...(entry.enabled === false ? { enabled: false } : {}),
    ...(entry.endTime ? { endTime: entry.endTime } : {}),
    // Keep the thread so the run is inspectable in the console afterwards. The default deletes it,
    // which for a demo means the evidence disappears the moment it works.
    onRunCompleted: "keep",
  });
  const state = entry.enabled === false ? "paused" : `next ${cron.next_run_date ?? "—"}`;
  console.log(`${entry.assistant.padEnd(10)} ${entry.schedule.padEnd(12)} ${state}`);
  console.log(`${" ".repeat(11)}${entry.what}`);
}

console.log(`\n${schedules.length} schedules registered. Watch them at ${apiUrl}/console/#/crons`);

// Kick one off now, so there is something to look at without waiting for the first occurrence.
const run = await client.runs.create(null, "sweep", { input: { repo, limit: 6 } });
console.log(`Dispatched an immediate sweep (run ${run.run_id}).`);
