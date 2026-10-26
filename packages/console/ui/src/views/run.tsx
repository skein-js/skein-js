import type { Message } from "@langchain/langgraph-sdk";
import { ArrowLeft, Ban, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { createConsoleClient } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirmation } from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";
import { routeHref } from "@/router";
import { useAsync } from "@/use-async";
import { useRunStream, type RunFrame } from "@/use-run-stream";

import { ActivityFeed } from "./activity";
import { Async, Json, Panel, StatusBadge } from "./parts";
import { RunDeliveries } from "./run-deliveries";
import { Transcript } from "./transcript";

export function RunView({ threadId, runId }: { threadId: string; runId: string }) {
  const [client] = useState(() => createConsoleClient({}));
  const confirm = useConfirmation();
  const [tab, setTab] = useState<"activity" | "events" | "deliveries" | "details">("activity");
  const [action, setAction] = useState<{ error?: Error; busy?: boolean }>({});
  const run = useAsync((signal) => client.runs.get(threadId, runId, { signal }), [threadId, runId]);
  const stream = useRunStream(threadId, runId);
  const reloadRun = run.reload;
  useEffect(() => {
    if (stream.phase === "ended" || stream.phase === "error") reloadRun();
  }, [stream.phase, reloadRun]);
  const latestValues = [...stream.frames].reverse().find((frame) => frame.event === "values")
    ?.data as { messages?: Message[] } | undefined;
  const failure = run.data as typeof run.data & { error?: { message?: string } };
  const inFlight = run.data?.status === "pending" || run.data?.status === "running";
  const perform = async (kind: "cancel" | "rollback" | "delete") => {
    if (
      !(await confirm({
        title: `${kind === "delete" ? "Delete" : kind === "rollback" ? "Roll back" : "Stop"} this run?`,
        description:
          kind === "delete"
            ? "This permanently removes the run record."
            : kind === "rollback"
              ? "This stops execution and discards this run's checkpoint writes and record."
              : "This stops execution and keeps completed checkpoint writes.",
        confirmLabel:
          kind === "delete" ? "Delete run" : kind === "rollback" ? "Roll back run" : "Stop run",
      }))
    )
      return;
    setAction({ busy: true });
    try {
      if (kind === "delete") await client.runs.delete(threadId, runId);
      else
        await client.runs.cancel(
          threadId,
          runId,
          true,
          kind === "rollback" ? "rollback" : "interrupt",
        );
      setAction({});
      if (kind !== "cancel") window.location.hash = routeHref(`threads/${threadId}`);
      else run.reload();
    } catch (error) {
      setAction({ error: error instanceof Error ? error : new Error(String(error)) });
    }
  };
  return (
    <>
      <a
        href={routeHref(`threads/${threadId}`)}
        className="mb-4 inline-flex items-center gap-2 text-sm text-primary"
      >
        <ArrowLeft className="size-4" />
        Back to thread
      </a>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Run · one execution of an Assistant</p>
          <p className="break-all font-mono text-xs">{runId}</p>
          {run.data && <p className="help mt-1">Assistant: {run.data.assistant_id}</p>}
        </div>
        {run.data && <StatusBadge status={run.data.status} />}
        <Button
          variant="outline"
          size="sm"
          disabled={!inFlight || action.busy}
          onClick={() => void perform("cancel")}
        >
          <Ban className="size-3.5" />
          Stop
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!inFlight || action.busy}
          onClick={() => void perform("rollback")}
        >
          <RotateCcw className="size-3.5" />
          Roll back
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={inFlight || action.busy}
          onClick={() => void perform("delete")}
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </div>
      {action.error && (
        <p className="action-error mb-4" role="alert">
          {action.error.message}
        </p>
      )}
      <div className="mb-4 rounded-lg border bg-card p-4">
        <p className="font-medium">
          {inFlight
            ? "Execution is in progress"
            : run.data
              ? `Execution status: ${run.data.status}`
              : "Loading run status…"}
        </p>
        <p className="help mt-1">
          {stream.phase === "error"
            ? "The observer disconnected. This does not mean the run stopped. Refresh its status or reopen the stream."
            : stream.phase === "ended"
              ? "The event connection ended. The execution status above is read from the server."
              : "Following reported events. Leaving this view keeps the run executing."}
        </p>
        <div className="mt-2 flex items-center gap-3">
          <StreamPhase phase={stream.phase} dropped={stream.dropped} />
          <Button variant="ghost" size="sm" onClick={run.reload}>
            Refresh status
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Tabs
          value={tab}
          onChange={setTab}
          label="Run inspection"
          tabs={[
            { value: "activity", label: "Activity" },
            { value: "events", label: "Raw events" },
            { value: "deliveries", label: "Deliveries" },
            { value: "details", label: "Details" },
          ]}
        />
        <div className="min-w-0 p-4">
          {tab === "activity" && (
            <div className="space-y-6">
              {failure?.error?.message && (
                <p className="action-error" role="alert">
                  {failure.error.message}
                </p>
              )}
              {latestValues?.messages?.length ? (
                <Transcript messages={latestValues.messages} />
              ) : null}
              <ActivityFeed frames={stream.frames} dropped={stream.dropped} />
            </div>
          )}
          {tab === "events" && (
            <Panel title="Event stream" count={stream.frames.length}>
              {stream.error ? (
                <p className="action-error">{stream.error.message}</p>
              ) : stream.frames.length ? (
                <ol className="divide-y">
                  {stream.frames.map((frame) => (
                    <FrameRow key={frame.seq} frame={frame} />
                  ))}
                </ol>
              ) : (
                <p className="p-6 text-sm text-muted-foreground">
                  {stream.phase === "connecting"
                    ? "Waiting for the first event…"
                    : "No retained events."}
                </p>
              )}
            </Panel>
          )}
          {tab === "deliveries" && <RunDeliveries threadId={threadId} runId={runId} />}
          {tab === "details" && <Async state={run}>{(record) => <Json value={record} />}</Async>}
        </div>
      </div>
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
