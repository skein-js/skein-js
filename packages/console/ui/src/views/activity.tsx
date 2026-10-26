import { Activity, CheckCircle2, Circle, PauseCircle } from "lucide-react";

import type { RunFrame } from "@/use-run-stream";

import { Json } from "./parts";

export function describeExecution({
  running,
  status,
  lastNode,
  pending,
  error,
}: {
  running: boolean;
  status?: string;
  lastNode?: string;
  pending: number;
  error?: Error;
}): { title: string; description: string; tone: string } {
  if (pending > 0 && !running)
    return {
      title: "Needs your input",
      description: "Read the request below, then submit the value the graph needs to continue.",
      tone: "text-status-interrupted",
    };
  if (error)
    return {
      title: "Unable to complete this request",
      description: error.message,
      tone: "text-status-error",
    };
  if (running)
    return {
      title: "Run in progress",
      description: lastNode
        ? `Last reported output: ${lastNode}. Waiting for the next update.`
        : "Waiting for the first reported step. You can stop this run at any time.",
      tone: "text-status-running",
    };
  if (status === "success")
    return {
      title: "Run completed",
      description: "Review the output or send another input to continue this thread.",
      tone: "text-status-success",
    };
  if (status === "error" || status === "timeout")
    return {
      title: status === "timeout" ? "Run timed out" : "Run failed",
      description: "Review the reported failure and current state before submitting another input.",
      tone: "text-status-error",
    };
  if (status === "cancelled")
    return {
      title: "Run stopped",
      description: "Completed steps were kept. Review the current state before continuing.",
      tone: "text-muted-foreground",
    };
  if (status === "interrupted")
    return {
      title: "Run interrupted",
      description: "Inspect the thread state to see where execution paused.",
      tone: "text-status-interrupted",
    };
  return {
    title: "Ready to run",
    description: "Send an input to create a run. Activity and output will appear here.",
    tone: "text-muted-foreground",
  };
}

export function ActivityFeed({
  frames,
  dropped = 0,
}: {
  frames: readonly RunFrame[];
  dropped?: number;
}) {
  const visible = frames.filter(
    (frame) => !frame.event.startsWith("messages") && frame.event !== "values",
  );
  return (
    <div className="space-y-3">
      {dropped > 0 && (
        <p className="help" role="status">
          {dropped} earlier events are outside this view&apos;s 500-event buffer.
        </p>
      )}
      {visible.length === 0 ? (
        <div className="py-10 text-center">
          <Activity className="mx-auto mb-3 size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Activity appears as it is reported</p>
          <p className="help mt-2">
            Steps, pauses, and errors will be shown here. Open Graph to inspect the structure.
          </p>
        </div>
      ) : (
        <ol className="space-y-3">
          {visible.map((frame) => {
            const payload = frame.data as { status?: string } | undefined;
            const title =
              frame.event === "updates"
                ? `Output reported · ${
                    Object.keys(frame.data ?? {})
                      .filter((key) => key !== "__interrupt__")
                      .join(", ") || "interrupt"
                  }`
                : frame.event === "end"
                  ? `Run ${payload?.status ?? "ended"}`
                  : frame.event === "error"
                    ? "Run reported an error"
                    : frame.event === "custom"
                      ? "Custom update"
                      : frame.event;
            const Icon =
              frame.event === "end" && payload?.status === "success"
                ? CheckCircle2
                : frame.event === "updates"
                  ? Circle
                  : PauseCircle;
            return (
              <li key={frame.seq} className="flex gap-3">
                <Icon className="mt-1 size-4 shrink-0 text-primary" aria-hidden />
                <details className="min-w-0 flex-1 rounded-lg border bg-card p-3">
                  <summary className="cursor-pointer text-sm font-medium">{title}</summary>
                  <div className="mt-2">
                    <Json value={frame.data} />
                  </div>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
