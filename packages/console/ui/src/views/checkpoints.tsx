// Time travel: read a thread at a past checkpoint, edit the state there, and run forward from it.
//
// This is the view that makes a checkpointer feel like more than a durability mechanism. Three
// distinct operations hide behind one table, and they compose:
//
//   • *Inspect*  — `getState(threadId, checkpointId)`: what did the graph believe at step 3?
//   • *Fork*     — `updateState(threadId, { values, checkpointId })`: write a new checkpoint whose
//                  parent is that one, without touching the original branch.
//   • *Run from* — a run carrying `checkpointId`: execute forward from there instead of the tip.
//
// Fork-then-run is the interesting pair: change one value at step 3 and watch a different ending.

import type { ThreadState } from "@langchain/langgraph-sdk";
import { GitBranch, Play, Search } from "lucide-react";
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
import { useAsync, type AsyncState } from "@/use-async";

import { Async, Json, Panel, ShortId, Timestamp } from "./parts";

export function CheckpointHistory({
  threadId,
  history,
  assistantId,
  onForked,
}: {
  threadId: string;
  history: AsyncState<ThreadState[]>;
  assistantId: string | undefined;
  onForked: () => void;
}) {
  const [selected, setSelected] = useState<string | undefined>();

  return (
    <>
      <Panel title="Checkpoint history" count={history.data?.length}>
        <Async state={history} empty="No checkpoints.">
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Checkpoint</TableHead>
                  <TableHead>Next</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((snapshot, index) => {
                  const checkpointId = snapshot.checkpoint?.checkpoint_id;
                  return (
                    <TableRow key={checkpointId ?? `${snapshot.created_at}-${index}`}>
                      <TableCell>
                        {checkpointId ? (
                          <ShortId id={checkpointId} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {snapshot.next?.join(", ") || (
                          <span className="text-muted-foreground">end</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Timestamp value={snapshot.created_at} />
                      </TableCell>
                      <TableCell className="text-right">
                        {checkpointId ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setSelected((current) =>
                                current === checkpointId ? undefined : checkpointId,
                              )
                            }
                          >
                            <Search className="size-3.5" />
                            {selected === checkpointId ? "Close" : "Open"}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Async>
      </Panel>

      {selected ? (
        <CheckpointDetail
          threadId={threadId}
          checkpointId={selected}
          assistantId={assistantId}
          onForked={onForked}
        />
      ) : null}
    </>
  );
}

function CheckpointDetail({
  threadId,
  checkpointId,
  assistantId,
  onForked,
}: {
  threadId: string;
  checkpointId: string;
  assistantId: string | undefined;
  onForked: () => void;
}) {
  const client = createConsoleClient();
  const [draft, setDraft] = useState<string | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>();

  const state = useAsync(
    (signal) => client.threads.getState(threadId, checkpointId, { signal }),
    [threadId, checkpointId],
  );

  const run = async (mode: "fork" | "fork-and-run" | "run") => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      let target = checkpointId;
      if (mode !== "run") {
        const values = JSON.parse(draft ?? JSON.stringify(state.data?.values ?? {}, null, 2));
        // Writing at a past checkpoint creates a *new* checkpoint whose parent is that one. The
        // original branch is untouched — nothing here is destructive.
        const forked = await client.threads.updateState(threadId, { values, checkpointId });
        const forkedId = forked.configurable?.["checkpoint_id"];
        if (typeof forkedId === "string") target = forkedId;
      }
      if (mode === "fork") {
        setNote(`Forked to ${target.slice(0, 8)}… — the original branch is unchanged.`);
      } else {
        if (assistantId === undefined) {
          throw new Error("No assistant to run with: this thread has no runs to read one from.");
        }
        // `input: null` + a checkpoint: resume the graph from that point rather than starting over.
        const created = await client.runs.create(threadId, assistantId, {
          input: null,
          checkpointId: target,
        });
        setNote(`Started run ${created.run_id.slice(0, 8)}… from ${target.slice(0, 8)}….`);
      }
      onForked();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title={`Checkpoint ${checkpointId.slice(0, 8)}…`}
      padded
      actions={<span className="text-xs text-muted-foreground">state as of this step</span>}
    >
      {error ? (
        <div className="mb-3 rounded-md border border-status-error/40 p-3 font-mono text-xs text-status-error">
          {error.message}
        </div>
      ) : null}
      {note ? (
        <div className="mb-3 rounded-md border border-status-success/40 p-3 text-xs text-status-success">
          {note}
        </div>
      ) : null}

      <Async state={state}>
        {(snapshot) => (
          <>
            <label className="mb-1.5 block text-xs text-muted-foreground" htmlFor="fork-values">
              Values — edit to fork with a different state.{" "}
              <span className="text-muted-foreground/80">
                These go through the graph&apos;s reducers, so a channel that appends (a message
                list, say) will <em>add</em> what you write rather than replace it.
              </span>
            </label>
            <textarea
              id="fork-values"
              className="mb-3 h-56 w-full rounded-md border border-input bg-muted/40 p-3 font-mono text-xs"
              value={draft ?? JSON.stringify(snapshot.values, null, 2)}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run("fork")}>
                <GitBranch className="size-3.5" />
                Fork here
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void run("fork-and-run")}>
                <Play className="size-3.5" />
                Fork and run
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("run")}>
                Run from here unchanged
              </Button>
            </div>
            <div className="mt-3">
              <Json value={snapshot} />
            </div>
          </>
        )}
      </Async>
    </Panel>
  );
}
