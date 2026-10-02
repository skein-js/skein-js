// Threads: the list, and a thread's current state, checkpoint history and runs.
//
// Note what a global "recent runs" view would have to do: there is no cross-thread run search in the
// protocol (runs list per thread, `GET /threads/:id/runs`), so it would have to fan out over threads.
// That gap is real and deliberate to surface — see packages/console/README.md.

import type { Thread } from "@langchain/langgraph-sdk";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { routeHref, useRoute } from "@/router";
import { useAsync } from "@/use-async";
import { usePagedRows } from "@/use-paged-rows";

import { CheckpointHistory } from "./checkpoints";
import { InterruptPanel, pendingInterrupts } from "./interrupts";
import { Async, IdLink, Json, Pagination, Panel, StatusBadge, Timestamp } from "./parts";
import { RunView } from "./run";

export function ThreadsView({
  threadId,
  runId,
  status,
}: {
  threadId?: string;
  runId?: string;
  /** Pre-selected status filter, so the overview's "Waiting for you" card can link straight to it. */
  status?: string;
}) {
  if (threadId && runId) return <RunView threadId={threadId} runId={runId} />;
  if (threadId) return <ThreadDetail threadId={threadId} />;
  // An unrecognized `?status=` falls back to "all" rather than filtering on a value the server has
  // never heard of and showing a confidently empty table.
  return <ThreadList status={STATUS_FILTERS.find((value) => value === status) ?? "all"} />;
}

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" aria-label="Refresh" onClick={onClick}>
      <RefreshCw className="size-3.5" />
    </Button>
  );
}

/** The statuses a thread can be in, plus "everything". `interrupted` is the one people come here for. */
const STATUS_FILTERS = ["all", "interrupted", "busy", "idle", "error"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * The filter lives in the URL, not in component state.
 *
 * Holding it in state seeded from a prop meant navigating from `#/threads?status=interrupted` back to
 * `#/threads` left the old filter applied — the hash changed, the component did not remount, and the
 * seed never ran again. Deriving it from the route also makes every filtered view a link you can
 * share, and makes the browser's back button do the obvious thing.
 */
function ThreadList({ status }: { status: StatusFilter }) {
  const client = createConsoleClient();
  const { navigate } = useRoute();
  const threads = usePagedRows(
    (offset, limit, signal) =>
      client.threads.search({
        offset,
        limit,
        sortBy: "updated_at",
        sortOrder: "desc",
        ...(status === "all" ? {} : { status }),
        signal,
      }),
    status,
    50,
    (signal) => client.threads.count({ ...(status === "all" ? {} : { status }), signal }),
  );

  return (
    <Panel
      title="Threads"
      count={threads.total ?? threads.rows?.length}
      actions={
        <>
          <div className="flex rounded-md border p-0.5">
            {STATUS_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => navigate(value === "all" ? "threads" : `threads?status=${value}`)}
                className={cn(
                  "rounded px-2 py-0.5 text-xs transition-colors",
                  status === value
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value}
              </button>
            ))}
          </div>
          <RefreshButton onClick={threads.reload} />
        </>
      }
    >
      <Async
        state={{ ...threads, data: threads.rows }}
        empty={
          status === "interrupted"
            ? "Nothing is waiting for you."
            : status === "all"
              ? "No threads yet."
              : `No ${status} threads.`
        }
      >
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Thread</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((thread) => (
                <TableRow key={thread.thread_id}>
                  <TableCell>
                    <IdLink id={thread.thread_id} to={`threads/${thread.thread_id}`} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={thread.status} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={thread.created_at} />
                  </TableCell>
                  <TableCell>
                    <Timestamp value={thread.updated_at} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Async>
      <Pagination
        {...threads}
        count={threads.rows?.length ?? 0}
        onPrevious={threads.previous}
        onNext={threads.next}
      />
    </Panel>
  );
}

function ThreadDetail({ threadId }: { threadId: string }) {
  const client = createConsoleClient();
  const thread = useAsync((signal) => client.threads.get(threadId, { signal }), [threadId]);
  const state = useAsync(
    (signal) => client.threads.getState(threadId, undefined, { signal }),
    [threadId],
  );
  const runs = usePagedRows(
    (offset, limit, signal) => client.runs.list(threadId, { offset, limit, signal }),
    threadId,
    50,
  );
  const latestRun = useAsync(
    (signal) => client.runs.list(threadId, { limit: 1, signal }),
    [threadId],
  );

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <a
          href={routeHref("threads")}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Threads
        </a>
        <span className="font-mono text-xs text-muted-foreground">{threadId}</span>
        {thread.data ? <StatusBadge status={thread.data.status} /> : null}
      </div>

      <InterruptPanel
        threadId={threadId}
        // The assistant that parked here: the most recent run's. Reading it off the thread's own runs
        // means resuming never has to ask the operator which assistant to use.
        assistantId={latestRun.data?.[0]?.assistant_id}
        interrupts={pendingInterrupts(state.data)}
        onResumed={() => {
          state.reload();
          runs.reload();
          latestRun.reload();
          thread.reload();
        }}
      />

      <Panel title="Thread" padded actions={<RefreshButton onClick={thread.reload} />}>
        <Async state={thread}>{(data) => <Json value={data} />}</Async>
      </Panel>

      {thread.data ? (
        <ThreadMetadataEditor
          key={`${threadId}:${thread.data.updated_at}`}
          thread={thread.data}
          onSaved={thread.reload}
        />
      ) : null}

      <Panel
        title="Runs"
        count={runs.rows?.length}
        actions={<RefreshButton onClick={runs.reload} />}
      >
        <Async state={{ ...runs, data: runs.rows }} empty="No runs on this thread.">
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assistant</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((run) => (
                  <TableRow key={run.run_id}>
                    <TableCell>
                      <IdLink id={run.run_id} to={`threads/${threadId}/runs/${run.run_id}`} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={run.status} />
                    </TableCell>
                    <TableCell>
                      <IdLink id={run.assistant_id} to={`assistants/${run.assistant_id}`} />
                    </TableCell>
                    <TableCell>
                      <Timestamp value={run.created_at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Async>
        <Pagination
          {...runs}
          count={runs.rows?.length ?? 0}
          onPrevious={runs.previous}
          onNext={runs.next}
        />
      </Panel>

      <Panel title="Current state" padded>
        <Async state={state}>{(data) => <Json value={data} />}</Async>
      </Panel>

      <CheckpointHistory
        key={threadId}
        threadId={threadId}
        assistantId={latestRun.data?.[0]?.assistant_id}
        onForked={() => {
          state.reload();
          runs.reload();
          latestRun.reload();
          thread.reload();
        }}
      />
    </>
  );
}

function ThreadMetadataEditor({ thread, onSaved }: { thread: Thread; onSaved: () => void }) {
  const [draft, setDraft] = useState(JSON.stringify(thread.metadata ?? {}, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const metadata = JSON.parse(draft) as unknown;
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
        throw new Error("Thread metadata must be a JSON object.");
      await createConsoleClient().threads.update(thread.thread_id, {
        metadata: metadata as Record<string, unknown>,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Edit thread metadata" padded>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="text-xs text-muted-foreground" htmlFor="thread-metadata">
          Metadata (JSON)
        </label>
        <textarea
          id="thread-metadata"
          className="h-32 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
        />
        {error ? (
          <p role="alert" className="text-xs text-status-error">
            {error.message}
          </p>
        ) : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Save metadata
          </Button>
        </div>
      </form>
    </Panel>
  );
}
