import { createSpecStreamCompiler, type Spec } from "@json-render/core";
import { z } from "zod";

import { validateUiSpec, type CommittedUi } from "./catalog.js";

const eventBase = {
  type: z.literal("json-render"),
  generationId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
};

const uiEventSchema = z.discriminatedUnion("phase", [
  z.object({ ...eventBase, phase: z.literal("start"), sequence: z.literal(0) }).strict(),
  z.object({ ...eventBase, phase: z.literal("chunk"), text: z.string() }).strict(),
  z.object({ ...eventBase, phase: z.literal("complete") }).strict(),
]);
export type UiEvent = z.infer<typeof uiEventSchema>;
type StreamFrame = { event: string; data: unknown };

/** One compiler per run; this object survives reconnections, but never crosses threads/runs. */
export function createUiStream(baseline: CommittedUi | null) {
  const compiler = createSpecStreamCompiler<Spec>();
  const started = new Set<string>();
  let generationId: string | undefined;
  let lastSequence = -1;
  let complete = false;
  let gap = false;
  let hasPreview = false;
  let preview = baseline ? structuredClone(baseline.spec) : null;

  function resetPreview() {
    hasPreview = false;
    preview = baseline ? structuredClone(baseline.spec) : null;
  }

  function losePreview() {
    gap = true;
    resetPreview();
  }

  return {
    push(frame: StreamFrame) {
      // Namespaced custom|... frames belong to other graph scopes.
      if (
        frame.event !== "custom" ||
        !frame.data ||
        typeof frame.data !== "object" ||
        !("type" in frame.data) ||
        frame.data.type !== "json-render"
      )
        return;
      const parsed = uiEventSchema.safeParse(frame.data);

      if (!parsed.success) {
        losePreview();
        return;
      }

      const event = parsed.data;

      if (event.phase === "start") {
        if (complete || started.has(event.generationId)) return;
        // A graph retry starts a new SpecStream in the same run.
        started.add(event.generationId);
        generationId = event.generationId;
        lastSequence = event.sequence;
        gap = false;
        compiler.reset();
        resetPreview();
        return;
      }

      if (generationId && event.generationId !== generationId) return;
      if (event.sequence <= lastSequence) return;

      if (!generationId || event.sequence !== lastSequence + 1 || complete) {
        losePreview();
        return;
      }

      lastSequence = event.sequence;
      if (gap) return;

      try {
        if (event.phase === "chunk") {
          const compiled = compiler.push(event.text);

          if (compiled.newPatches.length) {
            try {
              preview = structuredClone(validateUiSpec(compiled.result));
              hasPreview = true;
            } catch {
              // A patch can leave props or references incomplete. Keep the last renderable UI.
            }
          }
        }

        if (event.phase === "complete") {
          preview = structuredClone(validateUiSpec(compiler.getResult()));
          complete = true;
        }
      } catch {
        losePreview();
      }
    },
    snapshot() {
      return {
        spec: preview ? structuredClone(preview) : null,
        generationId,
        gap,
        preview: hasPreview && !gap,
        complete,
      };
    },
  };
}
