import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  Annotation,
  getConfig,
  getStore,
  getWriter,
  interrupt,
  StateGraph,
} from "@langchain/langgraph";
import { z } from "zod";

import { generateRecap, type MeetingAgentOptions } from "./meeting-agent.js";
import {
  meetingMarkdown,
  sampleMeeting,
  type MeetingAction,
  type MeetingRecap,
} from "./meeting-notes.js";
import { generateReadingBrief } from "./reading-agent.js";

const meetingInput = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().min(1).max(30_000),
});
const reviewDecision = z.union([
  z.boolean().transform((approved) => ({ approved, actions: undefined, summary: undefined })),
  z.object({
    approved: z.boolean(),
    summary: z.string().max(4000).optional(),
    actions: z
      .array(
        z.object({
          owner: z.string().trim().min(1).max(100),
          task: z.string().trim().min(1).max(1_000),
          due: z.string().trim().min(1).max(100),
        }),
      )
      .max(100)
      .optional(),
  }),
]);

const state = Annotation.Root({
  title: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => sampleMeeting.title,
  }),
  notes: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => sampleMeeting.notes,
  }),
  actions: Annotation<MeetingAction[]>(),
  summary: Annotation<string>(),
  request: Annotation<string>(),
  application: Annotation<"meetings" | "reading">(),
  documentId: Annotation<string>(),
  questions: Annotation<string[]>(),
  quotes: Annotation<string[]>(),
  decisions: Annotation<string[]>(),
  outcome: Annotation<MeetingRecap["outcome"]>(),
  savedPath: Annotation<string>(),
});

/** The application owns extraction rules, approval, file location and immutable output revisions. */
export function buildWorkflow(directory: string, options: MeetingAgentOptions = {}) {
  return new StateGraph(state)
    .addNode("read-notes", (current) => {
      const input = meetingInput.parse(current);
      getWriter()?.({
        progress:
          options.application === "reading" ? "Read your document" : "Read your meeting notes",
        step: "read",
      });
      return input;
    })
    .addNode("draft", async (current, config) => {
      const draft =
        options.application === "reading"
          ? await generateReadingBrief(current, options, config)
          : await generateRecap(current, options, config);
      getWriter()?.({
        progress:
          options.application === "reading"
            ? `Prepared ${draft.decisions.length} key ideas with source excerpts`
            : `Found ${draft.actions.length} follow-ups and ${draft.decisions.length} decisions`,
        step: "draft",
      });
      return {
        ...draft,
        application: options.application ?? "meetings",
        outcome: "review" as const,
        savedPath: "",
      };
    })
    .addNode("approve", (current) => {
      const decision = reviewDecision.parse(
        interrupt({
          question:
            options.application === "reading"
              ? "Save this reading brief on your computer?"
              : "Save this meeting recap on your computer?",
          title: current.title,
          actions: current.actions,
          decisions: current.decisions,
        }),
      );
      return {
        actions: decision.actions ?? current.actions,
        summary: decision.summary ?? current.summary,
        outcome: decision.approved ? ("approved" as const) : ("dismissed" as const),
      };
    })
    .addNode("save", async (current) => {
      const recaps = join(
        directory,
        options.application === "reading" ? "reading-briefs" : "meeting-recaps",
      );
      await mkdir(recaps, { recursive: true });
      const threadId = encodeURIComponent(String(getConfig().configurable?.thread_id));
      const markdown = meetingMarkdown(current);
      // Fresh approvals create revisions; replaying the same approved content keeps its path.
      const revision = createHash("sha256").update(markdown).digest("hex");
      const filename = join(recaps, `${threadId}-${revision}.md`);
      try {
        await writeFile(filename, markdown, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const store = getStore();
      if (!store) throw new Error("A persistent store is required for the meeting archive.");
      await store.put(
        [options.application === "reading" ? "reading-briefs" : "meeting-recaps"],
        decodeURIComponent(threadId),
        {
          title: current.title,
          summary: current.summary,
          questions: current.questions ?? [],
          quotes: current.quotes ?? [],
          notes: current.notes,
          actions: current.actions,
          decisions: current.decisions,
          savedPath: filename,
        },
      );
      getWriter()?.({
        progress:
          options.application === "reading"
            ? "Saved your reading brief"
            : "Saved your meeting recap",
        step: "save",
      });
      return { savedPath: filename, outcome: "saved" as const };
    })
    .addEdge("__start__", "read-notes")
    .addEdge("read-notes", "draft")
    .addEdge("draft", "approve")
    .addConditionalEdges("approve", (current) =>
      current.outcome === "approved" ? "save" : "__end__",
    )
    .addEdge("save", "__end__")
    .compile();
}
