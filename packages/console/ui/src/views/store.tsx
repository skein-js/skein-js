import type { Item } from "@langchain/langgraph-sdk";
import { ChevronRight, FolderTree, Pencil, Search, Trash2 } from "lucide-react";
import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, useConfirmation } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAsync } from "@/use-async";
import { usePagedRows } from "@/use-paged-rows";

import { Async, Json, Pagination, Panel, Timestamp } from "./parts";
import { LifetimeInput, parseLifetime, RetentionSummary, type Retention } from "./retention";

function toPath(namespace: readonly string[]): string {
  return namespace.join("/");
}
function fromPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}
function itemIdentity(namespace: string[], key: string) {
  return JSON.stringify([namespace, key]);
}

export function StoreView() {
  const [client] = useState(() => createConsoleClient({}));
  const confirm = useConfirmation();
  const [prefix, setPrefix] = useState(""),
    [filterText, setFilterText] = useState(""),
    [query, setQuery] = useState("");
  const [applied, setApplied] = useState({ prefix: "", filter: "", query: "" });
  const [editingKey, setEditingKey] = useState<string>();
  const [detail, setDetail] = useState<{ namespace: string[]; key: string }>();
  const [creating, setCreating] = useState(false),
    [normalRead, setNormalRead] = useState(false);
  const [actionError, setActionError] = useState<string>(),
    [busyKey, setBusyKey] = useState<string>();
  const namespaces = usePagedRows(
    (offset, limit, signal) =>
      client.store
        .listNamespaces({
          ...(applied.prefix ? { prefix: fromPath(applied.prefix) } : {}),
          offset,
          limit,
          signal,
        })
        .then((result) => result.namespaces),
    applied.prefix,
    50,
  );
  const items = usePagedRows(
    async (offset, limit, signal) => {
      let filter: Record<string, unknown> | undefined;
      if (applied.filter.trim()) {
        const parsed: unknown = JSON.parse(applied.filter);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          return Promise.reject(new Error("Filter must be a JSON object."));
        filter = parsed as Record<string, unknown>;
      }
      return client.store
        .searchItems(fromPath(applied.prefix), {
          ...(filter ? { filter } : {}),
          ...(applied.query.trim() ? { query: applied.query } : {}),
          ...(normalRead ? {} : { refreshTtl: false }),
          offset,
          limit,
          signal,
        })
        .then((result) => result.items);
    },
    JSON.stringify([applied, normalRead]),
    50,
  );
  const reload = () => {
    items.reload();
    namespaces.reload();
  };
  const remove = async (namespace: string[], key: string) => {
    if (
      !(await confirm({
        title: `Delete ${toPath(namespace)}/${key}?`,
        description: "This memory item cannot be recovered.",
        confirmLabel: "Delete item",
      }))
    )
      return;
    setBusyKey(itemIdentity(namespace, key));
    setActionError(undefined);
    try {
      await createConsoleClient({}).store.deleteItem(namespace, key);
      reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyKey(undefined);
    }
  };
  return (
    <>
      <div className="mb-4 flex flex-wrap justify-between gap-3">
        <form
          className="flex min-w-0 flex-1 flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ prefix, filter: filterText, query });
          }}
        >
          <Input
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            placeholder="Namespace prefix, e.g. memories/user-1"
            aria-label="Namespace prefix"
            className="w-full sm:w-64"
          />
          <Input
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder='Filter JSON, e.g. {"kind":"note"}'
            aria-label="Value filter (JSON)"
            className="w-full sm:w-60"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Semantic query"
            aria-label="Semantic query"
            className="w-full sm:w-48"
          />
          <Button type="submit" variant="outline">
            <Search className="size-4" />
            Search
          </Button>
        </form>
        <Button onClick={() => setCreating(true)}>New item</Button>
      </div>
      <p className="help mb-4">
        A namespace groups memory items.{" "}
        {normalRead
          ? "Normal reads may extend expiry according to your storage adapter."
          : "Inspection requests do not extend item expiry."}
      </p>
      {actionError && (
        <p className="action-error mb-4" role="alert">
          {actionError}
        </p>
      )}
      {items.error?.message.includes("per-operation TTL") && !normalRead && (
        <div className="mb-4 rounded-lg border p-4">
          <p className="text-sm">
            This storage adapter cannot guarantee inspection without refreshing expiry.
          </p>
          <Button className="mt-3" variant="outline" onClick={() => setNormalRead(true)}>
            Load using normal reads
          </Button>
        </div>
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside>
          <Panel title="Namespaces" count={namespaces.rows?.length}>
            <Async
              state={{ ...namespaces, data: namespaces.rows }}
              empty="No namespaces under this prefix."
            >
              {(rows) => (
                <ul className="p-2">
                  {rows.map((namespace) => (
                    <li key={JSON.stringify(namespace)}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-accent"
                        onClick={() => {
                          const path = toPath(namespace);
                          setPrefix(path);
                          setApplied({ ...applied, prefix: path });
                        }}
                      >
                        <FolderTree className="size-4 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 break-all">{toPath(namespace)}</span>
                        <ChevronRight className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Async>
            <Pagination
              {...namespaces}
              count={namespaces.rows?.length ?? 0}
              onPrevious={namespaces.previous}
              onNext={namespaces.next}
            />
          </Panel>
        </aside>
        <Panel
          title="Items"
          count={items.rows?.length}
          actions={
            <Button variant="ghost" size="sm" onClick={reload}>
              Refresh
            </Button>
          }
        >
          <Async
            state={{ ...items, data: items.rows }}
            empty="No memory items match. Create an item or change your search."
          >
            {(rows) => (
              <ul className="divide-y">
                {rows.map((item) => {
                  const identity = itemIdentity(item.namespace, item.key);
                  return (
                    <li key={identity} className="min-w-0 p-4">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            className="break-all text-left text-sm font-medium text-primary hover:underline"
                            onClick={() => setDetail({ namespace: item.namespace, key: item.key })}
                          >
                            {item.key}
                          </button>
                          <p className="help mb-2 break-all">{toPath(item.namespace)}</p>
                          <RetentionSummary retention={item as Item & Retention} />
                          <p className="help mt-2">
                            Updated <Timestamp value={item.updatedAt} />
                          </p>
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Edit ${item.key}`}
                          onClick={() =>
                            setEditingKey(editingKey === identity ? undefined : identity)
                          }
                        >
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busyKey === identity}
                          aria-label={`Delete ${item.key}`}
                          onClick={() => void remove(item.namespace, item.key)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                      {editingKey === identity ? (
                        <StoreItemEditor
                          namespace={item.namespace}
                          itemKey={item.key}
                          value={item.value}
                          ttl={(item as Retention).ttl}
                          onSaved={() => {
                            setEditingKey(undefined);
                            reload();
                          }}
                          onCancel={() => setEditingKey(undefined)}
                        />
                      ) : (
                        <details className="mt-3">
                          <summary className="cursor-pointer text-xs text-muted-foreground">
                            Value preview
                          </summary>
                          <div className="mt-2">
                            <Json value={item.value} />
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Async>
          <Pagination
            {...items}
            count={items.rows?.length ?? 0}
            onPrevious={items.previous}
            onNext={items.next}
          />
        </Panel>
      </div>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Create memory item"
        description="Write JSON at a namespace and key. Saving replaces any existing value at that address."
      >
        <CreateStoreItem
          initialNamespace={applied.prefix}
          onSaved={() => {
            setCreating(false);
            reload();
          }}
        />
      </Dialog>
      <Dialog
        open={detail !== undefined}
        onOpenChange={(open) => {
          if (!open) setDetail(undefined);
        }}
        title={detail ? `Memory item · ${detail.key}` : "Memory item"}
        description={detail ? toPath(detail.namespace) : undefined}
      >
        {detail && (
          <StoreItemDetail
            key={itemIdentity(detail.namespace, detail.key)}
            namespace={detail.namespace}
            itemKey={detail.key}
            normalRead={normalRead}
            onNormalRead={() => setNormalRead(true)}
          />
        )}
      </Dialog>
    </>
  );
}
function StoreItemDetail({
  namespace,
  itemKey,
  normalRead,
  onNormalRead,
}: {
  namespace: string[];
  itemKey: string;
  normalRead: boolean;
  onNormalRead: () => void;
}) {
  const item = useAsync(
    (signal) =>
      createConsoleClient({}).store.getItem(namespace, itemKey, {
        ...(normalRead ? {} : { refreshTtl: false }),
        signal,
      }),
    [JSON.stringify(namespace), itemKey, normalRead],
  );
  if (item.error?.message.includes("per-operation TTL") && !normalRead)
    return (
      <div className="space-y-3">
        <p className="help">
          This adapter cannot inspect an item without its normal TTL refresh behavior. A normal read
          may extend expiry.
        </p>
        <Button variant="outline" onClick={onNormalRead}>
          Load using normal reads
        </Button>
      </div>
    );
  return (
    <Async state={item} empty="Item no longer exists.">
      {(record) =>
        record ? (
          <>
            <RetentionSummary retention={record as Item & Retention} />
            <div className="mt-4">
              <Json value={record.value} />
            </div>
          </>
        ) : (
          <p className="help">Item no longer exists.</p>
        )
      }
    </Async>
  );
}
function CreateStoreItem({
  initialNamespace,
  onSaved,
}: {
  initialNamespace: string;
  onSaved: () => void;
}) {
  const [namespace, setNamespace] = useState(initialNamespace),
    [itemKey, setItemKey] = useState("");
  return (
    <div className="space-y-3">
      <label className="field-label">
        Namespace
        <input
          className="field"
          value={namespace}
          onChange={(event) => setNamespace(event.target.value)}
          placeholder="memories/user-1"
        />
      </label>
      <label className="field-label">
        Key
        <input
          className="field"
          value={itemKey}
          onChange={(event) => setItemKey(event.target.value)}
        />
      </label>
      <StoreItemEditor
        namespace={fromPath(namespace)}
        itemKey={itemKey}
        value={{}}
        onSaved={onSaved}
        onCancel={onSaved}
        creating
      />
    </div>
  );
}
function StoreItemEditor({
  namespace,
  itemKey,
  value,
  ttl,
  onSaved,
  onCancel,
  creating = false,
}: {
  namespace: string[];
  itemKey: string;
  value: Record<string, unknown>;
  ttl?: number | null;
  onSaved: () => void;
  onCancel: () => void;
  creating?: boolean;
}) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2)),
    [lifetime, setLifetime] = useState(
      ttl === undefined ? "default" : ttl === null ? "none" : String(ttl),
    ),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const confirm = useConfirmation();
  return (
    <form
      className="mt-3 grid gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);
        try {
          if (!itemKey.trim()) throw new Error("Enter an item key.");
          const parsed: unknown = JSON.parse(draft);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Item value must be a JSON object.");
          const retention = parseLifetime(lifetime);
          if (
            !(await confirm({
              title: `Save ${toPath(namespace)}/${itemKey}?`,
              description:
                "Saving replaces any existing value and resets its expiry using the selected retention. This is an upsert, including for a new item.",
              confirmLabel: "Save item",
            }))
          )
            return;
          const store = createConsoleClient({}).store;
          if (retention === undefined)
            await store.putItem(namespace, itemKey, parsed as Record<string, unknown>);
          else
            await store.putItem(namespace, itemKey, parsed as Record<string, unknown>, {
              ttl: retention,
            });
          onSaved();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field-label">
        Value (JSON)
        <textarea
          aria-label="Value (JSON)"
          className="field h-40 font-mono text-xs"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
        />
      </label>
      <LifetimeInput value={lifetime} onChange={setLifetime} />
      <p className="help">
        Saving resets this item&apos;s expiry using the selected lifetime. Omitted retention uses
        the deployment default.
      </p>
      {error && (
        <p role="alert" className="action-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : creating ? "Create item" : "Save item"}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
