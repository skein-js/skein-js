import type { Thread } from "@langchain/langgraph-sdk";
import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";

import { Panel, Timestamp } from "./parts";

export interface Retention {
  ttl?: number | null;
  expires_at?: string | null;
  expiresAt?: string | null;
  ttl_strategy?: "delete" | "keep_latest";
}
export function RetentionSummary({
  retention,
  thread = false,
}: {
  retention: Retention;
  thread?: boolean;
}) {
  const expires = retention.expires_at ?? retention.expiresAt;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      <span>
        Lifetime:{" "}
        {retention.ttl === undefined
          ? "unavailable"
          : retention.ttl === null
            ? "no expiry"
            : `${retention.ttl} minutes`}
      </span>
      <span>
        {thread ? "Eligible for cleanup" : "Expires"}:{" "}
        {expires ? (
          <Timestamp value={expires} />
        ) : retention.expires_at === null || retention.expiresAt === null ? (
          "never"
        ) : (
          "unavailable"
        )}
      </span>
      {retention.ttl_strategy && (
        <span>
          Cleanup:{" "}
          {retention.ttl_strategy === "keep_latest" ? "keep latest checkpoint" : "delete thread"}
        </span>
      )}
    </div>
  );
}
export function parseLifetime(value: string): number | null | undefined {
  if (value === "default" || value === "unchanged") return undefined;
  if (value === "none") return null;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 5256000)
    throw new Error("Lifetime must be positive minutes, up to 5256000.");
  return minutes;
}
export function LifetimeInput({
  value,
  onChange,
  thread = false,
}: {
  value: string;
  onChange: (value: string) => void;
  thread?: boolean;
}) {
  const custom = value !== "default" && value !== "unchanged" && value !== "none";
  return (
    <label className="field-label">
      Retention
      <select
        aria-label="Retention"
        className="field"
        value={custom ? "custom" : value}
        onChange={(event) => onChange(event.target.value === "custom" ? "60" : event.target.value)}
      >
        <option value={thread ? "unchanged" : "default"}>
          {thread ? "Leave current retention unchanged" : "Use deployment default"}
        </option>
        <option value="none">No expiry</option>
        <option value="custom">Custom lifetime (minutes)</option>
      </select>
      {custom && (
        <input
          className="field"
          type="number"
          min="0.001"
          step="any"
          max="5256000"
          aria-label="Lifetime (minutes)"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
export function ThreadRetentionEditor({
  thread,
  onSaved,
}: {
  thread: Thread & Retention;
  onSaved: () => void;
}) {
  const [lifetime, setLifetime] = useState("unchanged"),
    [strategy, setStrategy] = useState<"delete" | "keep_latest">(thread.ttl_strategy ?? "delete"),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>(),
    [saved, setSaved] = useState(false);
  return (
    <Panel title="Thread retention" padded>
      <RetentionSummary retention={thread} thread />
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          setSaved(false);
          try {
            const ttl = parseLifetime(lifetime);
            if (ttl === undefined)
              throw new Error("Choose a lifetime or no expiry before saving retention.");
            // The installed SDK forwards these values correctly; its declaration only names delete.
            const resource = createConsoleClient({}).threads;
            const update = resource.update.bind(resource) as (
              id: string,
              input: { ttl: number | null | { ttl: number; strategy: "delete" | "keep_latest" } },
            ) => Promise<Thread>;
            await update(thread.thread_id, { ttl: ttl === null ? null : { ttl, strategy } });
            setSaved(true);
            onSaved();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        <LifetimeInput value={lifetime} onChange={setLifetime} thread />
        <label className="field-label">
          When the lifetime expires
          <select
            className="field"
            value={strategy}
            onChange={(event) => setStrategy(event.target.value as typeof strategy)}
          >
            <option value="delete">Delete thread, runs, and checkpoints</option>
            <option value="keep_latest">Keep thread and latest checkpoint</option>
          </select>
        </label>
        <p className="help sm:col-span-2">
          Saving a lifetime starts its expiry clock again. Expiry makes a thread eligible for
          background cleanup; active work may delay collection.
        </p>
        {error && (
          <p role="alert" className="action-error sm:col-span-2">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="action-success sm:col-span-2">
            Retention saved.
          </p>
        )}
        <div>
          <Button disabled={busy} type="submit">
            Save retention
          </Button>
        </div>
      </form>
    </Panel>
  );
}
