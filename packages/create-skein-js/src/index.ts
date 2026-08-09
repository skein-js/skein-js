#!/usr/bin/env node
// `create-skein-js` — scaffold a skein-js project from an empty directory.
//
//   npm create skein-js@latest my-agent
//   pnpm create skein-js my-agent
//   npx create-skein-js my-agent
//
// The `@latest` matters and every doc snippet carries it: without it npm's npx cache (and `pnpm
// dlx`'s 24-hour one) can serve a stale version of this package.
//
// Commander is used here for the same reason it is in packages/cli/src/index.ts — typed options and
// a real `--help` — and it is the only runtime dependency, transitively included.

import path from "node:path";
import { createInterface } from "node:readline/promises";

import { Command, InvalidArgumentError } from "@commander-js/extra-typings";

import { bold, dim, red } from "./colors.js";
import { writeFilesToDisk } from "./file-tree-writer.js";
import { initializeGitRepository } from "./git.js";
import { describeNextSteps } from "./next-steps.js";
import { resolvePackageManager, runPackageManagerInstall } from "./package-manager.js";
import { buildProjectFiles } from "./project-files.js";
import { canPrompt, promptChoice, promptText } from "./prompt.js";
import {
  isModelProvider,
  isPackageManagerName,
  toPackageName,
  type ModelProvider,
  type PackageManagerName,
  type ScaffoldOptions,
} from "./scaffold-options.js";
import { resolveSkeinVersionRange, scaffolderVersion } from "./skein-version.js";
import { assertTargetDirectoryUsable } from "./target-directory.js";

function parseProvider(value: string): ModelProvider {
  if (!isModelProvider(value)) {
    throw new InvalidArgumentError("Expected one of: none, google, anthropic, openai.");
  }
  return value;
}

function parsePackageManager(value: string): PackageManagerName {
  if (!isPackageManagerName(value)) {
    throw new InvalidArgumentError("Expected one of: npm, pnpm, yarn, bun.");
  }
  return value;
}

const PROVIDER_CHOICES = [
  { value: "none", label: "None", hint: "just the echo graph — runs with no API key" },
  { value: "google", label: "Google Gemini", hint: "GOOGLE_API_KEY" },
  { value: "anthropic", label: "Anthropic Claude", hint: "ANTHROPIC_API_KEY" },
  { value: "openai", label: "OpenAI", hint: "OPENAI_API_KEY" },
] as const satisfies readonly { value: ModelProvider; label: string; hint: string }[];

const program = new Command()
  .name("create-skein-js")
  .description(
    "Scaffold a skein-js project — an Agent Protocol server for your LangGraph.js agents.",
  )
  .argument("[directory]", 'Where to create the project ("." for the current directory)')
  .option(
    "-m, --provider <name>",
    "Model provider: none | google | anthropic | openai",
    parseProvider,
  )
  .option("--pm <name>", "Package manager: npm | pnpm | yarn | bun", parsePackageManager)
  .option("--no-install", "Skip installing dependencies")
  .option("--no-git", "Skip initializing a git repository")
  .option("-y, --yes", "Accept every default; never prompt", false)
  .option("-f, --force", "Scaffold into a directory that is not empty", false)
  .version(scaffolderVersion, "-v, --version")
  .action(async (directoryArgument, options) => {
    const interactive = canPrompt({ yes: options.yes });
    const readline = interactive
      ? createInterface({ input: process.stdin, output: process.stdout })
      : undefined;

    try {
      const ask = readline
        ? (query: string) => readline.question(query)
        : // Never reached: every prompt below is guarded by `interactive`.
          async () => "";

      if (interactive) process.stdout.write(`\n${bold("Let's make an agent.")}\n\n`);

      const projectName =
        directoryArgument ??
        (interactive ? await promptText(ask, "Project directory", "my-agent") : "my-agent");

      const provider =
        options.provider ??
        (interactive
          ? await promptChoice(ask, "Which model provider?", PROVIDER_CHOICES, "none")
          : "none");

      const targetDirectory = path.resolve(process.cwd(), projectName);
      assertTargetDirectoryUsable(targetDirectory, { force: options.force });

      // "." means "here", so the project is named after the directory it lands in.
      const resolvedName =
        projectName === "." ? path.basename(targetDirectory) : path.basename(projectName);
      const packageName = toPackageName(resolvedName);

      const scaffoldOptions: ScaffoldOptions = {
        projectName: resolvedName,
        packageName,
        provider,
        packageManager: options.pm ?? resolvePackageManager(process.env["npm_config_user_agent"]),
        skeinVersionRange: resolveSkeinVersionRange(),
      };

      writeFilesToDisk(targetDirectory, buildProjectFiles(scaffoldOptions));

      readline?.close();

      const installed =
        options.install &&
        runPackageManagerInstall(scaffoldOptions.packageManager, targetDirectory);
      if (options.install && !installed) {
        process.stdout.write(
          `\n${red("Install failed.")} ${dim("Your project is written — run it yourself below.")}\n`,
        );
      }

      if (options.git) initializeGitRepository(targetDirectory);

      const lines = describeNextSteps(scaffoldOptions, {
        relativeDirectory: path.relative(process.cwd(), targetDirectory) || ".",
        installed,
        renamedPackageTo: packageName === resolvedName ? undefined : packageName,
      });
      process.stdout.write(`${lines.join("\n")}\n`);
    } finally {
      readline?.close();
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  program.error(error instanceof Error ? error.message : String(error));
}
