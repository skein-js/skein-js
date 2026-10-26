import {
  Bot,
  Clock,
  Database,
  LayoutDashboard,
  Menu,
  MessagesSquare,
  Radio,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";

import knot from "@/assets/skein-knot.svg?url";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ConfirmationProvider, Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { routeHref, useRoute } from "@/router";
import { AssistantsView } from "@/views/assistants";
import { ChannelsView } from "@/views/channels";
import { ChatView } from "@/views/chat";
import { ConnectionBadge } from "@/views/connection";
import { CronsView } from "@/views/crons";
import { OverviewView } from "@/views/overview";
import { StoreView } from "@/views/store";
import { ThreadsView } from "@/views/threads";

const NAV = [
  {
    group: "Build",
    path: "playground",
    label: "Playground",
    Icon: Terminal,
    description: "Run an Assistant and follow what happens, one step at a time.",
  },
  {
    group: "Build",
    path: "assistants",
    label: "Assistants",
    Icon: Bot,
    description: "Configure your graphs, inspect their inputs, and manage saved versions.",
  },
  {
    group: "Inspect",
    path: "threads",
    label: "Threads",
    Icon: MessagesSquare,
    description: "A thread keeps state and history across runs. Find one to inspect or continue.",
  },
  {
    group: "Operate",
    path: "overview",
    label: "Overview",
    Icon: LayoutDashboard,
    description: "See what needs your attention and review recent activity on this server.",
  },
  {
    group: "Operate",
    path: "channels",
    label: "Channels",
    Icon: Radio,
    description: "Inspect the source and destination wiring configured by your application.",
  },
  {
    group: "Operate",
    path: "store",
    label: "Store",
    Icon: Database,
    description: "Browse and manage the long-term memory your graphs share across threads.",
  },
  {
    group: "Operate",
    path: "crons",
    label: "Schedules",
    Icon: Clock,
    description: "Run an Assistant on a recurring schedule, with a fresh or existing thread.",
  },
] as const;

export function App() {
  return (
    <ConfirmationProvider>
      <ConsoleShell />
    </ConfirmationProvider>
  );
}

function ConsoleShell() {
  const { segments, query, navigate } = useRoute();
  const [mobileNavigation, setMobileNavigation] = useState(false);
  const section = segments[0] ?? "";
  const current = NAV.find((entry) => entry.path === section);
  useEffect(() => {
    if (section === "") navigate("playground");
  }, [section, navigate]);
  const navigation = (
    <nav aria-label="Console navigation" className="space-y-7">
      {["Build", "Inspect", "Operate"].map((group) => (
        <div key={group}>
          <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {group}
          </p>
          <div className="space-y-1">
            {NAV.filter((entry) => entry.group === group).map(({ path, label, Icon }) => (
              <a
                key={path}
                href={routeHref(path)}
                aria-current={section === path ? "page" : undefined}
                onClick={() => setMobileNavigation(false)}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  section === path
                    ? "bg-accent font-semibold text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                {label}
              </a>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#console-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("console-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-card focus:p-3"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[232px] flex-col border-r bg-card px-4 py-6 md:flex">
        <a href={routeHref("playground")} className="mb-10 flex items-center gap-2.5 px-3">
          <img src={knot} className="size-7" alt="" />
          <span className="text-xl font-semibold tracking-tight">
            skein<span className="ml-2 text-xs font-normal text-muted-foreground">console</span>
          </span>
        </a>
        {navigation}
        <div className="mt-auto rounded-xl border bg-muted/50 p-3">
          <Sparkles className="mb-2 size-4 text-primary" aria-hidden />
          <p className="text-xs font-medium">Your graphs. Your infrastructure.</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Test, understand, and operate your agents in one place.
          </p>
        </div>
      </aside>
      <Dialog
        open={mobileNavigation}
        onOpenChange={setMobileNavigation}
        title="skein console"
        description="Navigate your agent workspace."
        side
      >
        {navigation}
      </Dialog>
      <div className="min-w-0 md:ml-[232px]">
        <header className="sticky top-0 z-30 flex min-h-16 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur-md sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileNavigation(true)}
          >
            <Menu className="size-5" />
          </Button>
          <span className="text-xs text-muted-foreground">Workspace</span>
          <span className="text-border">/</span>
          <span className="text-sm font-medium">{current?.label ?? "Console"}</span>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <ConnectionBadge />
            <ThemeToggle />
          </div>
        </header>
        <main
          id="console-content"
          tabIndex={-1}
          className="mx-auto w-full min-w-0 max-w-[1800px] p-4 outline-none sm:p-6"
        >
          <div className="mb-6">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-primary">
              {current?.group ?? "Workspace"}
            </div>
            <h1 className="text-2xl font-semibold">{current?.label ?? "Console"}</h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              {current?.description}
            </p>
          </div>
          <Body segments={segments} query={query} />
        </main>
      </div>
    </div>
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
    case "channels":
      return <ChannelsView />;
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
