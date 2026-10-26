// Approving an interrupt: the console's one genuinely interactive surface.
//
// A thread parked on `interrupt()` is waiting for a value from a human. That value is whatever the
// graph asked for — a boolean, an edited draft, a chosen option — so the console offers a JSON editor
// with shortcuts for the two answers almost every approval flow wants, rather than pretending to know
// the shape.

import type { ThreadState } from "@langchain/langgraph-sdk";
import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { createConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";
import { Json, Panel } from "@/views/parts";

/** Every pending interrupt on a thread, with the task that raised it. */
export function pendingInterrupts(
  state: ThreadState | undefined,
): { taskId: string; taskName: string; value: unknown }[] {
  if (!state?.tasks) return [];
  return state.tasks.flatMap((task) =>
    (task.interrupts ?? []).map((interrupt) => ({
      taskId: task.id,
      taskName: task.name,
      value: interrupt.value,
    })),
  );
}

export function InterruptPanel({
  threadId,
  assistantId,
  interrupts,
  onResumed,
  onFrame,
  onObserving,
  onRunCreated,
}: {
  threadId: string;
  /** The assistant to resume with — the one whose run parked here. */
  assistantId: string | undefined;
  interrupts: { taskId: string; taskName: string; value: unknown }[];
  onResumed: () => void;
  onFrame?: (event: string, payload: unknown) => void;
  onObserving?: (observing: boolean) => void;
  onRunCreated?: (run: { thread_id: string; run_id: string }) => void;
}) {
  const observation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => observation.current?.abort(), []);
  const [draft, setDraft] = useState("true");
  const [error, setError] = useState<Error | undefined>();
  const [busy, setBusy] = useState(false);
  const [submittedValue, setSubmittedValue] = useState<unknown>();

  if (interrupts.length === 0 && !busy) return null;

  const resume = async (raw: string) => {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      // A bare word is what someone types when the graph wants a string; accept it rather than
      // failing on the difference between `approve` and `"approve"`.
      value = raw;
    }
    setSubmittedValue(value);
    setBusy(true);
    onObserving?.(true);
    setError(undefined);
    try {
      if (assistantId === undefined) {
        throw new Error(
          "No assistant to resume with: this thread has no runs to read one from. Start the run from your app instead.",
        );
      }
      // `input: null` plus a resume command is what continues an interrupted graph — the run picks up
      // from the checkpoint the interrupt parked on rather than starting over.
      const client = createConsoleClient({});
      const resumed = await client.runs.create(threadId, assistantId, {
        input: null,
        command: { resume: value },
      });
      onRunCreated?.(resumed);
      onResumed();
      const controller = new AbortController();
      observation.current = controller;
      for await (const frame of client.runs.joinStream(threadId, resumed.run_id, {
        signal: controller.signal,
        cancelOnDisconnect: false,
      })) {
        onFrame?.(String(frame.event), frame.data);
        if (String(frame.event) === "error") throw new Error(JSON.stringify(frame.data));
      }
      onResumed();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setBusy(false);
      onObserving?.(false);
    }
  };

  return (
    <Panel
      title="Waiting for you"
      count={interrupts.length}
      padded
      actions={
        <span className="text-xs text-muted-foreground">
          Execution is paused until you provide a response.
        </span>
      }
    >
      {busy && (
        <p className="mb-3 text-sm" role="status">
          Following the resumed run to completion…
        </p>
      )}
      {busy && (
        <div className="mb-3">
          <p className="help mb-2">Submitted response</p>
          <Json value={submittedValue} />
        </div>
      )}
      {interrupts.map((interrupt) => (
        <div key={`${interrupt.taskId}:${interrupt.taskName}`} className="mb-3">
          <div className="mb-1.5 text-xs text-muted-foreground">
            raised by <span className="font-mono">{interrupt.taskName}</span>
            <span className="ml-2 break-all font-mono text-[11px]">Task {interrupt.taskId}</span>
          </div>
          <Json value={interrupt.value} />
        </div>
      ))}

      {error ? (
        <div className="mb-3 rounded-md border border-status-error/40 p-3 font-mono text-xs text-status-error">
          {error.message}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void resume("true")}>
          Send true
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void resume("false")}>
          Send false
        </Button>
        <span className="mx-1 text-xs text-muted-foreground">or send this response:</span>
        <input
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Resume value (JSON)"
          className="h-8 min-w-56 flex-1 rounded-md border border-input bg-background px-2.5 font-mono text-xs"
          placeholder='{"edited": "draft"}'
        />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void resume(draft)}>
          <Play className="size-3.5" />
          {busy ? "Resuming…" : "Resume"}
        </Button>
      </div>
    </Panel>
  );
}
