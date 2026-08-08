// The console shell.
//
// Two header rows, the way Vercel's dashboard is laid out: identity and connection on top, section
// tabs with an underline indicator below. It scales better than a single crowded bar — the top row
// answers "which server am I on", the bottom answers "what am I looking at" — and it leaves the
// content area unbroken.

import { Bot, Clock, Database, LayoutDashboard, MessagesSquare, Terminal } from "lucide-react";
import { useEffect } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";
import { routeHref, useRoute } from "@/router";
import { AssistantsView } from "@/views/assistants";
import { ChatView } from "@/views/chat";
import { ConnectionBadge } from "@/views/connection";
import { CronsView } from "@/views/crons";
import { OverviewView } from "@/views/overview";
import { StoreView } from "@/views/store";
import { ThreadsView } from "@/views/threads";

// Playground first, and it is where an empty hash lands: the first question anyone has about a
// server is "does my graph work?", and every other view answers a question you only have later.
const NAV = [
  { path: "playground", label: "Playground", Icon: Terminal },
  { path: "overview", label: "Overview", Icon: LayoutDashboard },
  { path: "assistants", label: "Assistants", Icon: Bot },
  { path: "threads", label: "Threads", Icon: MessagesSquare },
  { path: "store", label: "Store", Icon: Database },
  { path: "crons", label: "Crons", Icon: Clock },
] as const;

export function App() {
  const { segments, query, navigate } = useRoute();
  const section = segments[0] ?? "";

  // Redirect rather than render the playground at two URLs: one canonical path per view keeps the
  // active-tab indicator honest and makes a copied link mean one thing.
  useEffect(() => {
    if (section === "") navigate("playground");
  }, [section, navigate]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-3 px-5">
          <a href={routeHref("")} className="flex items-center gap-2">
            <Mark />
            <span className="text-[15px] font-semibold tracking-tight">skein</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="text-[15px] text-muted-foreground">console</span>
          </a>
          <div className="ml-auto flex items-center gap-1.5">
            <ConnectionBadge />
            <ThemeToggle />
          </div>
        </div>
        <nav className="mx-auto flex max-w-[1280px] gap-0.5 px-3">
          {NAV.map(({ path, label, Icon }) => {
            const active = section === path;
            return (
              <a
                key={path}
                href={routeHref(path)}
                className={cn(
                  "relative flex items-center gap-1.5 px-2.5 pb-2.5 pt-1 text-[13px] transition-colors",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent">
                  <Icon className="size-3.5" aria-hidden />
                  {label}
                </span>
                {/* The underline sits on the header's own border, so the active tab reads as
                    continuous with the page below it rather than as a floating pill. */}
                {active ? (
                  <span className="absolute inset-x-0 -bottom-px h-px bg-foreground" />
                ) : null}
              </a>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-[1280px] px-5 py-6">
        <Body segments={segments} query={query} />
      </main>
    </div>
  );
}

/** A woven-thread mark: three strands crossing. Inline SVG so it costs nothing and themes itself. */
function Mark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden fill="none">
      <path
        d="M2 4c3 0 3 8 6 8s3-8 6-8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M2 12c3 0 3-8 6-8s3 8 6 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}

function Body({ segments, query }: { segments: readonly string[]; query: URLSearchParams }) {
  // `threads/:threadId/runs/:runId` is the deepest route; everything else is one or two segments.
  const [section, id, nested, nestedId] = segments;
  switch (section) {
    // `undefined` only shows for the instant before the redirect above lands.
    case undefined:
    case "playground":
      return <ChatView threadId={id} />;
    case "overview":
      return <OverviewView />;
    case "assistants":
      return <AssistantsView assistantId={id} />;
    case "threads":
      return (
        <ThreadsView
          threadId={id}
          {...(nested === "runs" && nestedId ? { runId: nestedId } : {})}
          {...(query.get("status") ? { status: query.get("status") as string } : {})}
        />
      );
    case "store":
      return <StoreView />;
    case "crons":
      return <CronsView />;
    default:
      return (
        <div className="py-14 text-center text-[13px] text-muted-foreground">
          No such view: <code className="font-mono">{section}</code>.{" "}
          <a className="underline underline-offset-4" href={routeHref("")}>
            Back to the playground
          </a>
        </div>
      );
  }
}

export default App;
