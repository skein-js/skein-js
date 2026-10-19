import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { tool } from "@langchain/core/tools";
import {
  Annotation,
  getConfig,
  getStore,
  getWriter,
  interrupt,
  StateGraph,
} from "@langchain/langgraph";
import { createAgent, toolStrategy } from "langchain";
import { z } from "zod";

import type { MeetingAgentOptions } from "./meeting-agent.js";
import { createModelSession, modelErrorMessage } from "./model-session.js";

export const sampleTasks = `# Today's task inbox
- Finish the proposal for the community website. The client needs it tomorrow. Estimate: 90 minutes.
- Review Maya's homepage copy. She is waiting for feedback before she can finish. Estimate: 30 minutes.
- Investigate the mobile sign-up bug before launch. Estimate: 60 minutes.
- Clean up old screenshots. No deadline. Estimate: 30 minutes.
- Reply to the venue email before 4 pm. Estimate: 15 minutes.
Available focus time: about 3 hours. Keep a little room for interruptions.\n`;
const planSchema = z.object({
  summary: z.string(),
  blocks: z.array(z.object({ timebox: z.string(), task: z.string(), reason: z.string() })).max(8),
  deferred: z.array(z.string()),
  risks: z.array(z.string()),
});
export type DailyPlan = z.infer<typeof planSchema> & {
  request: string;
  outcome: "review" | "saved" | "dismissed";
  savedPath: string;
};
export function dailyPlanMarkdown(plan: DailyPlan): string {
  return [
    "# Your daily plan",
    "",
    plan.summary,
    "",
    "## Focus blocks",
    "",
    ...plan.blocks.map((block) => `- [ ] ${block.timebox}: ${block.task}\n  ${block.reason}`),
    "",
    "## Leave for later",
    "",
    ...plan.deferred.map((task) => `- ${task}`),
    "",
    "## Watch out for",
    "",
    ...plan.risks.map((risk) => `- ${risk}`),
    "",
  ].join("\n");
}
export function buildDailyPlanner(
  directory: string,
  tasksFilename: string,
  options: MeetingAgentOptions = {},
) {
  const state = Annotation.Root({
    request: Annotation<string>({
      reducer: (_previous, next) => next,
      default: () =>
        "Plan a realistic day from my task inbox. Protect focus time and explain what can wait.",
    }),
    summary: Annotation<string>(),
    blocks: Annotation<DailyPlan["blocks"]>(),
    deferred: Annotation<string[]>(),
    risks: Annotation<string[]>(),
    outcome: Annotation<DailyPlan["outcome"]>(),
    savedPath: Annotation<string>(),
  });
  return new StateGraph(state)
    .addNode("prepare", async () => {
      await readFile(tasksFilename, "utf8");
      getWriter()?.({ progress: "Task inbox found", type: "node" });
      return {};
    })
    .addNode("plan", async (current, config) => {
      const writer = getWriter();
      let plan: z.infer<typeof planSchema>;
      if (options.fixture)
        plan = {
          summary: "Make room for the proposal, the blocked copy review and the launch issue.",
          blocks: [
            {
              timebox: "90 minutes",
              task: "Finish the community website proposal",
              reason: "The client needs it tomorrow.",
            },
            {
              timebox: "30 minutes",
              task: "Review Maya's homepage copy",
              reason: "Unblock Maya's work.",
            },
          ],
          deferred: ["Clean up old screenshots"],
          risks: ["Leave time to reply to the venue before 4 pm."],
        };
      else {
        const tools = [
          tool(
            async () => {
              writer?.({
                type: "tool",
                name: "read_task_inbox",
                phase: "start",
                progress: "Reading your local task inbox",
              });
              const source = await readFile(tasksFilename, "utf8");
              if (source.length > 30000)
                throw new Error("Use a task inbox under 30,000 characters.");
              writer?.({
                type: "tool",
                name: "read_task_inbox",
                phase: "end",
                progress: "Task inbox read",
              });
              return source;
            },
            {
              name: "read_task_inbox",
              description:
                "Read the actual local Markdown task file selected by the user. Always call this before planning.",
              schema: z.object({}),
            },
          ),
          tool(
            async () => {
              const items = (await getStore()?.search(["daily-plans"], { limit: 3 })) ?? [];
              writer?.({
                type: "tool",
                name: "read_previous_plans",
                phase: "end",
                progress: `Checked ${items.length} saved daily plans`,
              });
              return JSON.stringify(items.map((item) => item.value));
            },
            {
              name: "read_previous_plans",
              description:
                "Read recent saved plans from the persistent workspace. Use this to avoid losing track of deferred work.",
              schema: z.object({}),
            },
          ),
        ];
        try {
          const agent = createAgent({
            model: options.createModel?.() ?? createModelSession().createModel(),
            tools,
            systemPrompt:
              "You are Dayplan, a practical daily planning assistant. Read the task inbox and recent plans with your tools. Respect stated deadlines and available time. Never schedule more minutes than the available time. Leave a small buffer; split a large task or defer it explicitly when everything does not fit. Avoid inventing tasks or pretending an estimate is certain. Explain priorities and what to defer. Never claim to change a task file or save a plan; the user reviews the plan first.",
            responseFormat: toolStrategy(planSchema),
          });
          const result = await agent.invoke(
            { messages: [{ role: "user", content: current.request }] },
            { ...config, recursionLimit: 16 },
          );
          plan = planSchema.parse(result.structuredResponse);
        } catch (error) {
          throw new Error(modelErrorMessage(error));
        }
      }
      return { ...plan, outcome: "review" as const, savedPath: "" };
    })
    .addNode("approve", (current) => {
      const decision = z.object({ approved: z.boolean() }).parse(
        interrupt({
          question: "Save this daily plan?",
          summary: current.summary,
          blocks: current.blocks,
        }),
      );
      return { outcome: decision.approved ? ("saved" as const) : ("dismissed" as const) };
    })
    .addNode("save", async (current) => {
      if (current.outcome !== "saved") return {};
      const plans = join(directory, "daily-plans");
      await mkdir(plans, { recursive: true });
      const id = String(getConfig().configurable?.thread_id);
      const filename = join(plans, `${encodeURIComponent(id)}.md`);
      try {
        await writeFile(filename, dailyPlanMarkdown(current), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await getStore()?.put(["daily-plans"], id, {
        summary: current.summary,
        blocks: current.blocks,
        deferred: current.deferred,
        risks: current.risks,
        savedPath: filename,
      });
      getWriter()?.({ progress: "Daily plan saved", type: "node" });
      return { savedPath: filename };
    })
    .addEdge("__start__", "prepare")
    .addEdge("prepare", "plan")
    .addEdge("plan", "approve")
    .addEdge("approve", "save")
    .addEdge("save", "__end__")
    .compile();
}
