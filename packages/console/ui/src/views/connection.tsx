// Which server the console is pointed at, and whether it is answering.
//
// This is the first thing to render and the last thing to lie: a console showing empty tables because
// it cannot reach the server must say so, not look like a server with no threads.

import { Check, Plug, X } from "lucide-react";
import { useState } from "react";

import { fetchServerInfo, resolveApiKey, resolveApiUrl, setApiKey, setApiUrl } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAsync } from "@/use-async";

export function ConnectionBadge() {
  const [editing, setEditing] = useState(false);
  const info = useAsync((signal) => fetchServerInfo(signal), []);

  if (editing) return <ConnectionForm onDone={() => setEditing(false)} />;

  const variant = info.error ? "error" : info.loading ? "running" : "success";
  const label = info.error ? "unreachable" : info.loading ? "connecting" : "connected";

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent"
      title={`${resolveApiUrl()} — click to change`}
    >
      <Badge variant={variant}>{label}</Badge>
      <span className="hidden font-mono text-muted-foreground sm:inline">
        {displayUrl(resolveApiUrl())}
      </span>
      {info.data?.version ? (
        <span className="hidden text-muted-foreground md:inline">v{String(info.data.version)}</span>
      ) : null}
    </button>
  );
}

/** Origin-relative servers read better as a path than as a full URL repeated from the address bar. */
function displayUrl(url: string): string {
  return url.startsWith(window.location.origin)
    ? url.slice(window.location.origin.length) || "/"
    : url;
}

/**
 * Applying either value reloads the page rather than re-rendering: the SDK client, every in-flight
 * request and every view's state are all bound to the old target, and a reload is a shorter, more
 * honest way to rebuild them than threading a "connection changed" signal through the tree.
 */
function ConnectionForm({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState(resolveApiUrl());
  const [key, setKey] = useState(resolveApiKey() ?? "");

  const apply = () => {
    setApiUrl(url === "" ? undefined : url);
    setApiKey(key === "" ? undefined : key);
    // Drop `?baseUrl=` so it cannot override what was just chosen on the next boot.
    window.location.replace(`${window.location.pathname}${window.location.hash}`);
  };

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <Plug className="size-3.5 text-muted-foreground" aria-hidden />
      <Input
        value={url}
        placeholder="http://localhost:2024"
        aria-label="Server URL"
        className="w-56"
        onChange={(event) => setUrl(event.target.value)}
      />
      <Input
        type="password"
        value={key}
        placeholder="API key (optional)"
        aria-label="API key"
        className="w-36"
        onChange={(event) => setKey(event.target.value)}
      />
      <Button type="submit" size="icon" variant="ghost" aria-label="Connect">
        <Check className="size-4" />
      </Button>
      <Button type="button" size="icon" variant="ghost" aria-label="Cancel" onClick={onDone}>
        <X className="size-4" />
      </Button>
    </form>
  );
}
