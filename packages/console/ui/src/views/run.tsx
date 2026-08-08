// A single run: what it is, what it is doing, and the two things you can do to it.
//
// The event tail is the point of this view. Everything else in the console is a snapshot; this is the
// one place you watch a graph think, live, and it works identically on a finished run because the
// server replays what it persisted.

import { ArrowLeft, Ban, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { routeHref } from "@/router";
import { useAsync } from "@/use-async";
import { useRunStream, type RunFrame } from "@/use-run-stream";

import { Async, Json, Panel, StatusBadge } from "./parts";

export function RunView({ threadId, runId }: { threadId: string; runId: string }) {
  const client = createConsoleClient();
  const [action, setAction] = useState<{ error?: Error; busy?: boolean }>({});
  const run = useAsync((signal) => client.runs.get(threadId, runId, { signal }), [threadId, runId]);
  const stream = useRunStream(threadId, runId);

  const inFlight = run.data?.status === "pending" || run.data?.status === "running";

  /** Run a mutation, then re-read the run — the console shows server state, not optimistic state. */
  const perform = async (mutate: () => Promise<void>, after: "reload" | "leave") => {
    setAction({ busy: true });
    try {
      await mutate();
      setAction({});
      if (after === "leave") window.location.hash = routeHref(`threads/${threadId}`);
      else run.reload();
    } catch (error) {
      setAction({ error: error instanceof Error ? error : new Error(String(error)) });
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <a
          href={routeHref(`threads/${threadId}`)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Thread
        </a>
        <span className="font-mono text-xs text-muted-foreground">{runId}</span>
        {run.data ? <StatusBadge status={run.data.status} /> : null}
      </div>

      {action.error ? (
        <div className="mb-4 rounded-md border border-status-error/40 p-3 font-mono text-xs text-status-error">
          {action.error.message}
        </div>
      ) : null}

      <Panel
        title="Run"
        padded
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={!inFlight || action.busy}
              // `interrupt` stops the run where it is and settles it as `cancelled`.
              onClick={() =>
                perform(() => client.runs.cancel(threadId, runId, false, "interrupt"), "reload")
              }
            >
              <Ban className="size-3.5" />
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!inFlight || action.busy}
              // `rollback` additionally discards the checkpoints this run wrote, so the thread returns
              // to the state it had before the run started. Destructive, hence the separate control.
              onClick={() =>
                perform(() => client.runs.cancel(threadId, runId, false, "rollback"), "reload")
              }
            >
              <RotateCcw className="size-3.5" />
              Rollback
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={inFlight || action.busy}
              onClick={() => perform(() => client.runs.delete(threadId, runId), "leave")}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          </>
        }
      >
        <Async state={run}>{(data) => <Json value={data} />}</Async>
      </Panel>

      <Panel
        title="Event stream"
        count={stream.frames.length}
        actions={<StreamPhase phase={stream.phase} dropped={stream.dropped} />}
      >
        {stream.error ? (
          <div className="p-4 font-mono text-xs text-status-error">{stream.error.message}</div>
        ) : stream.frames.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {stream.phase === "connecting" ? "Waiting for the first frame…" : "No frames."}
          </div>
        ) : (
          <ol className="divide-y">
            {stream.frames.map((frame) => (
              <FrameRow key={frame.seq} frame={frame} />
            ))}
          </ol>
        )}
      </Panel>
    </>
  );
}

function StreamPhase({ phase, dropped }: { phase: string; dropped: number }) {
  const variant = phase === "error" ? "error" : phase === "ended" ? "muted" : "running";
  return (
    <span className="flex items-center gap-2">
      {dropped > 0 ? (
        <span className="text-xs text-muted-foreground">{dropped} earlier frames dropped</span>
      ) : null}
      <Badge variant={variant}>{phase}</Badge>
    </span>
  );
}

/**
 * One frame, collapsed to a summary line. Expanding is opt-in because a token stream is thousands of
 * frames and rendering every payload would make the view unusable exactly when it matters most.
 */
function FrameRow({ frame }: { frame: RunFrame }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="px-3 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-baseline gap-3 text-left"
      >
        <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
          {frame.seq}
        </span>
        <span className="shrink-0 font-mono text-xs font-medium">{frame.event}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {summarize(frame.data)}
        </span>
      </button>
      {open ? (
        <div className="mt-1.5 pl-[3.25rem]">
          <Json value={frame.data} />
        </div>
      ) : null}
    </li>
  );
}

/** A one-line preview of a frame payload — enough to scan for, not enough to wrap. */
function summarize(data: unknown): string {
  if (data === null || data === undefined) return "";
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
