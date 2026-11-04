import type { Spec } from "@json-render/core";
import type { Client, Command, ThreadState } from "@langchain/langgraph-sdk";
import { z } from "zod";

import { committedUiSchema, decisionSchema, requestSchema, type CommittedUi } from "./catalog.js";
import { createUiStream } from "./ui-events.js";

const reviewSchema = z.object({
  kind: z.literal("review-plan"),
  generationId: z.string().uuid(),
  prompt: z.string(),
});
const valuesSchema = z.object({ ui: committedUiSchema.nullish(), approved: z.boolean().nullish() });
type Review = z.infer<typeof reviewSchema> & { id?: string };
export interface PlanSnapshot {
  threadId: string | null;
  runId: string | null;
  ui: CommittedUi | null;
  spec: Spec | null;
  preview: boolean;
  busy: boolean;
  connected: boolean;
  review: Review | null;
  approved: boolean | null;
  error: string | null;
  recovery: string | null;
}

const initialSnapshot: PlanSnapshot = {
  threadId: null,
  runId: null,
  ui: null,
  spec: null,
  preview: false,
  busy: false,
  connected: false,
  review: null,
  approved: null,
  error: null,
  recovery: null,
};
const isActive = (status: string) => status === "running" || status === "pending";
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

function readReview(state: ThreadState<Record<string, unknown>>): Review | null {
  for (const task of state.tasks)
    for (const interruption of task.interrupts) {
      const parsed = reviewSchema.safeParse(interruption.value);
      if (parsed.success)
        return { ...parsed.data, ...(interruption.id ? { id: interruption.id } : {}) };
    }
  return null;
}

/** Application lifecycle around the SDK. Transport parsing and retries remain upstream. */
export function createPlanSession(client: Client<Record<string, unknown>>) {
  let snapshot: PlanSnapshot = { ...initialSnapshot };
  let epoch = 0;
  const listeners = new Set<() => void>();
  let observation: {
    threadId: string;
    runId: string;
    stream: ReturnType<typeof createUiStream>;
    cursor?: string;
    controller?: AbortController;
  } | null = null;

  function publish(changes: Partial<PlanSnapshot>) {
    snapshot = { ...snapshot, ...changes };
    for (const listener of listeners) listener();
  }
  function leave() {
    epoch++;
    observation?.controller?.abort();
    observation = null;
    return epoch;
  }
  async function restore(threadId: string, token: number) {
    const state = await client.threads.getState(threadId);
    if (token !== epoch) return;
    const values = valuesSchema.parse(state.values);
    const ui = values.ui ? structuredClone(values.ui) : null;
    const review = readReview(state);
    if (review && review.generationId !== ui?.generationId)
      throw new Error("The pending review does not match the saved plan. Refresh this thread.");
    publish({
      ui,
      spec: ui?.spec ?? null,
      preview: false,
      review,
      approved: values.approved ?? null,
      recovery: null,
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
            spec: preview.spec,
            preview: !preview.gap,
            recovery: preview.gap
              ? "Some updates are missing. Showing the last saved plan until this run finishes."
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
      await restore(current.threadId, token);
      if (token === epoch)
        publish({
          busy: false,
          connected: false,
          error:
            failure ??
            (["error", "timeout"].includes(run.status)
              ? "Generation failed. Showing the last saved plan."
              : null),
        });
    } catch (error) {
      if (token === epoch)
        publish({
          connected: false,
          error: describeError(error) + ". Refresh the thread to recover saved state.",
        });
    }
  }
  async function startRun(payload: { input: Record<string, unknown> | null; command?: Command }) {
    const token = leave();
    publish({
      busy: true,
      runId: null,
      error: null,
      recovery: null,
      spec: snapshot.ui?.spec ?? null,
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
      const run = await client.runs.create(threadId, "plan-builder", {
        ...payload,
        streamMode: ["custom", "values"],
        streamSubgraphs: true,
        multitaskStrategy: "reject",
      });
      if (token !== epoch) return;
      observation = { threadId, runId: run.run_id, stream: createUiStream(snapshot.ui) };
      publish({ runId: run.run_id, review: null, approved: null });
      await follow(observation, token);
    } catch (error) {
      if (token === epoch)
        publish({
          busy: false,
          connected: false,
          error:
            describeError(error) + ". Refresh this thread before retrying an uncertain request.",
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
        if (token === epoch) publish({ busy: false, error: describeError(error) });
      }
    },
    async generate(request: unknown) {
      if (snapshot.busy || snapshot.review) return;
      const parsed = requestSchema.safeParse(request);
      if (!parsed.success) {
        publish({ error: "Enter a request between 1 and 2000 characters." });
        return;
      }
      await startRun({ input: { request: parsed.data } });
    },
    async decide(approved: boolean) {
      if (snapshot.busy || !snapshot.review || !snapshot.ui) return;
      const decision = decisionSchema.parse({ generationId: snapshot.ui.generationId, approved });
      const resume = snapshot.review.id ? { [snapshot.review.id]: decision } : decision;
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
        if (token === epoch) publish({ error: describeError(error) });
      }
    },
    dispose: leave,
  };
}
