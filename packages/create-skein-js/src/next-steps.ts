// The closing instructions.
//
// Pure — it returns lines and the caller prints them — so what a user is told at the end of a
// scaffold is a plain unit test rather than something only observable by running the binary.

import { bold, cyan, dim, yellow } from "./colors.js";
import { PROVIDER_DETAILS } from "./dependency-versions.js";
import type { ScaffoldOptions } from "./scaffold-options.js";

/** What actually happened during the scaffold, which decides what still needs doing. */
export interface ScaffoldOutcome {
  /** Project directory relative to where the command was run, e.g. `my-agent` or `.`. */
  readonly relativeDirectory: string;
  /** Whether dependencies are already installed. */
  readonly installed: boolean;
  /** Set when the npm-legal package name had to differ from the directory name. */
  readonly renamedPackageTo?: string;
}

/** Spell a script for the chosen package manager (`npm run dev`, but `pnpm dev`). */
function runCommand(options: ScaffoldOptions, script: string): string {
  return options.packageManager === "npm"
    ? `npm run ${script}`
    : `${options.packageManager} ${script}`;
}

/** The lines to print once a project has been written. */
export function describeNextSteps(
  options: ScaffoldOptions,
  outcome: ScaffoldOutcome,
): readonly string[] {
  const lines: string[] = ["", bold(`Created ${options.projectName}`), ""];

  if (outcome.renamedPackageTo !== undefined) {
    lines.push(
      yellow(`  Package named "${outcome.renamedPackageTo}" — "${options.projectName}" is not a`),
      yellow("  legal npm name. Rename it in package.json if you'd rather it were something else."),
      "",
    );
  }

  if (outcome.relativeDirectory !== ".") {
    lines.push(`  ${cyan(`cd ${outcome.relativeDirectory}`)}`);
  }
  if (!outcome.installed) {
    lines.push(`  ${cyan(`${options.packageManager} install`)}`);
  }
  lines.push(`  ${cyan(runCommand(options, "dev"))}`, "");

  lines.push(
    `  ${dim("→")} http://localhost:2024           ${dim("the Agent Protocol API")}`,
    `  ${dim("→")} http://localhost:2024/console   ${dim("threads, live runs, time travel")}`,
    "",
  );

  if (options.provider !== "none") {
    const provider = PROVIDER_DETAILS[options.provider];
    lines.push(
      `  ${dim("The `echo` graph needs no key. For `agent`:")}`,
      // Never "cp .env.example .env": the scaffolder already wrote .env, and preserved one that was
      // already there. Telling someone to copy over it would destroy exactly the credentials that
      // preservation exists to protect.
      `  ${dim(`uncomment ${provider.apiKeyEnvVar} in .env`)}`,
      "",
    );
  }

  lines.push(`  ${dim("Docs: https://skein-js.github.io/skein-js/your-first-agent")}`, "");

  return lines;
}
