// Rendering and persisting results. Two audiences: a human reading the terminal or a CI job summary,
// and a later run diffing against this one. Both are served from the same result objects, so a
// regression check can never disagree with what was printed.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ScenarioResult } from "./run-scenario.js";

const MEGABYTE = 1024 * 1024;

const mb = (bytes: number): string => `${(bytes / MEGABYTE).toFixed(1)} MB`;
const ms = (value: number): string => `${value.toFixed(0)} ms`;

/** Environment the numbers were produced on. A baseline compared across these is not a comparison. */
export interface BenchEnvironment {
  runtime: string;
  runtimeVersion: string;
  platform: string;
  arch: string;
  cpus: number;
}

export interface BenchReport {
  environment: BenchEnvironment;
  results: ScenarioResult[];
}

/** Describe the current process, so a stored baseline records what produced it. */
export function describeEnvironment(cpus: number): BenchEnvironment {
  return {
    runtime: "node",
    runtimeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus,
  };
}

/** Human-readable block for one result. */
export function formatResult(result: ScenarioResult): string {
  const { memory } = result;
  const lines = [
    `scenario: ${result.scenario} · driver: ${result.driver} · streams: ${result.streams}`,
    "",
    `  boot                    ${ms(result.bootMs)}`,
    `  time to first frame     ${ms(result.timeToFirstFrameMs)}`,
    `  throughput              ${result.framesPerSecond.toFixed(0)} frames/s`,
    `  frame latency p50/p99   ${ms(result.latencyP50Ms)} / ${ms(result.latencyP99Ms)}`,
    `  frames delivered        ${result.totalFrames.toLocaleString()}`,
    `  RSS peak                ${mb(memory.rssPeakBytes)}`,
    `  RSS after idle+gc       ${mb(memory.rssSettledBytes)}${result.gcForced ? "" : "   (no --expose-gc: upper bound)"}`,
    `  heap used peak          ${mb(memory.heapUsedPeakBytes)}`,
    `  heap limit              ${mb(memory.heapLimitBytes)}`,
  ];

  for (const [name, value] of Object.entries(memory.probePeaks)) {
    const rendered = name.endsWith("Bytes") ? mb(value) : value.toLocaleString();
    lines.push(`  ${name.padEnd(23)} ${rendered}`);
  }

  return lines.join("\n");
}

/** Markdown table across every result — what a CI job summary shows. */
export function formatMarkdownTable(results: readonly ScenarioResult[]): string {
  const header = [
    "| scenario | driver | streams | RSS peak | RSS settled | SSE buffered | frames/s | p99 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = results.map((result) => {
    const buffered = result.memory.probePeaks["sseBufferedBytes"];
    const cells = [
      result.scenario,
      result.driver,
      String(result.streams),
      mb(result.memory.rssPeakBytes),
      mb(result.memory.rssSettledBytes),
      buffered === undefined ? "n/a" : mb(buffered),
      result.framesPerSecond.toFixed(0),
      ms(result.latencyP99Ms),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}

/** Write the machine-readable report next to the harness, creating the directory on first run. */
export async function writeReport(outputPath: string, report: BenchReport): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
