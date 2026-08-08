// Shared presentation pieces. Deliberately small — the console's job is to show what the server
// returned, so most of these are formatters, not abstractions.

import { AlertCircle, Loader2 } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { routeHref } from "@/router";
import type { AsyncState } from "@/use-async";

export function Panel({
  title,
  count,
  actions,
  children,
  padded = false,
}: {
  title: string;
  count?: number | string;
  actions?: ReactNode;
  children: ReactNode;
  /** Tables sit flush against the panel edge; JSON and prose want padding. */
  padded?: boolean;
}) {
  return (
    <section className="mb-4 overflow-hidden rounded-lg border bg-card">
      <header className="flex h-11 items-center gap-2 border-b px-4">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {count !== undefined ? (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
            {count}
          </span>
        ) : null}
        {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
      </header>
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

/**
 * Render an async slot's three states. The error case prints the server's message rather than a
 * friendly euphemism: whoever opened a console wants the actual failure.
 */
export function Async<T>({
  state,
  empty,
  children,
}: {
  state: AsyncState<T>;
  empty?: string;
  children: (data: T) => ReactNode;
}) {
  if (state.error) {
    return (
      <div className="flex items-start gap-2 p-4 text-[13px] text-status-error">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="font-mono text-xs">{state.error.message}</span>
      </div>
    );
  }
  if (state.loading && state.data === undefined) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Loading
      </div>
    );
  }
  if (state.data === undefined || (Array.isArray(state.data) && state.data.length === 0)) {
    return <Empty>{empty ?? "Nothing here."}</Empty>;
  }
  return <>{children(state.data)}</>;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
      <p className="max-w-sm text-[13px] text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}

/** Which status colour a value deserves — the console's whole colour vocabulary, in one place. */
function statusToken(status: string): string {
  switch (status) {
    case "running":
    case "pending":
    case "busy":
      return "var(--status-running)";
    case "success":
      return "var(--status-success)";
    case "error":
    case "timeout":
      return "var(--status-error)";
    case "interrupted":
      return "var(--status-interrupted)";
    default:
      return "var(--muted-foreground)";
  }
}

/**
 * A 6px dot plus a word, rather than a filled pill.
 *
 * In a table of fifty runs the pill version turns the status column into a wall of colour and you
 * stop reading it. The dot keeps the same at-a-glance signal at a fraction of the weight.
 */
export function StatusBadge({ status }: { status: string | null | undefined }) {
  const value = status ?? "unknown";
  return (
    <span className="inline-flex items-center gap-2 text-[13px] tabular-nums">
      <span className="status-dot" style={{ "--dot-color": statusToken(value) } as CSSProperties} />
      {value}
    </span>
  );
}

/** Absolute time in the tooltip, relative in the body — a console is read at both time scales. */
export function Timestamp({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return <span className="text-muted-foreground">{value}</span>;
  }
  return (
    <span className="text-[13px] text-muted-foreground" title={date.toISOString()}>
      {formatRelative(date)}
    </span>
  );
}

function formatRelative(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return date.toLocaleDateString();
}

/** An id, shortened for the eye, linking to the full resource and keeping the whole value on hover. */
export function IdLink({ id, to }: { id: string; to: string }) {
  return (
    <a
      className="font-mono text-xs text-foreground underline-offset-4 hover:underline"
      href={routeHref(to)}
      title={id}
    >
      {shortId(id)}
    </a>
  );
}

export function ShortId({ id }: { id: string }) {
  return (
    <span className="font-mono text-xs text-muted-foreground" title={id}>
      {shortId(id)}
    </span>
  );
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
