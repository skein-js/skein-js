// The store browser: what your agents remembered.
//
// Two panes, because the store has two access patterns and conflating them hides one. Namespaces are
// a *tree* you walk (`listNamespaces` with prefix/suffix/maxDepth); items are a *set* you query
// (`searchItems` with a filter, and a natural-language `query` when the store is index-backed). The
// namespace traversal options in particular are easy to have and never notice — surfacing them here
// is half the reason this view exists.

import { ChevronRight, FolderTree, Pencil, Search, Trash2 } from "lucide-react";
import { useState } from "react";

import { createConsoleClient } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePagedRows } from "@/use-paged-rows";

import { Async, Json, Pagination, Panel, Timestamp } from "./parts";

/** `["memories","user-1"]` ⇄ `"memories/user-1"`, so a namespace can live in a text input. */
function toPath(namespace: readonly string[]): string {
  return namespace.join("/");
}

function fromPath(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

export function StoreView() {
  const client = createConsoleClient();
  const [prefix, setPrefix] = useState("");
  const [filterText, setFilterText] = useState("");
  const [query, setQuery] = useState("");
  const [editingKey, setEditingKey] = useState<string>();
  // Applied on submit rather than per keystroke: each change is a request, and a store search on a
  // large namespace is not free.
  const [applied, setApplied] = useState({ prefix: "", filter: "", query: "" });

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
    (offset, limit, signal) => {
      let filter: Record<string, unknown> | undefined;
      if (applied.filter.trim() !== "") {
        try {
          filter = JSON.parse(applied.filter) as Record<string, unknown>;
        } catch {
          return Promise.reject(
            new Error(`Filter is not valid JSON: ${applied.filter}. Try {"kind":"note"}.`),
          );
        }
      }
      return client.store
        .searchItems(fromPath(applied.prefix), {
          ...(filter ? { filter } : {}),
          ...(applied.query.trim() !== "" ? { query: applied.query } : {}),
          offset,
          limit,
          signal,
        })
        .then((result) => result.items);
    },
    JSON.stringify(applied),
    50,
  );

  const apply = () => setApplied({ prefix, filter: filterText, query });

  const [actionError, setActionError] = useState<Error | undefined>();

  const deleteItem = async (namespace: string[], key: string) => {
    if (
      !window.confirm(`Delete ${toPath(namespace)}/${key}? This memory item cannot be recovered.`)
    )
      return;
    setActionError(undefined);
    try {
      await client.store.deleteItem(namespace, key);
      items.reload();
      namespaces.reload();
    } catch (error) {
      // A delete that fails silently is worse than one that errors: the row stays put and the
      // operator concludes the console is broken, or worse, that the item is gone when it is not.
      setActionError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  return (
    <>
      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <FolderTree className="size-4 text-muted-foreground" aria-hidden />
        <Input
          value={prefix}
          onChange={(event) => setPrefix(event.target.value)}
          placeholder="namespace prefix, e.g. memories/user-1"
          aria-label="Namespace prefix"
          className="w-72 font-mono"
        />
        <Input
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder='filter JSON, e.g. {"kind":"note"}'
          aria-label="Value filter (JSON)"
          className="w-64 font-mono"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="semantic query (needs store.index)"
          aria-label="Semantic query"
          className="w-64"
        />
        <Button type="submit" size="sm" variant="outline">
          <Search className="size-3.5" />
          Search
        </Button>
      </form>

      {actionError ? (
        <div className="mb-4 rounded-md border border-status-error/40 bg-status-error/5 p-3 font-mono text-xs text-status-error">
          {actionError.message}
        </div>
      ) : null}

      <Panel title="Namespaces" count={namespaces.rows?.length}>
        <Async
          state={{ ...namespaces, data: namespaces.rows }}
          empty="No namespaces under this prefix."
        >
          {(rows) =>
            rows.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No namespaces under this prefix.
              </div>
            ) : (
              <ul className="divide-y">
                {rows.map((namespace) => (
                  <li key={toPath(namespace)}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs hover:bg-muted/50"
                      onClick={() => {
                        setPrefix(toPath(namespace));
                        setApplied((previous) => ({ ...previous, prefix: toPath(namespace) }));
                      }}
                    >
                      <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
                      {toPath(namespace)}
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
        <Pagination
          {...namespaces}
          count={namespaces.rows?.length ?? 0}
          onPrevious={namespaces.previous}
          onNext={namespaces.next}
        />
      </Panel>

      <Panel title="Items" count={items.rows?.length}>
        <Async state={{ ...items, data: items.rows }} empty="No items match.">
          {(rows) =>
            rows.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No items match.</div>
            ) : (
              <ul className="divide-y">
                {rows.map((item) => (
                  <li key={`${toPath(item.namespace)}/${item.key}`} className="p-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="font-mono text-xs">
                        <span className="text-muted-foreground">{toPath(item.namespace)}/</span>
                        {item.key}
                      </span>
                      {"score" in item && typeof item.score === "number" ? (
                        <span className="text-xs text-muted-foreground">
                          score {item.score.toFixed(3)}
                        </span>
                      ) : null}
                      <span className="ml-auto flex items-center gap-2">
                        {/* The wire sends `updated_at`; the SDK adds a camelCase alias alongside it
                            and only types that one. Use the typed name. */}
                        <Timestamp value={item.updatedAt} />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Edit ${item.key}`}
                          onClick={() =>
                            setEditingKey((current) =>
                              current === `${toPath(item.namespace)}/${item.key}`
                                ? undefined
                                : `${toPath(item.namespace)}/${item.key}`,
                            )
                          }
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${item.key}`}
                          onClick={() => void deleteItem(item.namespace, item.key)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </span>
                    </div>
                    <Json value={item.value} />
                    {editingKey === `${toPath(item.namespace)}/${item.key}` ? (
                      <StoreItemEditor
                        namespace={item.namespace}
                        itemKey={item.key}
                        value={item.value}
                        onSaved={() => {
                          setEditingKey(undefined);
                          items.reload();
                        }}
                        onCancel={() => setEditingKey(undefined)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
        <Pagination
          {...items}
          count={items.rows?.length ?? 0}
          onPrevious={items.previous}
          onNext={items.next}
        />
      </Panel>
    </>
  );
}

function StoreItemEditor({
  namespace,
  itemKey,
  value,
  onSaved,
  onCancel,
}: {
  namespace: string[];
  itemKey: string;
  value: Record<string, unknown>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(JSON.stringify(value, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("Item value must be a JSON object.");
      if (
        !window.confirm(
          `Save ${toPath(namespace)}/${itemKey}? This rewrites the item and resets its expiry to the server's default.`,
        )
      )
        return;
      await createConsoleClient().store.putItem(
        namespace,
        itemKey,
        parsed as Record<string, unknown>,
      );
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-3 grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label
        className="text-xs text-muted-foreground"
        htmlFor={`edit-${toPath(namespace)}-${itemKey}`}
      >
        Value (JSON)
      </label>
      <textarea
        id={`edit-${toPath(namespace)}-${itemKey}`}
        className="h-40 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">
        Saving resets this item&apos;s expiry to the server default.
      </p>
      {error ? (
        <p role="alert" className="text-xs text-status-error">
          {error.message}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          Save item
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
