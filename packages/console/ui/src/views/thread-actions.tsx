import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";
import { useConfirmation } from "@/components/ui/dialog";
import { routeHref } from "@/router";

export function ThreadActions({
  threadId,
  onChanged,
}: {
  threadId: string;
  onChanged: () => void;
}) {
  const confirm = useConfirmation();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const perform = async (action: "copy" | "delete" | "keep_latest") => {
    if (
      action !== "copy" &&
      !(await confirm({
        title: action === "delete" ? "Delete this thread?" : "Trim checkpoint history?",
        description:
          action === "delete"
            ? "This stops active work and permanently deletes this thread, its runs, schedules, and checkpoints."
            : "This keeps the current state and removes older checkpoints. Active threads and threads with no older history are skipped.",
        confirmLabel: action === "delete" ? "Delete thread" : "Trim history",
      }))
    )
      return;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const client = createConsoleClient({});
      if (action === "copy") {
        const copied = await client.threads.copy(threadId);
        window.location.hash = routeHref(`threads/${copied.thread_id}`);
      } else if (action === "delete") {
        await client.threads.delete(threadId);
        window.location.hash = routeHref("threads");
      } else {
        const result = await client.threads.prune([threadId], { strategy: "keep_latest" });
        setMessage(
          result.pruned_count
            ? "Checkpoint history trimmed."
            : "No history changed. This thread may be active or already have only its latest checkpoint.",
        );
        onChanged();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void perform("copy")}>
          Copy thread
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void perform("keep_latest")}>
          Trim history
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void perform("delete")}>
          Delete thread
        </Button>
        <a
          className="inline-flex items-center px-3 text-sm text-primary"
          href={routeHref(`playground/${threadId}`)}
        >
          Continue in Playground ↗
        </a>
      </div>
      {message && (
        <p role="status" className="action-success mt-3">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="action-error mt-3">
          {error}
        </p>
      )}
    </div>
  );
}
