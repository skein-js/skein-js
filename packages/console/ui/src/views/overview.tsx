// What is this server, and what is it doing right now.

import { ArrowUpRight, RefreshCw } from "lucide-react";

import { createConsoleClient, fetchServerInfo } from "@/api";
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
import { routeHref } from "@/router";
import { useAsync } from "@/use-async";

import { Async, IdLink, Json, Panel, StatusBadge, Timestamp } from "./parts";

export function OverviewView() {
  const client = createConsoleClient();

  const info = useAsync((signal) => fetchServerInfo(signal), []);
  const counts = useAsync(async (signal) => {
    // Counted rather than measured off a page of results: `search` with a limit tells you how many
    // rows came back, which is a different number and quietly caps at the page size.
    const [assistants, threads, crons, waiting] = await Promise.all([
      client.assistants.count({ signal }),
      client.threads.count({ signal }),
      client.crons.count({ signal }),
      // The number that actually needs a person. Everything else here is inventory.
      client.threads.count({ status: "interrupted", signal }),
    ]);
    return { assistants, threads, crons, waiting };
  }, []);
  const recent = useAsync(
    (signal) =>
      client.threads.search({ limit: 10, sortBy: "updated_at", sortOrder: "desc", signal }),
    [],
  );

  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* First, and the only one that can be urgent: these threads are parked on `interrupt()` and
            will stay parked until a person answers. A console that makes you hunt for them is a
            console that lets work sit. */}
        <Counter
          label="Waiting for you"
          value={counts.data?.waiting}
          to="threads?status=interrupted"
          highlight={(counts.data?.waiting ?? 0) > 0}
        />
        <Counter label="Threads" value={counts.data?.threads} to="threads" />
        <Counter label="Graphs" value={counts.data?.assistants} to="assistants" />
        <Counter label="Schedules" value={counts.data?.crons} to="crons" />
      </div>

      <Panel
        title="Recent threads"
        actions={
          <Button variant="ghost" size="icon" aria-label="Refresh" onClick={recent.reload}>
            <RefreshCw className="size-3.5" />
          </Button>
        }
      >
        <Async state={recent} empty="No threads yet — nothing has run on this server.">
          {(threads) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Thread</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Metadata</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {threads.map((thread) => (
                  <TableRow key={thread.thread_id}>
                    <TableCell>
                      <IdLink id={thread.thread_id} to={`threads/${thread.thread_id}`} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={thread.status} />
                    </TableCell>
                    <TableCell>
                      <Timestamp value={thread.updated_at} />
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-mono text-xs text-muted-foreground">
                      {summarizeMetadata(thread.metadata as Record<string, unknown> | undefined)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Async>
      </Panel>

      <Panel title="Server" padded>
        <Async state={info}>{(data) => <Json value={data} />}</Async>
      </Panel>
    </>
  );
}

/**
 * A stat card. The arrow on hover is the whole affordance — Vercel's cards are flat and quiet until
 * you point at them, which keeps a row of three from competing with the data below.
 */
function Counter({
  label,
  value,
  to,
  highlight = false,
}: {
  label: string;
  value?: number;
  to: string;
  /** Draw attention only when there is something to attend to — a zero is not an alert. */
  highlight?: boolean;
}) {
  return (
    <a
      href={routeHref(to)}
      className={cn(
        "group rounded-lg border bg-card p-4 transition-colors hover:border-foreground/20",
        highlight && "border-status-interrupted/40",
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-[13px] text-muted-foreground",
            highlight && "text-status-interrupted",
          )}
        >
          {label}
        </span>
        <ArrowUpRight
          className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      </div>
      <div
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums tracking-tight",
          highlight && "text-status-interrupted",
        )}
      >
        {value ?? <span className="text-muted-foreground">—</span>}
      </div>
    </a>
  );
}

/** One line of metadata, so the table stays a table. The thread view shows the whole object. */
function summarizeMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return "";
  const entries = Object.entries(metadata).filter(([key]) => !key.startsWith("$"));
  if (entries.length === 0) return "";
  const rendered = entries
    .slice(0, 3)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return entries.length > 3 ? `${rendered} +${entries.length - 3}` : rendered;
}
