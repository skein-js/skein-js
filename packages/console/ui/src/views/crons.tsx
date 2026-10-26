import type { Cron } from "@langchain/langgraph-sdk";
import { Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, useConfirmation } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePagedRows } from "@/use-paged-rows";

import { Async, IdLink, Pagination, Panel, ShortId, Timestamp } from "./parts";

export function CronsView() {
  const [client] = useState(() => createConsoleClient({}));
  const confirm = useConfirmation();
  const [error, setError] = useState<string>(),
    [busy, setBusy] = useState<string>(),
    [creating, setCreating] = useState(false),
    [editing, setEditing] = useState<Cron>();
  const crons = usePagedRows(
    (offset, limit, signal) =>
      client.crons.search({ offset, limit, sortBy: "next_run_date", signal }),
    "schedules",
    50,
    (signal) => client.crons.count({ signal }),
  );
  const perform = async (id: string, mutate: () => Promise<unknown>) => {
    setBusy(id);
    setError(undefined);
    try {
      await mutate();
      crons.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setCreating(true)}>New schedule</Button>
      </div>
      {error && (
        <p className="action-error mb-4" role="alert">
          {error}
        </p>
      )}
      <Panel
        title="Schedules"
        count={crons.total ?? crons.rows?.length}
        actions={
          <Button variant="ghost" size="sm" onClick={crons.reload}>
            Refresh
          </Button>
        }
      >
        <Async
          state={{ ...crons, data: crons.rows }}
          empty="No schedules yet. Create one to run an Assistant automatically."
        >
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Assistant</TableHead>
                  <TableHead>Thread</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((cron) => {
                  const enabled = (cron as Cron & { enabled?: boolean }).enabled !== false;
                  return (
                    <TableRow key={cron.cron_id}>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left font-mono text-xs text-primary"
                          onClick={() => setEditing(cron)}
                        >
                          {cron.schedule}
                        </button>
                        <p className="help">
                          {cron.timezone || "UTC"} · <ShortId id={cron.cron_id} />
                        </p>
                      </TableCell>
                      <TableCell>
                        <IdLink id={cron.assistant_id} to={`assistants/${cron.assistant_id}`} />
                      </TableCell>
                      <TableCell>
                        {cron.thread_id ? (
                          <IdLink id={cron.thread_id} to={`threads/${cron.thread_id}`} />
                        ) : (
                          <span className="help">Fresh thread each time</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {!enabled ? (
                          <Badge variant="muted">paused</Badge>
                        ) : cron.next_run_date ? (
                          <Timestamp value={cron.next_run_date} />
                        ) : (
                          <span title="The end time has passed or the expression has no future occurrence.">
                            <Badge variant="muted">no upcoming run</Badge>
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setEditing(cron)}>
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy === cron.cron_id}
                            aria-label={enabled ? "Pause" : "Resume"}
                            onClick={() =>
                              void perform(cron.cron_id, () =>
                                client.crons.update(cron.cron_id, {
                                  ...({ enabled: !enabled } as Record<string, unknown>),
                                }),
                              )
                            }
                          >
                            {enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Delete"
                            disabled={busy === cron.cron_id}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Delete schedule ${cron.cron_id}?`,
                                  description:
                                    "Future runs will stop. Existing runs and their history stay available.",
                                  confirmLabel: "Delete schedule",
                                })
                              )
                                void perform(cron.cron_id, () => client.crons.delete(cron.cron_id));
                            }}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Async>
        <Pagination
          {...crons}
          count={crons.rows?.length ?? 0}
          onPrevious={crons.previous}
          onNext={crons.next}
        />
      </Panel>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Create schedule"
        description="Choose an Assistant, a cadence, and whether each run should share a thread."
      >
        <ScheduleForm
          onSaved={() => {
            setCreating(false);
            crons.reload();
          }}
        />
      </Dialog>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
        title="Edit schedule"
        description="Changing the schedule, timezone, or end time preserves the saved run payload."
      >
        {editing && (
          <ScheduleForm
            key={editing.cron_id}
            existing={editing}
            onSaved={() => {
              setEditing(undefined);
              crons.reload();
            }}
          />
        )}
      </Dialog>
    </>
  );
}
function localDateTime(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function ScheduleForm({ existing, onSaved }: { existing?: Cron; onSaved: () => void }) {
  const [assistantId, setAssistantId] = useState(existing?.assistant_id ?? ""),
    [threadId, setThreadId] = useState(existing?.thread_id ?? ""),
    [scope, setScope] = useState(existing?.thread_id ? "thread" : "stateless");
  const [schedule, setSchedule] = useState(existing?.schedule ?? "*/5 * * * *"),
    [timezone, setTimezone] = useState(existing?.timezone ?? "UTC"),
    [endTime, setEndTime] = useState(localDateTime(existing?.end_time));
  const [input, setInput] = useState("{}"),
    [completion, setCompletion] = useState<"delete" | "keep">("delete"),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
          if (schedule.trim().split(/\s+/).length !== 5)
            throw new Error(
              "Use a standard five-field cron expression: minute hour day month weekday.",
            );
          new Intl.DateTimeFormat("en", { timeZone: timezone || "UTC" }).format();
          const end = endTime ? new Date(endTime).toISOString() : undefined;
          const client = createConsoleClient({});
          if (existing) {
            const patch = {
              ...(schedule !== existing.schedule ? { schedule } : {}),
              ...(timezone !== (existing.timezone ?? "UTC") ? { timezone: timezone || null } : {}),
              ...(endTime !== localDateTime(existing.end_time) ? { endTime: end ?? null } : {}),
            };
            await client.crons.update(
              existing.cron_id,
              patch as Parameters<typeof client.crons.update>[1],
            );
          } else {
            const parsed: unknown = JSON.parse(input);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw new Error("Run input must be a JSON object.");
            const payload = {
              schedule,
              input: parsed as Record<string, unknown>,
              timezone: timezone || "UTC",
              ...(end ? { endTime: end } : {}),
              ...(scope === "stateless" ? { onRunCompleted: completion } : {}),
            };
            if (scope === "thread") {
              if (!threadId.trim()) throw new Error("Enter an existing thread ID.");
              await client.crons.createForThread(threadId, assistantId, payload);
            } else await client.crons.create(assistantId, payload);
          }
          onSaved();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      {!existing && (
        <>
          <label className="field-label">
            Assistant
            <input
              aria-label="Assistant"
              className="field"
              required
              value={assistantId}
              onChange={(event) => setAssistantId(event.target.value)}
              placeholder="Assistant ID or registered graph name"
            />
          </label>
          <label className="field-label">
            Thread scope
            <select
              aria-label="Thread scope"
              className="field"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="stateless">Fresh thread for each run</option>
              <option value="thread">Continue an existing thread</option>
            </select>
          </label>
          {scope === "thread" && (
            <label className="field-label">
              Existing thread ID
              <input
                aria-label="Existing thread ID"
                className="field"
                required
                value={threadId}
                onChange={(event) => setThreadId(event.target.value)}
              />
            </label>
          )}
        </>
      )}
      <label className="field-label">
        Cron expression
        <input
          aria-label="Cron expression"
          className="field font-mono"
          list="cron-examples"
          value={schedule}
          required
          onChange={(event) => setSchedule(event.target.value)}
        />
        <datalist id="cron-examples">
          <option value="*/5 * * * *">Every five minutes</option>
          <option value="0 9 * * 1-5">Weekdays at 09:00</option>
          <option value="0 0 * * *">Every day at midnight</option>
        </datalist>
        <span className="help">
          Five fields: minute · hour · day · month · weekday. For example, 0 9 * * 1-5 means
          weekdays at 09:00.
        </span>
      </label>
      {!existing && (
        <label className="field-label">
          Run input (JSON)
          <textarea
            aria-label="Run input (JSON)"
            className="field h-28 font-mono text-xs"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
      )}
      <details>
        <summary className="cursor-pointer text-sm">Timezone, end time, and retention</summary>
        <div className="mt-3 space-y-3">
          <label className="field-label">
            Schedule timezone
            <input
              aria-label="Schedule timezone"
              className="field"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              placeholder="UTC or America/New_York"
            />
            <span className="help">
              An IANA timezone. The recurrence follows this clock, including daylight saving
              changes.
            </span>
          </label>
          <label className="field-label">
            End time (optional)
            <input
              aria-label="End time (optional)"
              className="field"
              type="datetime-local"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
            />
            <span className="help">
              Your local clock ({Intl.DateTimeFormat().resolvedOptions().timeZone}), converted to
              UTC. An occurrence exactly at the end time is included.
            </span>
          </label>
          {!existing && scope === "stateless" && (
            <label className="field-label">
              After each completed run
              <select
                aria-label="After each completed run"
                className="field"
                value={completion}
                onChange={(event) => setCompletion(event.target.value as typeof completion)}
              >
                <option value="delete">Delete generated thread (default)</option>
                <option value="keep">Keep thread and history</option>
              </select>
              <span className="help">Thread schedules always keep the existing thread.</span>
            </label>
          )}
        </div>
      </details>
      {error && (
        <p role="alert" className="action-error">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : existing ? "Save schedule" : "Create schedule"}
      </Button>
    </form>
  );
}
