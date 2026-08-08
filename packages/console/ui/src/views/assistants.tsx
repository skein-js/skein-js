// Assistants: what this server can actually run. The detail view is the introspection surface —
// graph shape, input/output schemas, and the immutable version history.

import { ArrowLeft } from "lucide-react";

import { createConsoleClient } from "@/api";
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

import { Async, IdLink, Json, Panel, Timestamp } from "./parts";

export function AssistantsView({ assistantId }: { assistantId?: string }) {
  return assistantId ? <AssistantDetail assistantId={assistantId} /> : <AssistantList />;
}

function AssistantList() {
  const client = createConsoleClient();
  const assistants = useAsync((signal) => client.assistants.search({ limit: 100, signal }), []);

  return (
    <Panel title="Assistants" count={assistants.data?.length}>
      <Async state={assistants} empty="No assistants. Declare a graph in langgraph.json.">
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
  const versions = useAsync(
    (signal) => client.assistants.getVersions(assistantId, { signal }),
    [assistantId],
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

      <Panel title="Graph" padded>
        <Async state={graph}>{(data) => <Json value={data} />}</Async>
      </Panel>

      <Panel title="Schemas" padded>
        <Async state={schemas}>{(data) => <Json value={data} />}</Async>
      </Panel>

      <Panel title="Versions" count={versions.data?.length}>
        <Async state={versions} empty="No version history.">
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
