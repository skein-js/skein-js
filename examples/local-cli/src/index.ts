import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";

import { createProtocolRuntime } from "@skein-js/agent-protocol";
import {
  buildDailyPlanner,
  sampleTasks,
  startWorkflowServer,
  smokeWorkflow,
  type DailyPlan,
} from "@skein-js/example-local-workflow";
import { embedSqliteGraphs } from "@skein-js/local";

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}
async function main() {
  const envFile = argument("--env-file");
  if (envFile) process.loadEnvFile(resolve(envFile));
  const smoke = process.argv.includes("--smoke");
  const directory = smoke
    ? await mkdtemp(join(tmpdir(), "skein-dayplan-proof-"))
    : resolve(process.env["SKEIN_EXAMPLE_DATA"] ?? ".skein/dayplan");
  await mkdir(directory, { recursive: true });
  const tasks = argument("--tasks") ? resolve(argument("--tasks")!) : join(directory, "tasks.md");
  if (!argument("--tasks")) {
    try {
      await writeFile(tasks, sampleTasks, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const embedded = await embedSqliteGraphs(
    { planner: buildDailyPlanner(directory, tasks, { fixture: smoke }) },
    { sqlitePath: join(directory, "state.sqlite") },
  );
  try {
    const runtime = createProtocolRuntime(embedded.deps, { scheduler: { enabled: false } });
    try {
      await runtime.service.assistants.registerGraphAssistants();
      let threadId = argument("--resume");
      console.log("\nDAYPLAN\nMake room for the work that matters.\n");
      console.log(`Task inbox: ${tasks}\n`);
      if (!threadId) {
        threadId = (await runtime.service.threads.create({ metadata: { demo: "daily-planner" } }))
          .thread_id;
        const started = await runtime.service.runs.createStream({
          thread_id: threadId,
          assistant_id: "planner",
          input: {
            request:
              argument("--request") ??
              "Plan a realistic day from my task inbox. Protect focus time and explain what can wait.",
          },
          stream_mode: ["values", "custom"],
        });
        for await (const frame of started.frames)
          if (frame.event === "custom")
            console.log(`  ✓ ${(frame.data as { progress: string }).progress}`);
      }
      const state = await runtime.service.threads.getState(threadId);
      const plan = state.values as unknown as DailyPlan;
      if (!plan.blocks)
        throw new Error(
          "The model could not create a plan. Check MODEL_PROVIDER, the provider credentials and model availability.",
        );
      console.log(`\n${plan.summary}\n\nYOUR FOCUS BLOCKS\n`);
      for (const [index, block] of plan.blocks.entries())
        console.log(`  ${index + 1}. ${block.task} · ${block.timebox}\n     ${block.reason}\n`);
      console.log("LEAVE FOR LATER");
      for (const task of plan.deferred) console.log(`  - ${task}`);
      if (plan.risks.length) {
        console.log("\nWATCH OUT FOR");
        for (const risk of plan.risks) console.log(`  - ${risk}`);
      }
      if (state.next.includes("approve")) {
        let approved: boolean | undefined =
          smoke || process.argv.includes("--approve")
            ? true
            : process.argv.includes("--discard")
              ? false
              : undefined;
        if (approved === undefined && process.stdin.isTTY) {
          const prompt = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = (await prompt.question("\nSave this plan? [y]es / [s]kip / [l]ater: "))
              .trim()
              .toLowerCase();
            if (["y", "yes"].includes(answer)) approved = true;
            if (["s", "skip"].includes(answer)) approved = false;
          } finally {
            prompt.close();
          }
        }
        if (approved === undefined)
          console.log(
            `\nReview saved for later. Resume with:\n  pnpm nx run example-local-cli:start --args="--resume ${threadId}"`,
          );
        else {
          await runtime.service.runs.createWait({
            thread_id: threadId,
            assistant_id: "planner",
            command: { resume: { approved } },
          });
          const result = (await runtime.service.threads.getState(threadId))
            .values as unknown as DailyPlan;
          console.log(
            approved
              ? `\n✓ Plan saved to ${result.savedPath}`
              : "\nSkipped. Your task inbox was not changed.",
          );
        }
      } else if (plan.savedPath) console.log(`\nSaved plan: ${plan.savedPath}`);
    } finally {
      await runtime.worker.stop();
    }
  } finally {
    await embedded.dispose();
  }
  if (smoke) {
    const token = randomBytes(32).toString("hex");
    const server = await startWorkflowServer(directory, token, { fixture: true });
    try {
      await smokeWorkflow(server.url, token);
      console.log("CLI_PLAN_OK and Agent Protocol proof passed");
    } finally {
      await server.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
await main().catch((error: Error) => {
  console.error(error.message.replace(/AIza[\w-]+/g, "[redacted]"));
  process.exitCode = 1;
});
