// Assistants: what this server can actually run. The detail view is the introspection surface —
// graph shape, input/output schemas, and the immutable version history.

import type { Assistant } from "@langchain/langgraph-sdk";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { createConsoleClient } from "@/api";
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
import { routeHref } from "@/router";
import { useAsync } from "@/use-async";
import { usePagedRows } from "@/use-paged-rows";

import { Async, IdLink, Json, Pagination, Panel, Timestamp } from "./parts";

export function AssistantsView({ assistantId }: { assistantId?: string }) {
  return assistantId ? <AssistantDetail assistantId={assistantId} /> : <AssistantList />;
}

function AssistantList() {
  const client = createConsoleClient();
  const assistants = usePagedRows(
    (offset, limit, signal) => client.assistants.search({ offset, limit, signal }),
    "assistants",
    50,
    (signal) => client.assistants.count({ signal }),
  );

  return (
    <Panel title="Assistants" count={assistants.total ?? assistants.rows?.length}>
      <Async
        state={{ ...assistants, data: assistants.rows }}
        empty="No assistants. Declare a graph in langgraph.json."
      >
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Graph</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Assistant</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((assistant) => (
                <TableRow key={assistant.assistant_id}>
                  <TableCell>
                    <a
                      className="font-medium underline-offset-4 hover:underline"
                      href={routeHref(`assistants/${assistant.assistant_id}`)}
                    >
                      {assistant.name ?? <span className="text-muted-foreground">unnamed</span>}
                    </a>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{assistant.graph_id}</TableCell>
                  <TableCell className="max-w-sm text-[13px] text-muted-foreground">
                    {describeAssistant(assistant) ?? (
                      // Auto-registered assistants carry no description: `langgraph.json` has nowhere
                      // to put one, so only assistants created through `POST /assistants` have it.
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <IdLink
                      id={assistant.assistant_id}
                      to={`assistants/${assistant.assistant_id}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {assistant.version}
                  </TableCell>
                  <TableCell>
                    <Timestamp value={assistant.updated_at} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Async>
      <Pagination
        {...assistants}
        count={assistants.rows?.length ?? 0}
        onPrevious={assistants.previous}
        onNext={assistants.next}
      />
    </Panel>
  );
}

function AssistantDetail({ assistantId }: { assistantId: string }) {
  const client = createConsoleClient();
  const assistant = useAsync(
    (signal) => client.assistants.get(assistantId, { signal }),
    [assistantId],
  );
  const graph = useAsync(
    (signal) => client.assistants.getGraph(assistantId, { signal }),
    [assistantId],
  );
  const schemas = useAsync(
    (signal) => client.assistants.getSchemas(assistantId, { signal }),
    [assistantId],
  );
  const versions = usePagedRows(
    (offset, limit, signal) =>
      client.assistants.getVersions(assistantId, { offset, limit, signal }),
    assistantId,
    20,
  );

  return (
    <>
      <a
        href={routeHref("assistants")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Assistants
      </a>

      <Panel title="Assistant" padded>
        <Async state={assistant}>{(data) => <Json value={data} />}</Async>
      </Panel>

      {assistant.data ? (
        <AssistantEditor
          key={`${assistantId}:${assistant.data.version}`}
          assistant={assistant.data}
          onSaved={() => {
            assistant.reload();
            graph.reload();
            schemas.reload();
            versions.reload();
          }}
        />
      ) : null}

      <Panel title="Graph" padded>
        <Async state={graph}>{(data) => <Json value={data} />}</Async>
      </Panel>

      <Panel title="Schemas" padded>
        <Async state={schemas}>{(data) => <Json value={data} />}</Async>
      </Panel>

      <Panel title="Versions" count={versions.rows?.length}>
        <Async state={{ ...versions, data: versions.rows }} empty="No version history.">
          {(rows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((version) => (
                  <TableRow key={version.version}>
                    <TableCell className="font-mono text-xs tabular-nums">
                      {version.version}
                    </TableCell>
                    <TableCell>
                      {version.name ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Timestamp value={version.created_at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Async>
        <Pagination
          {...versions}
          count={versions.rows?.length ?? 0}
          onPrevious={versions.previous}
          onNext={versions.next}
        />
      </Panel>
    </>
  );
}

/**
 * An assistant's description, if it has one.
 *
 * Read defensively: the field is part of the create/update API but the SDK's `Assistant` type does not
 * name it, and skein's auto-registered one-per-graph assistants never set it. `metadata.description` is
 * checked too, since that is where people put it when the first-class field is unavailable.
 */
export function describeAssistant(assistant: unknown): string | undefined {
  if (typeof assistant !== "object" || assistant === null) return undefined;
  const record = assistant as { description?: unknown; metadata?: Record<string, unknown> };
  if (typeof record.description === "string" && record.description !== "")
    return record.description;
  const fromMetadata = record.metadata?.["description"];
  return typeof fromMetadata === "string" && fromMetadata !== "" ? fromMetadata : undefined;
}

function AssistantEditor({ assistant, onSaved }: { assistant: Assistant; onSaved: () => void }) {
  const client = createConsoleClient();
  const existing = assistant as Assistant & { description?: string; context?: unknown };
  const initial = {
    graphId: assistant.graph_id,
    name: assistant.name ?? "",
    description: existing.description ?? "",
    config: JSON.stringify(assistant.config ?? {}, null, 2),
    context: JSON.stringify(existing.context ?? null, null, 2),
    metadata: JSON.stringify(assistant.metadata ?? {}, null, 2),
  };
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const patch: Parameters<typeof client.assistants.update>[1] = {};
      if (draft.graphId !== initial.graphId) patch.graphId = draft.graphId;
      if (draft.name !== initial.name) patch.name = draft.name;
      if (draft.description !== initial.description) patch.description = draft.description;
      if (draft.config !== initial.config) {
        const config = JSON.parse(draft.config) as unknown;
        if (!isRecord(config)) throw new Error("Config must be a JSON object.");
        patch.config = config;
      }
      if (draft.context !== initial.context) patch.context = JSON.parse(draft.context) as unknown;
      if (draft.metadata !== initial.metadata) {
        const metadata = JSON.parse(draft.metadata) as unknown;
        if (!isRecord(metadata)) throw new Error("Metadata must be a JSON object.");
        const removedKeys = Object.keys(assistant.metadata ?? {}).filter(
          (key) => !Object.hasOwn(metadata, key),
        );
        if (removedKeys.length > 0)
          throw new Error(
            `Assistant metadata is merged by the server; removing ${removedKeys.join(", ")} is not supported.`,
          );
        patch.metadata = metadata;
      }
      if (Object.keys(patch).length === 0) return;
      await client.assistants.update(assistant.assistant_id, patch);
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Edit assistant" padded>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {(["graphId", "name", "description"] as const).map((field) => (
          <label key={field} className="grid gap-1 text-xs text-muted-foreground">
            {field === "graphId" ? "Graph ID" : field[0]!.toUpperCase() + field.slice(1)}
            <Input
              value={draft[field]}
              onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
            />
          </label>
        ))}
        {(["config", "context", "metadata"] as const).map((field) => (
          <label key={field} className="grid gap-1 text-xs text-muted-foreground">
            {field[0]!.toUpperCase() + field.slice(1)} (JSON)
            <textarea
              className="h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-xs text-foreground"
              value={draft[field]}
              onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
              spellCheck={false}
            />
          </label>
        ))}
        {error ? (
          <p role="alert" className="text-xs text-status-error">
            {error.message}
          </p>
        ) : null}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Save assistant
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
