import { ActionMessageSchema } from "@a2ui/web_core/v1_0";
import type { Client, Command, ThreadState } from "@langchain/langgraph-sdk";
import { z } from "zod";

import {
  conversationSchema,
  decisionSchema,
  parseSavedUi,
  promptSchema,
  requestSchema,
  type Conversation,
  type RendererMetadata,
  type SavedUi,
} from "./ui-contract.js";
import { createUiStream } from "./ui-events.js";

const reviewSchema = z.object({
  kind: z.literal("review-ui"),
  generationId: z.string().uuid(),
  prompt: z.string(),
});

const valuesSchema = z.object({
  conversation: conversationSchema.default([]),
  ui: z.unknown().nullish(),
  approved: z.boolean().nullish(),
});
type Review = z.infer<typeof reviewSchema> & { id: string };
interface UiSnapshot {
  conversation: Conversation;
  pendingPrompt: string | null;
  threadId: string | null;
  runId: string | null;
  ui: SavedUi | null;
  view: SavedUi | null;
  preview: boolean;
  busy: boolean;
  connected: boolean;
  review: Review | null;
  approved: boolean | null;
  error: string | null;
  recovery: string | null;
  needsRefresh: boolean;
}

const initialSnapshot: UiSnapshot = {
  conversation: [],
  pendingPrompt: null,
  threadId: null,
  runId: null,
  ui: null,
  view: null,
  preview: false,
  busy: false,
  connected: false,
  review: null,
  approved: null,
  error: null,
  recovery: null,
  needsRefresh: false,
};

const isActive = (status: string) => status === "running" || status === "pending";
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

function readReview(state: ThreadState<Record<string, unknown>>): Review | null {
  for (const task of state.tasks)
    for (const interruption of task.interrupts) {
      const parsed = reviewSchema.safeParse(interruption.value);

      if (parsed.success) {
        if (!interruption.id)
          throw new Error("The pending review has no interrupt identity. Start a New chat.");
        return { ...parsed.data, id: interruption.id };
      }
    }

  return null;
}

/** Application lifecycle around the SDK. Transport parsing and retries remain upstream. */
export function createUiSession(
  client: Client<Record<string, unknown>>,
  readMetadata: () => RendererMetadata,
) {
  let snapshot: UiSnapshot = { ...initialSnapshot };
  let epoch = 0;
  const listeners = new Set<() => void>();

  let observation: {
    threadId: string;
    runId: string;
    stream: ReturnType<typeof createUiStream>;
    onCommitted?: () => void;
    cursor?: string;
    controller?: AbortController;
  } | null = null;

  function publish(changes: Partial<UiSnapshot>) {
    snapshot = { ...snapshot, ...changes };
    for (const listener of listeners) listener();
  }

  function requireRefresh(error: unknown) {
    publish({
      busy: false,
      connected: false,
      view: snapshot.ui,
      preview: false,
      error: describeError(error) + ". Refresh the thread to recover saved state.",
      needsRefresh: true,
    });
  }

  function leave() {
    epoch++;
    observation?.controller?.abort();
    observation?.stream.dispose();
    observation = null;
    return epoch;
  }

  async function restore(threadId: string, token: number) {
    const state = await client.threads.getState(threadId);
    if (token !== epoch) return;
    const values = valuesSchema.parse(state.values);
    const ui = values.ui ? parseSavedUi(values.ui) : null;
    const review = readReview(state);
    if (review && review.generationId !== ui?.generationId)
      throw new Error("The pending review does not match the saved UI. Refresh this thread.");
    publish({
      conversation: ui
        ? values.conversation.map((turn) =>
            turn.generationId === ui.generationId ? { ...turn, ui } : turn,
          )
        : values.conversation,
      pendingPrompt: null,
      ui,
      view: ui,
      preview: false,
      review,
      approved: values.approved ?? null,
      recovery: null,
      needsRefresh: false,
    });
  }

  async function follow(current: NonNullable<typeof observation>, token: number) {
    if (token !== epoch) return;
    const controller = new AbortController();
    current.controller = controller;
    publish({ connected: true, error: null });
    let failure: string | null = null;

    try {
      for await (const frame of client.runs.joinStream(current.threadId, current.runId, {
        lastEventId: current.cursor,
        signal: controller.signal,
        cancelOnDisconnect: false,
      })) {
        if (token !== epoch || controller.signal.aborted) return;
        if (frame.id) current.cursor = frame.id;
        if (frame.event === "error")
          failure =
            z.object({ message: z.string() }).safeParse(frame.data).data?.message ??
            "Generation failed";
        current.stream.push(frame);
        const preview = current.stream.snapshot();
        if (preview.generationId || preview.gap)
          publish({
            view: preview.view,
            preview:
              !preview.gap &&
              Boolean(preview.view) &&
              preview.view?.generationId === preview.generationId,
            recovery: preview.gap
              ? "Some updates are missing. Showing the last saved UI until this run finishes."
              : null,
          });
      }
    } catch (error) {
      if (controller.signal.aborted || token !== epoch) return;
      failure = describeError(error);
    }

    if (token !== epoch || controller.signal.aborted) return;

    try {
      const run = await client.runs.get(current.threadId, current.runId);
      if (token !== epoch) return;

      if (isActive(run.status)) {
        publish({
          connected: false,
          error: failure ?? "Updates disconnected. Reconnect to keep watching this run.",
        });
        return;
      }

      // Reconcile even when replay was empty or its tail vanished. An SSE complete event isn't a checkpoint.
      const previousGenerationId = snapshot.ui?.generationId;
      await restore(current.threadId, token);

      if (token === epoch) {
        publish({
          busy: false,
          connected: false,
          error:
            failure ??
            (["error", "timeout"].includes(run.status)
              ? "Generation failed. Showing the last saved UI."
              : null),
        });
        if (
          snapshot.ui &&
          snapshot.ui.generationId !== previousGenerationId &&
          (run.status === "interrupted" || run.status === "success")
        )
          current.onCommitted?.();
      }
    } catch (error) {
      if (token === epoch) requireRefresh(error);
    }
  }

  async function startRun(
    payload: { input: Record<string, unknown> | null; command?: Command },
    pendingPrompt: string | null = null,
    onCommitted?: () => void,
  ) {
    const token = leave();
    publish({
      pendingPrompt,
      busy: true,
      runId: null,
      error: null,
      recovery: null,
      view: snapshot.ui,
      preview: false,
    });

    try {
      let threadId = snapshot.threadId;

      if (!threadId) {
        const thread = await client.threads.create();
        if (token !== epoch) return;
        threadId = thread.thread_id;
        publish({ threadId });
      }

      const run = await client.runs.create(threadId, "ui-playground", {
        ...payload,
        streamMode: ["custom", "values"],
        streamSubgraphs: true,
        multitaskStrategy: "reject",
      });
      if (token !== epoch) return;
      observation = {
        threadId,
        runId: run.run_id,
        stream: createUiStream(snapshot.ui),
        onCommitted,
      };
      publish({ runId: run.run_id, review: null, approved: null });
      await follow(observation, token);
    } catch (error) {
      if (token === epoch)
        publish({
          busy: false,
          connected: false,
          error:
            describeError(error) + ". Refresh this thread before retrying an uncertain request.",
          needsRefresh: true,
        });
    }
  }

  return {
    read: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    async open(threadId: string | null) {
      const token = leave();
      publish({ ...initialSnapshot, threadId, busy: Boolean(threadId) });
      if (!threadId) return;

      try {
        await restore(threadId, token);
        const [running, pending] = await Promise.all([
          client.runs.list(threadId, { status: "running", limit: 1 }),
          client.runs.list(threadId, { status: "pending", limit: 1 }),
        ]);
        if (token !== epoch) return;
        const active = running[0] ?? pending[0];

        if (!active) {
          // A run may have committed between the first state read and the active-run queries.
          await restore(threadId, token);
          if (token === epoch) publish({ busy: false });
          return;
        }

        observation = { threadId, runId: active.run_id, stream: createUiStream(snapshot.ui) };
        publish({ runId: active.run_id, busy: true });
        await follow(observation, token);
      } catch (error) {
        if (token === epoch)
          publish({ busy: false, error: describeError(error), needsRefresh: true });
      }
    },
    async generate(request: unknown, onCommitted?: () => void) {
      if (snapshot.busy || snapshot.review || snapshot.needsRefresh) return;
      const parsed = promptSchema.safeParse(request);

      if (!parsed.success) {
        publish({ error: "Enter a request between 1 and 2000 characters." });
        return;
      }

      try {
        await startRun(
          {
            input: {
              request: requestSchema.parse({
                kind: "generate",
                prompt: parsed.data,
                metadata: readMetadata(),
              }),
            },
          },
          parsed.data,
          onCommitted,
        );
      } catch (error) {
        publish({ error: describeError(error) });
      }
    },
    async act(message: unknown) {
      if (
        snapshot.busy ||
        snapshot.review ||
        snapshot.approved === null ||
        snapshot.preview ||
        snapshot.needsRefresh ||
        !snapshot.ui
      )
        return;

      try {
        const request = requestSchema.parse({
          kind: "action",
          generationId: snapshot.ui.generationId,
          message: ActionMessageSchema.parse(message),
          metadata: readMetadata(),
        });
        await startRun(
          { input: { request } },
          request.kind === "action" && request.message.action.name === "reviseUi"
            ? String(request.message.action.context?.["prompt"] ?? "")
            : null,
        );
      } catch (error) {
        publish({ error: describeError(error) });
      }
    },
    async decide(approved: boolean) {
      if (snapshot.busy || snapshot.needsRefresh || !snapshot.review || !snapshot.ui) return;
      const decision = decisionSchema.parse({ generationId: snapshot.ui.generationId, approved });
      const resume = { [snapshot.review.id]: decision };
      await startRun({ input: null, command: { resume } });
    },
    disconnect() {
      observation?.controller?.abort();
      publish({
        connected: false,
        recovery: snapshot.busy ? "Updates paused. The run continues on the server." : null,
      });
    },
    async reconnect() {
      if (observation && snapshot.busy && !snapshot.connected) await follow(observation, epoch);
    },
    async stop() {
      if (!observation || !snapshot.busy) return;
      const current = observation;
      const token = epoch;
      current.controller?.abort();
      publish({ connected: false });

      try {
        await client.runs.cancel(current.threadId, current.runId, true);
        const run = await client.runs.get(current.threadId, current.runId);
        if (token !== epoch) return;
        if (isActive(run.status)) throw new Error("Cancellation is still pending");
        await restore(current.threadId, token);
        if (token === epoch)
          publish({ busy: false, error: null, recovery: "Run stopped. Showing saved state." });
      } catch (error) {
        if (token === epoch) requireRefresh(error);
      }
    },
    dispose: leave,
  };
}
