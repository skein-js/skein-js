import { useState } from "react";

import { createSkeinConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRoute } from "@/router";
import { usePagedRows } from "@/use-paged-rows";

import { Async, IdLink, Pagination, Panel, StatusBadge, Timestamp } from "./parts";

const FILTERS = [
  "status",
  "assistant_id",
  "thread_id",
  "created_after",
  "created_before",
  "updated_after",
  "updated_before",
] as const;
const STATUSES = ["pending", "running", "success", "error", "timeout", "interrupted", "cancelled"];

export function RunsView() {
  const [client] = useState(createSkeinConsoleClient);
  const { query, navigate } = useRoute();
  const filters = Object.fromEntries(
    FILTERS.flatMap((key) => (query.get(key) ? [[key, query.get(key)!]] : [])),
  );
  const filterKey = JSON.stringify(filters);
  const requestedOffset = Number(query.get("offset") ?? 0);
  const offset =
    Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  const runs = usePagedRows(
    (offset, limit, signal) => client.searchRuns({ ...filters, offset, limit }, signal),
    filterKey,
    50,
    undefined,
    "runs",
    {
      offset,
      onOffsetChange: (next) => {
        const selection = new URLSearchParams(filters);
        if (next > 0) selection.set("offset", String(next));
        navigate(`runs${selection.size ? `?${selection}` : ""}`);
      },
    },
  );
  const status =
    typeof runs.error === "object" && runs.error && "status" in runs.error
      ? runs.error.status
      : undefined;
  return (
    <>
      <form
        key={filterKey}
        className="mb-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = new FormData(event.currentTarget);
          const selection = new URLSearchParams();
          for (const key of FILTERS) {
            const value = String(fields.get(key) ?? "").trim();
            if (value) selection.set(key, value);
          }
          navigate(`runs${selection.size ? `?${selection}` : ""}`);
        }}
      >
        <label className="grid gap-1 text-xs">
          Run status
          <select name="status" className="field" defaultValue={filters.status ?? ""}>
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          Assistant ID
          <input className="field" name="assistant_id" defaultValue={filters.assistant_id} />
        </label>
        <label className="grid gap-1 text-xs">
          Thread ID
          <input className="field" name="thread_id" defaultValue={filters.thread_id} />
        </label>
        {(["created_after", "created_before", "updated_after", "updated_before"] as const).map(
          (key) => (
            <label key={key} className="grid gap-1 text-xs">
              {
                {
                  created_after: "Created after",
                  created_before: "Created before",
                  updated_after: "Updated after",
                  updated_before: "Updated before",
                }[key]
              }
              <input
                className="field"
                name={key}
                placeholder="2026-11-09T00:00:00Z"
                defaultValue={filters[key]}
              />
            </label>
          ),
        )}
        <div className="flex items-end gap-2">
          <Button type="submit">Search runs</Button>
          <Button type="button" variant="outline" onClick={() => navigate("runs")}>
            Clear
          </Button>
        </div>
      </form>
      <Panel
        title="Runs"
        actions={
          <Button variant="ghost" size="sm" onClick={runs.reload}>
            Refresh
          </Button>
        }
      >
        {status === 501 ? (
          <p className="p-4 text-sm" role="status">
            This server’s storage driver does not support global run search. Open Threads to inspect
            its runs.
          </p>
        ) : (
          <Async state={{ ...runs, data: runs.rows }} empty="No runs match these filters.">
            {(rows) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Assistant</TableHead>
                    <TableHead>Thread</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((run) => (
                    <TableRow key={run.run_id}>
                      <TableCell>
                        <IdLink
                          id={run.run_id}
                          to={`threads/${encodeURIComponent(run.thread_id)}/runs/${encodeURIComponent(run.run_id)}`}
                        />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={run.status} />
                      </TableCell>
                      <TableCell>
                        <IdLink
                          id={run.assistant_id}
                          to={`assistants/${encodeURIComponent(run.assistant_id)}`}
                        />
                      </TableCell>
                      <TableCell>
                        <IdLink
                          id={run.thread_id}
                          to={`threads/${encodeURIComponent(run.thread_id)}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Timestamp value={run.created_at} />
                      </TableCell>
                      <TableCell>
                        <Timestamp value={run.updated_at} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Async>
        )}
        <Pagination
          offset={runs.offset}
          count={runs.rows?.length ?? 0}
          hasNext={runs.hasNext}
          loading={runs.loading}
          onPrevious={runs.previous}
          onNext={runs.next}
        />
      </Panel>
    </>
  );
}
