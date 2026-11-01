import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { routeHref } from "@/router";
import { usePagedRows } from "@/use-paged-rows";

import { Async, Pagination, StatusBadge, Timestamp } from "./parts";
import { describeThread } from "./thread-label";

export function RecentThreads() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Recent threads
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Recent threads"
        description="Threads you can access on this server, most recently updated first."
        side
      >
        {open && <RecentThreadList onOpen={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function RecentThreadList({ onOpen }: { onOpen: () => void }) {
  const [client] = useState(() => createConsoleClient({}));
  const [exactId, setExactId] = useState("");
  const threads = usePagedRows(
    (offset, limit, signal) =>
      client.threads.search({ offset, limit, sortBy: "updated_at", sortOrder: "desc", signal }),
    "recent-threads",
    20,
    (signal) => client.threads.count({ signal }),
    "recent-threads",
  );
  return (
    <>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!exactId.trim()) return;
          window.location.hash = routeHref(`playground/${encodeURIComponent(exactId.trim())}`);
          onOpen();
        }}
      >
        <input
          className="field min-w-0"
          aria-label="Open exact Playground thread ID"
          placeholder="Full thread ID"
          value={exactId}
          onChange={(event) => setExactId(event.target.value)}
        />
        <Button type="submit" variant="outline">
          Open
        </Button>
      </form>
      <div className="mb-3 flex items-center justify-between gap-2">
        <a className="text-primary underline" href={routeHref("threads")} onClick={onOpen}>
          View all threads
        </a>
        <Button variant="ghost" size="sm" onClick={threads.reload} disabled={threads.loading}>
          Refresh
        </Button>
      </div>
      <Async
        state={{ ...threads, data: threads.rows }}
        empty="No threads yet. Send an input to start one."
      >
        {(rows) => (
          <ul className="divide-y">
            {rows.map((thread) => (
              <li key={thread.thread_id} className="py-3">
                <a
                  className="block break-words text-sm font-medium text-primary hover:underline"
                  href={routeHref(`playground/${encodeURIComponent(thread.thread_id)}`)}
                  onClick={onOpen}
                >
                  {describeThread(thread)}
                </a>
                <p className="my-1 break-all font-mono text-xs text-muted-foreground">
                  {thread.thread_id}
                </p>
                <div className="flex flex-wrap justify-between gap-2">
                  <StatusBadge status={thread.status} />
                  <Timestamp value={thread.updated_at} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Async>
      <Pagination
        {...threads}
        count={threads.rows?.length ?? 0}
        onPrevious={threads.previous}
        onNext={threads.next}
      />
    </>
  );
}
