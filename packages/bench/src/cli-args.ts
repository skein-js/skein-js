// Argument parsing for the benchmark entry point. Deliberately hand-rolled: the harness is private
// and takes five flags, and adding a parser dependency to a package whose whole job is to measure
// startup cost would be its own small irony.

import { SCENARIOS } from "./scenarios/scenario.js";

export interface BenchArgs {
  /** Driver to run against. */
  driver: "memory" | "postgres-redis";
  /** Scenario names to run; defaults to all of them. */
  scenarios: string[];
  /** Override the scenarios' own stream counts. */
  streams?: number;
  /** Queued runs the worker executes at once. */
  runConcurrency: number;
  /** Where the JSON report is written, relative to the package root. */
  output: string;
}

export class BenchArgsError extends Error {}

const DEFAULT_RUN_CONCURRENCY = 10;

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new BenchArgsError(`${flag} needs a value.`);
  return value;
}

function parsePositiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new BenchArgsError(`${flag} must be a positive integer, got "${raw}".`);
  }
  return value;
}

/**
 * Parse `argv` (without the node/script prefix).
 *
 * An unknown flag or scenario name is an error rather than a silent skip — a typo'd `--scenario` that
 * quietly ran everything would produce numbers under the wrong label, which is worse than no numbers.
 */
export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const args: BenchArgs = {
    driver: "memory",
    scenarios: SCENARIOS.map((scenario) => scenario.name),
    runConcurrency: DEFAULT_RUN_CONCURRENCY,
    output: "results/latest.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--driver": {
        const value = requireValue(flag, argv[++index]);
        if (value !== "memory" && value !== "postgres-redis") {
          throw new BenchArgsError(
            `--driver must be "memory" or "postgres-redis", got "${value}".`,
          );
        }
        args.driver = value;
        break;
      }
      case "--scenario": {
        const value = requireValue(flag, argv[++index]);
        const known = SCENARIOS.map((scenario) => scenario.name);
        if (!known.includes(value)) {
          throw new BenchArgsError(`unknown scenario "${value}". Known: ${known.join(", ")}.`);
        }
        args.scenarios = [value];
        break;
      }
      case "--streams":
        args.streams = parsePositiveInt(flag, requireValue(flag, argv[++index]));
        break;
      case "--concurrency":
        args.runConcurrency = parsePositiveInt(flag, requireValue(flag, argv[++index]));
        break;
      case "--output":
        args.output = requireValue(flag, argv[++index]);
        break;
      case "--help":
      case "-h":
        throw new BenchArgsError(HELP);
      default:
        throw new BenchArgsError(`unknown flag "${flag}".\n\n${HELP}`);
    }
  }

  return args;
}

export const HELP = `skein benchmarks

  nx bench bench                                  all scenarios, in-memory drivers
  nx bench bench -- --driver postgres-redis       production drivers (needs Docker)
  nx bench bench -- --scenario slow-client --streams 500

Flags:
  --driver <memory|postgres-redis>   storage/queue stack under test (default: memory)
  --scenario <name>                  run one scenario (default: all)
  --streams <n>                      override the scenario's concurrent stream count
  --concurrency <n>                  queued runs the worker executes at once (default: 10)
  --output <path>                    JSON report path (default: results/latest.json)

Scenarios:
${SCENARIOS.map((scenario) => `  ${scenario.name.padEnd(16)} ${scenario.description}`).join("\n")}`;
