import { basicCatalog, MessageProcessor } from "@a2ui/web_core/v1_0";
import { z } from "zod";

import {
  messageSurfaceId,
  parseUiMessage,
  snapshotSurfaces,
  uiSurfaceIds,
  type SavedUi,
} from "./ui-contract.js";

const eventBase = {
  type: z.literal("a2ui"),
  generationId: z.uuid(),
  sequence: z.number().int().nonnegative(),
};
export const uiEventSchema = z.discriminatedUnion("phase", [
  z
    .object({
      ...eventBase,
      sequence: z.literal(0),
      phase: z.literal("start"),
      operation: z.enum(["replace", "update"]),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      phase: z.literal("message"),
      message: z.unknown().transform(parseUiMessage),
    })
    .strict(),
  z.object({ ...eventBase, phase: z.literal("complete") }).strict(),
]);
export type UiEvent = z.infer<typeof uiEventSchema>;
export type StreamFrame = { event: string; data: unknown; id?: string };

/** One upstream processor per observed run, retained across reconnects to that run only. */
export function createUiStream(baseline: SavedUi | null) {
  const processor = new MessageProcessor([basicCatalog]);
  let generationId: string | undefined;
  let sequence = -1;
  let complete = false;
  let gap = false;
  let view = baseline;

  const losePreview = () => {
    gap = true;
    view = baseline;
  };

  return {
    push(frame: StreamFrame) {
      if (
        frame.event !== "custom" ||
        !frame.data ||
        typeof frame.data !== "object" ||
        !("type" in frame.data) ||
        frame.data.type !== "a2ui"
      )
        return;

      try {
        const event = uiEventSchema.parse(frame.data);
        if (generationId && event.generationId !== generationId) return;
        if (event.sequence <= sequence) return;
        if (!generationId && event.phase === "start") generationId = event.generationId;

        if (!generationId || event.sequence !== sequence + 1 || complete) {
          losePreview();
          return;
        }

        sequence = event.sequence;
        if (gap) return;

        if (event.phase === "start" && event.operation === "update") {
          if (baseline?.generationId !== generationId) {
            losePreview();
            return;
          }

          processor.processMessages(baseline.bootstrapMessages);
        }

        if (event.phase === "message") {
          if (
            !Object.values(uiSurfaceIds(generationId)).includes(messageSurfaceId(event.message))
          ) {
            losePreview();
            return;
          }

          processor.processMessages(event.message);

          // In-progress references may not exist yet; only materialize a validated view when ready.
          try {
            view = snapshotSurfaces(generationId, processor.getSurfaces().values());
          } catch {
            /* keep last renderable preview */
          }
        }

        if (event.phase === "complete") {
          view = snapshotSurfaces(generationId, processor.getSurfaces().values());
          complete = true;
        }
      } catch {
        losePreview();
      }
    },
    snapshot: () => ({ view, generationId, gap, complete }),
    dispose: () => processor.dispose(),
  };
}
