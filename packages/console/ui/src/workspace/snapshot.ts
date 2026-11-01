import { z } from "zod";

const inputModeSchema = z.enum(["chat", "json"]);
const workspaceDraftSchema = z.object({
  chat: z.string().optional().catch(undefined),
  json: z.string().optional().catch(undefined),
  mode: inputModeSchema.optional().catch(undefined),
});
const pagePositionSchema = z.object({
  queryKey: z.string(),
  pageSize: z.number().int().positive().safe(),
  offsets: z
    .array(z.number().int().nonnegative().safe())
    .readonly()
    .refine(
      (offsets) =>
        offsets[0] === 0 &&
        offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]!),
    ),
});
const threadInspectionTabSchema = z.enum([
  "conversation",
  "runs",
  "state",
  "checkpoints",
  "details",
]);

export type InputMode = z.infer<typeof inputModeSchema>;
export type WorkspaceDraft = z.infer<typeof workspaceDraftSchema>;
export type PagePosition = z.infer<typeof pagePositionSchema>;
type ThreadInspectionTab = z.infer<typeof threadInspectionTabSchema>;

const workspaceSnapshotSchema = z
  .object({
    drafts: z.record(workspaceDraftSchema.catch({})).catch({}),
    lastWorkspace: z
      .object({ assistantId: z.string().min(1), threadId: z.string().min(1).optional() })
      .optional()
      .catch(undefined),
    pages: z
      .record(pagePositionSchema.optional().catch(undefined))
      .catch({})
      .transform((positions) =>
        Object.fromEntries(
          Object.entries(positions).filter(
            (entry): entry is [string, PagePosition] => entry[1] !== undefined,
          ),
        ),
      ),
    threadListRoute: z
      .string()
      .regex(/^threads(?:\?[^#]*)?$/)
      .catch("threads"),
    threadTabs: z
      .record(threadInspectionTabSchema.optional().catch(undefined))
      .catch({})
      .transform((tabs) =>
        Object.fromEntries(
          Object.entries(tabs).filter(
            (entry): entry is [string, ThreadInspectionTab] => entry[1] !== undefined,
          ),
        ),
      ),
    returnRow: z.string().optional().catch(undefined),
  })
  .catch(() => ({ drafts: {}, pages: {}, threadListRoute: "threads", threadTabs: {} }));

export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

/** Only known, validated JSON fields may enter the live store; action functions stay private. */
export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  return workspaceSnapshotSchema.parse(value);
}

export function createEmptyWorkspaceSnapshot(): WorkspaceSnapshot {
  return parseWorkspaceSnapshot({});
}

/** Thread IDs may legitimately equal inherited object-property names. */
export function getThreadInspectionTab(
  tabs: WorkspaceSnapshot["threadTabs"] | undefined,
  threadId: string,
): string | undefined {
  return tabs && Object.hasOwn(tabs, threadId) ? tabs[threadId] : undefined;
}
