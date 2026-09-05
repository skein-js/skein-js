// The closing instructions.
//
// Pure — it returns lines and the caller prints them — so what a user is told at the end of a
// scaffold is a plain unit test rather than something only observable by running the binary.

import { bold, cyan, dim, yellow } from "./colors.js";
import { PROVIDER_DETAILS } from "./dependency-versions.js";
import type { GitOutcome } from "./git.js";
import type { ScaffoldOptions } from "./scaffold-options.js";

/** What actually happened during the scaffold, which decides what still needs doing. */
export interface ScaffoldOutcome {
  /** Project directory relative to where the command was run, e.g. `my-agent` or `.`. */
  readonly relativeDirectory: string;
  /** Whether dependencies are already installed. */
  readonly installed: boolean;
  /** What git did, or `undefined` when it was not attempted (`--no-git`, or the user declined). */
  readonly git?: GitOutcome;
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

  // Stated rather than left to be inferred from the absence of `.git`. Skipping inside an existing
  // work tree is the *correct* behaviour and the one most likely to look like a bug, so it is the
  // one that most needs saying.
  if (outcome.git === "skipped-existing-repo") {
    lines.push(`  ${dim("Skipped git init — this is already inside a git repository.")}`, "");
  } else if (outcome.git === "failed") {
    lines.push(
      yellow("  Could not initialize a git repository."),
      dim("  git may be missing, or have no user.name / user.email configured."),
      "",
    );
  }

  if (outcome.relativeDirectory !== ".") {
    lines.push(`  ${cyan(`cd ${outcome.relativeDirectory}`)}`);
  }
  if (!outcome.installed) {
    lines.push(`  ${cyan(`${options.packageManager} install`)}`);
  }
  // Listed as a *step*, in sequence and in color, rather than as a footnote after the URLs. Someone
  // who scrolls past a dim aside gets a graph that fails to load on first boot, and the reason for it
  // is then something they have to read out of a stack trace instead of out of this list.
  //
  // Never "cp .env.example .env": the scaffolder already wrote .env, and preserved one that was
  // already there. Telling someone to copy over it would destroy exactly the credentials that
  // preservation exists to protect.
  if (options.provider !== "none") {
    const provider = PROVIDER_DETAILS[options.provider];
    lines.push(
      `  ${yellow(`Set ${provider.apiKeyEnvVar} in .env`)}   ${dim(`— uncomment it; get a key at ${provider.consoleUrl}`)}`,
    );
  }
  // On the durable axis `dev` needs Postgres and Redis, so the very first command we print would
  // otherwise fail with nothing running. Listed as its own step for the same reason the API key is:
  // a footnote after the URLs is a footnote people scroll past.
  if (options.devStorage === "postgres") {
    lines.push(`  ${cyan(runCommand(options, "dev:services"))}   ${dim("— Postgres + Redis")}`);
  }
  lines.push(`  ${cyan(runCommand(options, "dev"))}`, "");

  lines.push(
    `  ${dim("→")} http://localhost:2024           ${dim("the Agent Protocol API")}`,
    `  ${dim("→")} http://localhost:2024/console   ${dim("threads, live runs, time travel")}`,
    "",
  );

  if (options.provider !== "none") {
    lines.push(
      `  ${dim("Only the `agent` graph needs that key — `echo` runs without one, so you can")}`,
      `  ${dim("start the server and talk to it before you have set anything up.")}`,
      "",
    );
  }

  lines.push(`  ${dim("Docs: https://skein-js.github.io/skein-js/your-first-agent")}`, "");

  return lines;
}
