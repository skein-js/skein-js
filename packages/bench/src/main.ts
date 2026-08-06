// Benchmark entry point. Runs each requested scenario in sequence — never in parallel, since two
// scenarios sharing a process would sample each other's memory and neither number would mean anything.

import { availableParallelism } from "node:os";
import path from "node:path";

import { BenchArgsError, parseBenchArgs } from "./cli-args.js";
import { memoryDriver } from "./drivers/memory-driver.js";
import { postgresRedisDriver } from "./drivers/postgres-redis-driver.js";
import {
  checkInvariants,
  formatViolations,
  type InvariantViolation,
} from "./harness/invariants.js";
import {
  describeEnvironment,
  formatMarkdownTable,
  formatResult,
  writeReport,
} from "./harness/report.js";
import { runScenario, type ScenarioResult } from "./harness/run-scenario.js";
import { findScenario } from "./scenarios/scenario.js";

async function main(): Promise<void> {
  const args = parseBenchArgs(process.argv.slice(2));
  const driver = args.driver === "memory" ? memoryDriver : postgresRedisDriver;

  if (!(globalThis as { gc?: unknown }).gc) {
    console.warn(
      "warning: running without --expose-gc, so settled memory is an upper bound rather than a\n" +
        "         measurement. Use `nx bench bench`, which passes the flag.\n",
    );
  }

  const results: ScenarioResult[] = [];
  const violations: InvariantViolation[] = [];
  for (const name of args.scenarios) {
    const base = findScenario(name);
    // `parseBenchArgs` validates names, so this is unreachable — but returning early beats a
    // non-null assertion that would hide a future refactor's mistake.
    if (!base) continue;
    const scenario = args.streams === undefined ? base : { ...base, streams: args.streams };

    console.log(`\n▶ ${scenario.name} (${driver.name}, ${scenario.streams} streams)`);
    const result = await runScenario({
      scenario,
      driver,
      runConcurrency: args.runConcurrency,
    });
    results.push(result);
    // Collected rather than thrown, so one regressed bound does not hide the remaining scenarios'
    // numbers — the report is most useful precisely when something has failed.
    violations.push(...checkInvariants(scenario, result));
    console.log(`\n${formatResult(result)}`);
  }

  const report = { environment: describeEnvironment(availableParallelism()), results };
  const outputPath = path.resolve(process.cwd(), args.output);
  await writeReport(outputPath, report);

  console.log(`\n${formatMarkdownTable(results)}`);
  console.log(`\nreport written to ${outputPath}`);

  if (violations.length > 0) {
    console.error(
      `\n${violations.length} bound(s) no longer hold — see PERF-WORKSTREAM.md for the phase each belongs to:\n` +
        `${formatViolations(violations)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("\nall bounds hold.");
}

main().catch((error: unknown) => {
  // A bad flag is the user's problem and deserves the help text, not a stack trace; anything else is
  // ours and deserves the stack.
  if (error instanceof BenchArgsError) console.error(error.message);
  else console.error(error);
  process.exitCode = 1;
});
