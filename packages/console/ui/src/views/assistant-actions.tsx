import type { Assistant, AssistantVersion } from "@langchain/langgraph-sdk";
import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, useConfirmation } from "@/components/ui/dialog";
import { routeHref } from "@/router";

import { Json } from "./parts";

export function CreateAssistant({ graphIds }: { graphIds: string[] }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    graphId: "",
    name: "",
    description: "",
    config: "{}",
    context: "null",
    metadata: "{}",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const config: unknown = JSON.parse(draft.config),
        metadata: unknown = JSON.parse(draft.metadata);
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      )
        throw new Error("Config and metadata must be JSON objects.");
      const created = await createConsoleClient({}).assistants.create({
        graphId: draft.graphId,
        name: draft.name,
        description: draft.description,
        config: config as Record<string, unknown>,
        metadata: metadata as Record<string, unknown>,
        context: JSON.parse(draft.context),
      });
      setOpen(false);
      window.location.hash = routeHref(`assistants/${created.assistant_id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>New Assistant</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Create Assistant"
        description="Create a named configuration of a graph already registered on this server."
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="field-label">
            Graph ID
            <input
              aria-label="Graph ID"
              className="field"
              list="registered-graphs"
              required
              value={draft.graphId}
              onChange={(event) => setDraft({ ...draft, graphId: event.target.value })}
            />
            <datalist id="registered-graphs">
              {[...new Set(graphIds)].map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </label>
          <label className="field-label">
            Name
            <input
              aria-label="Name"
              className="field"
              required
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="field-label">
            Description
            <input
              aria-label="Description"
              className="field"
              value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <details>
            <summary className="cursor-pointer text-sm">
              Configuration, context, and metadata
            </summary>
            <div className="mt-3 space-y-3">
              {(["config", "context", "metadata"] as const).map((field) => (
                <label key={field} className="field-label">
                  {field} (JSON)
                  <textarea
                    className="field h-24 font-mono text-xs"
                    value={draft[field]}
                    onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                  />
                </label>
              ))}
            </div>
          </details>
          {error && (
            <p role="alert" className="action-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? "Creating…" : "Create Assistant"}
          </Button>
        </form>
      </Dialog>
    </>
  );
}

export function DeleteAssistant({ assistant }: { assistant: Assistant }) {
  const confirm = useConfirmation();
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="font-medium">Delete Assistant</p>
      <p className="help">
        Threads are kept by default. Graph-registered Assistants are recreated on the next server
        startup; graph code stays registered.
      </p>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={cascade}
          onChange={(event) => setCascade(event.target.checked)}
        />
        Also delete authorized threads whose latest Assistant metadata matches this Assistant.
      </label>
      <Button
        variant="outline"
        disabled={busy}
        onClick={async () => {
          if (
            !(await confirm({
              title: "Delete this Assistant?",
              description: cascade
                ? "The Assistant, its versions, and matching authorized threads will be permanently deleted."
                : "The Assistant and its saved versions will be deleted. Threads will be kept.",
              confirmLabel: "Delete Assistant",
            }))
          )
            return;
          setBusy(true);
          setError(undefined);
          try {
            await createConsoleClient({}).assistants.delete(assistant.assistant_id, {
              deleteThreads: cascade,
            });
            window.location.hash = routeHref("assistants");
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        Delete Assistant
      </Button>
      {error && (
        <p role="alert" className="action-error">
          {error}
        </p>
      )}
    </div>
  );
}

export function RestoreAssistantVersion({
  version,
  current,
  onSaved,
}: {
  version: AssistantVersion;
  current: number;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirm = useConfirmation();
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Preview version {version.version}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={`Assistant version ${version.version}`}
        description="Restoring makes this saved configuration current. Other versions remain available."
      >
        <Json value={version} />
        {error && (
          <p role="alert" className="action-error mt-3">
            {error}
          </p>
        )}
        <Button
          className="mt-4"
          disabled={busy || version.version === current}
          onClick={async () => {
            if (
              !(await confirm({
                title: `Restore version ${version.version}?`,
                description: "Future runs will use this saved Assistant configuration.",
                confirmLabel: "Restore version",
              }))
            )
              return;
            setBusy(true);
            try {
              await createConsoleClient({}).assistants.setLatest(
                version.assistant_id,
                version.version,
              );
              onSaved();
              setOpen(false);
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            } finally {
              setBusy(false);
            }
          }}
        >
          {version.version === current ? "Current version" : "Restore this version"}
        </Button>
      </Dialog>
    </>
  );
}
