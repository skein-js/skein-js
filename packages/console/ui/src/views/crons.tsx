// Schedules: what runs without anyone asking.
//
// The most useful column here is `next_run_date`. A cron whose expression parses but whose next
// occurrence is never (or a year away) looks identical to a healthy one in a list of schedules — this
// is the view where that becomes obvious.

import { Pause, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAsync } from "@/use-async";

import { Async, IdLink, Panel, ShortId, Timestamp } from "./parts";

export function CronsView() {
  const client = createConsoleClient();
  const [error, setError] = useState<Error | undefined>();
  const crons = useAsync(
    (signal) => client.crons.search({ limit: 100, sortBy: "next_run_date", signal }),
    [],
  );

  const perform = async (mutate: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await mutate();
      crons.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    }
  };

  return (
    <>
      {error ? (
        <div className="mb-4 rounded-md border border-status-error/40 p-3 font-mono text-xs text-status-error">
          {error.message}
        </div>
      ) : null}

      <CreateCron onCreated={() => crons.reload()} onError={setError} />

      <Panel title="Schedules" count={crons.data?.length}>
        <Async
          state={crons}
          empty="No schedules. Create one above, or from your app with client.crons.create()."
        >
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cron</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Assistant</TableHead>
                  <TableHead>Thread</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((cron) => {
                  // `enabled` is a skein/Platform field the SDK's Cron type does not name; read it
                  // defensively rather than asserting a shape the server may not send.
                  const enabled = (cron as { enabled?: boolean }).enabled !== false;
                  return (
                    <TableRow key={cron.cron_id}>
                      <TableCell>
                        <ShortId id={cron.cron_id} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {cron.schedule}
                        {cron.timezone ? (
                          <span className="ml-1.5 text-muted-foreground">{cron.timezone}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <IdLink id={cron.assistant_id} to={`assistants/${cron.assistant_id}`} />
                      </TableCell>
                      <TableCell>
                        {cron.thread_id ? (
                          <IdLink id={cron.thread_id} to={`threads/${cron.thread_id}`} />
                        ) : (
                          <span className="text-xs text-muted-foreground">stateless</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {!enabled ? (
                          <Badge variant="muted">paused</Badge>
                        ) : cron.next_run_date ? (
                          <Timestamp value={cron.next_run_date} />
                        ) : (
                          // Enabled with no next occurrence: the expression parsed but will never
                          // fire again. `Timestamp` renders a bare `—` for an absent value, which is
                          // right for a missing `created_at` and useless here — this is exactly the
                          // state this column exists to expose, so it says so.
                          <Badge variant="muted">no upcoming run</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={enabled ? "Pause" : "Resume"}
                          onClick={() =>
                            void perform(() =>
                              client.crons.update(cron.cron_id, {
                                // Not in the SDK's typed payload, but it is the field the Crons
                                // resource uses to pause a schedule without deleting it.
                                ...({ enabled: !enabled } as Record<string, unknown>),
                              }),
                            )
                          }
                        >
                          {enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete"
                          onClick={() => void perform(() => client.crons.delete(cron.cron_id))}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Async>
      </Panel>
    </>
  );
}

/** Enough to schedule something and watch it fire — the demo path, not a full cron editor. */
function CreateCron({
  onCreated,
  onError,
}: {
  onCreated: () => void;
  onError: (error: Error) => void;
}) {
  const [assistantId, setAssistantId] = useState("");
  const [schedule, setSchedule] = useState("*/5 * * * *");
  const [input, setInput] = useState("{}");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const parsed = JSON.parse(input) as Record<string, unknown>;
      await createConsoleClient().crons.create(assistantId, { schedule, input: parsed });
      onCreated();
    } catch (caught) {
      onError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="New schedule" padded>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Input
          value={assistantId}
          onChange={(event) => setAssistantId(event.target.value)}
          placeholder="assistant id or graph name"
          aria-label="Assistant"
          className="w-56 font-mono"
          required
        />
        <Input
          value={schedule}
          onChange={(event) => setSchedule(event.target.value)}
          placeholder="*/5 * * * *"
          aria-label="Cron expression"
          className="w-40 font-mono"
          required
        />
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="input JSON"
          aria-label="Run input (JSON)"
          className="w-64 font-mono"
        />
        <Button type="submit" size="sm" disabled={busy}>
          <Plus className="size-3.5" />
          Schedule
        </Button>
        <span className="text-xs text-muted-foreground">
          5-field expressions only — sub-minute schedules are a deliberate non-goal.
        </span>
      </form>
    </Panel>
  );
}
