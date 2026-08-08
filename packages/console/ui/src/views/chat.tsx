// The playground: actually run a graph and watch it answer.
//
// Every other view in the console observes. This one *drives*, and it is the view people open first —
// "does my graph work?" is the question you have before any of the others.
//
// Two input modes, because graphs are not all chatbots. A graph with a `messages` channel gets a chat
// transcript; anything else gets a JSON editor seeded from its own input schema. The console picks
// the default by asking the server for the schema rather than guessing from the graph's name, and
// then says which it picked and why — a mode that changes under you with nothing on screen explaining
// it is worse than the wrong mode.

import type { Message } from "@langchain/langgraph-sdk";
import { CornerDownLeft, Loader2, Plus, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { createConsoleClient } from "@/api";
import { GraphDiagram } from "@/components/graph-diagram";
import { Button } from "@/components/ui/button";
import type { GraphEdge, GraphNode } from "@/graph-layout";
import { acceptsMessages, inputSchemaOf, sampleInputFor } from "@/graph-schema";
import { cn } from "@/lib/utils";
import { routeHref } from "@/router";
import { useAsync } from "@/use-async";

import { describeAssistant } from "./assistants";
import { InterruptPanel, pendingInterrupts } from "./interrupts";
import { Async, Json, Panel } from "./parts";

type InputMode = "chat" | "json";

export function ChatView({ threadId }: { threadId?: string }) {
  const client = createConsoleClient();
  const assistants = useAsync((signal) => client.assistants.search({ limit: 100, signal }), []);
  const [assistantId, setAssistantId] = useState<string | undefined>();
  const selected = assistantId ?? assistants.data?.[0]?.assistant_id;

  return (
    <div className="grid gap-4 lg:grid-cols-[200px_1fr]">
      <aside>
        <Panel title="Graph">
          <Async state={assistants} empty="No graphs registered.">
            {(rows) => (
              <ul className="p-1">
                {rows.map((assistant) => (
                  <li key={assistant.assistant_id}>
                    <button
                      type="button"
                      onClick={() => setAssistantId(assistant.assistant_id)}
                      title={describeAssistant(assistant)}
                      className={cn(
                        "w-full rounded-md px-2.5 py-1.5 text-left transition-colors",
                        assistant.assistant_id === selected
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <span className="block truncate font-mono text-xs">{assistant.graph_id}</span>
                      {describeAssistant(assistant) ? (
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {describeAssistant(assistant)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </Panel>
      </aside>

      {selected ? (
        // Keyed by graph so switching one remounts the session: the previous graph's mode, drafts and
        // transcript must not survive the switch.
        <Session key={selected} assistantId={selected} threadId={threadId} />
      ) : (
        <Panel title="Playground" padded>
          <p className="text-[13px] text-muted-foreground">Pick a graph to start.</p>
        </Panel>
      )}
    </div>
  );
}

function Session({ assistantId, threadId }: { assistantId: string; threadId?: string }) {
  const client = createConsoleClient();
  const [mode, setMode] = useState<InputMode | undefined>();
  /**
   * One draft per mode.
   *
   * A single shared draft meant the JSON template seeded for a non-chat graph was still sitting in the
   * box after switching to Chat — so the first thing you sent a chatbot was a state object.
   */
  const [drafts, setDrafts] = useState<Record<InputMode, string>>({ chat: "", json: "" });
  const [messages, setMessages] = useState<Message[]>([]);
  const [values, setValues] = useState<unknown>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [activeNode, setActiveNode] = useState<string | undefined>();
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  const abort = useRef<AbortController | undefined>(undefined);
  const bottom = useRef<HTMLDivElement>(null);
  /**
   * The thread this session talks to, in a ref rather than read from the route: the route updates a
   * render later, and a quickly-typed second message would otherwise create a second thread and split
   * the conversation in half.
   */
  const activeThread = useRef<string | undefined>(threadId);
  /** When the last run finished. Thread state fetched before this is stale and must not be applied. */
  const ranUntil = useRef(0);

  const schemas = useAsync(
    (signal) => client.assistants.getSchemas(assistantId, { signal }),
    [assistantId],
  );
  const graph = useAsync(
    (signal) => client.assistants.getGraph(assistantId, { signal }),
    [assistantId],
  );

  const inputKeys = useMemo(() => {
    const properties = inputSchemaOf(schemas.data)?.properties;
    return properties ? Object.keys(properties) : [];
  }, [schemas.data]);

  /**
   * Whether this graph can be chatted with at all.
   *
   * Distinct from "which mode are we in": the mode is a *choice*, this is a *fact* about the graph.
   * Letting someone pick Chat for a graph with no `messages` channel guarantees a confusing failure
   * deep inside a node, so the option is disabled rather than left as a trap.
   */
  const chatSupported = useMemo(
    () => (schemas.data === undefined ? true : acceptsMessages(schemas.data)),
    [schemas.data],
  );

  // If the schema arrives after someone already picked Chat, take it back — with the reason visible
  // in the row below, not silently.
  useEffect(() => {
    if (!chatSupported && mode === "chat") setMode("json");
  }, [chatSupported, mode]);

  useEffect(() => {
    if (mode !== undefined || schemas.data === undefined) return;
    const chat = acceptsMessages(schemas.data);
    setMode(chat ? "chat" : "json");
    // Seed the JSON draft only — the chat box is for prose and must open empty.
    if (!chat) {
      setDrafts((current) =>
        current.json === "" ? { ...current, json: sampleInputFor(schemas.data) } : current,
      );
    }
  }, [schemas.data, mode]);

  const thread = useAsync(
    async (signal) =>
      threadId ? await client.threads.getState(threadId, undefined, { signal }) : undefined,
    [threadId],
  );

  useEffect(() => {
    // Never while a run is in flight: this load is triggered by the thread id landing in the route,
    // which happens *during* the first run, and it returns the state from before that run.
    if (!thread.data || running) return;
    // And never a snapshot that predates the run that just finished. `running` flipping to false
    // re-fires this effect while `thread.data` is still the *pre-run* fetch, which would overwrite
    // the streamed transcript with the state it had before — visibly, and permanently if the
    // follow-up reload then failed. The stamp identifies which fetch this data came from.
    if (thread.fetchedAt !== undefined && thread.fetchedAt < ranUntil.current) return;
    const stateValues = thread.data.values as { messages?: Message[] } | undefined;
    // Only when the state actually carries messages — `?? []` would clear the transcript for any
    // graph without a `messages` channel, which is how a sent message vanished a moment later.
    if (Array.isArray(stateValues?.messages)) setMessages(stateValues.messages);
    setValues(thread.data.values);
  }, [thread.data, thread.fetchedAt, running]);

  useEffect(() => {
    if (threadId !== undefined) activeThread.current = threadId;
  }, [threadId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, running]);

  const draft = mode ? drafts[mode] : "";
  const setDraft = useCallback(
    (value: string) => setDrafts((current) => (mode ? { ...current, [mode]: value } : current)),
    [mode],
  );

  const send = useCallback(async () => {
    if (draft.trim() === "" || running || mode === undefined) return;
    setError(undefined);
    setRunning(true);
    setVisited(new Set());
    setActiveNode(undefined);
    const controller = new AbortController();
    abort.current = controller;

    try {
      let input: Record<string, unknown>;
      if (mode === "chat") {
        setMessages((previous) => [...previous, { type: "human", content: draft } as Message]);
        input = { messages: [{ role: "human", content: draft }] };
      } else {
        input = JSON.parse(draft) as Record<string, unknown>;
      }
      setDraft("");

      // The thread is created on first send rather than on mount, so opening the playground and
      // walking away does not litter the thread list with empties.
      let target = activeThread.current;
      if (target === undefined) {
        const created = await client.threads.create({ metadata: { source: "console-playground" } });
        target = created.thread_id;
        // Ref first, URL second: the ref is what the next send reads.
        activeThread.current = target;
        window.location.hash = routeHref(`playground/${target}`);
      }

      for await (const chunk of client.runs.stream(target, assistantId, {
        input,
        // `updates` names the node each step came from — the only frame that says *where* the run is.
        streamMode: ["values", "messages", "updates"],
        // Stop has to stop the *run*, not just this reader. The engine's default on disconnect is
        // `continue`, so aborting the signal alone left the graph executing (and calling models)
        // behind a UI that had gone back to idle.
        onDisconnect: "cancel",
        signal: controller.signal,
        // No cast: `onDisconnect` is a typed field the SDK forwards as `on_disconnect`. Casting here
        // would have turned a checked field into a silently-dropped one — the exact failure mode that
        // made the sweep's `Idempotency-Key` vanish.
      })) {
        if (chunk.event === "values") {
          const next = chunk.data as { messages?: Message[] } | undefined;
          setValues(chunk.data);
          if (next?.messages) setMessages(next.messages);
          continue;
        }
        if (chunk.event === "updates") {
          // `{ [nodeName]: partialState }`. This names the node that just produced output, so the
          // highlight trails execution by a step rather than predicting it.
          for (const node of Object.keys((chunk.data ?? {}) as Record<string, unknown>)) {
            setActiveNode(node);
            setVisited((previous) => new Set(previous).add(node));
          }
          continue;
        }
        // A run that throws does not reject this loop — it reports itself as a frame and the stream
        // ends normally. Ignoring these is why a failed run looked like nothing happening at all.
        if (chunk.event === "error") {
          setError(new Error(describeRunFailure(chunk.data)));
          continue;
        }
        // `end` carries the terminal status. The SDK's event union does not name it (skein
        // synthesizes the frame), so it is read through a widened type rather than left unhandled.
        const frame = chunk as { event: string; data?: { status?: string } };
        if (frame.event === "end") {
          const status = frame.data?.status;
          if (status !== undefined && status !== "success" && status !== "interrupted") {
            setError(new Error(`Run ended with status "${status}".`));
          }
        }
      }
      thread.reload();
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      }
    } finally {
      ranUntil.current = Date.now();
      setRunning(false);
      setActiveNode(undefined);
      abort.current = undefined;
    }
  }, [assistantId, client, draft, mode, running, setDraft, thread]);

  const interrupts = pendingInterrupts(thread.data);
  const structure = graph.data as { nodes?: GraphNode[]; edges?: GraphEdge[] } | undefined;

  return (
    <div className="flex flex-col">
      {/* One row that says what mode you are in, why, and what the run is doing. This used to be a
          bare two-button toggle with nothing on screen explaining either choice. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex rounded-md border p-0.5">
          {(["chat", "json"] as const).map((value) => {
            const disabled = value === "chat" && !chatSupported;
            return (
              <button
                key={value}
                type="button"
                disabled={disabled}
                title={
                  disabled
                    ? "This graph has no `messages` channel, so it cannot be chatted with."
                    : undefined
                }
                onClick={() => setMode(value)}
                className={cn(
                  "rounded px-2 py-1 text-xs transition-colors",
                  mode === value
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
                )}
              >
                {value === "chat" ? "Chat" : "JSON"}
              </button>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground">
          {mode === "chat" ? (
            <>
              takes <code className="font-mono text-foreground">messages</code> — talk to it
            </>
          ) : inputKeys.length > 0 ? (
            <>
              input:{" "}
              {inputKeys.map((key, index) => (
                <span key={key}>
                  {index > 0 ? ", " : ""}
                  <code className="font-mono text-foreground">{key}</code>
                </span>
              ))}
            </>
          ) : null}
        </p>

        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <span className="flex items-center gap-1.5 text-xs text-status-running">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {activeNode ?? "starting"}
            </span>
          ) : null}
          {threadId ? (
            <a
              href={routeHref(`threads/${threadId}`)}
              className="font-mono text-xs text-muted-foreground underline-offset-4 hover:underline"
              title={threadId}
            >
              {threadId.slice(0, 8)}…
            </a>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Clear the ref too, or the next send silently continues the old conversation.
              activeThread.current = undefined;
              window.location.hash = routeHref("playground");
              setMessages([]);
              setValues(undefined);
              setVisited(new Set());
              setError(undefined);
            }}
          >
            <Plus className="size-3.5" />
            New thread
          </Button>
        </div>
      </div>

      <div className="flex gap-4">
        {structure?.nodes?.length ? (
          // Hugs its content rather than stretching: a five-node graph inside a full-height panel was
          // mostly empty space, which reads as "something failed to load".
          <div className="hidden w-48 shrink-0 self-start rounded-lg border bg-card p-3 xl:block">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Graph
            </div>
            <GraphDiagram
              nodes={structure.nodes}
              edges={structure.edges ?? []}
              activeNode={running ? activeNode : undefined}
              visited={visited}
            />
          </div>
        ) : null}

        <div className="flex min-h-[20rem] flex-1 flex-col overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-1 flex-col overflow-y-auto p-4">
            {mode === "chat" ? (
              messages.length === 0 && !running ? (
                <Hint>Send a message below and the graph&apos;s reply appears here.</Hint>
              ) : (
                <ol className="space-y-3">
                  {messages.map((message, index) => (
                    <Bubble key={messageKey(message, index)} message={message} />
                  ))}
                </ol>
              )
            ) : values === undefined && !running ? (
              <Hint>
                The editor below is pre-filled with this graph&apos;s input shape. Fill in the
                values and send — the resulting state shows up here.
              </Hint>
            ) : (
              <Json value={values} />
            )}
            <div ref={bottom} />
          </div>
        </div>
      </div>

      {interrupts.length > 0 && threadId ? (
        <div className="mt-4">
          <InterruptPanel
            threadId={threadId}
            assistantId={assistantId}
            interrupts={interrupts}
            onResumed={() => thread.reload()}
          />
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-md border border-status-error/40 bg-status-error/5 p-3 font-mono text-xs text-status-error">
          {error.message}
        </div>
      ) : null}

      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends in chat. Not in JSON, where newlines are the point and sending on Enter
            // would fire a half-typed object on every line break.
            if (event.key === "Enter" && !event.shiftKey && mode === "chat") {
              event.preventDefault();
              void send();
            }
          }}
          rows={mode === "json" ? 8 : 2}
          spellCheck={mode !== "json"}
          placeholder={mode === "json" ? '{ "…": … }' : "Message the graph…"}
          className={cn(
            "flex-1 resize-y rounded-lg border bg-card px-3 py-2 text-[13px] outline-none",
            "placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring",
            mode === "json" && "font-mono text-xs",
          )}
        />
        {running ? (
          <Button type="button" variant="outline" onClick={() => abort.current?.abort()}>
            <Square className="size-3.5" />
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={draft.trim() === ""}>
            <CornerDownLeft className="size-3.5" />
            Send
          </Button>
        )}
      </form>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center">
      <p className="max-w-xs text-[13px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * Turn an error frame into one readable line. The engine sends `{ error, message, stack? }` (see
 * docs/errors-and-logging.md); other shapes fall back to the raw JSON rather than to a useless
 * "something went wrong".
 */
function describeRunFailure(data: unknown): string {
  if (typeof data === "string") return data;
  if (typeof data === "object" && data !== null) {
    const frame = data as { error?: unknown; message?: unknown };
    const name = typeof frame.error === "string" ? frame.error : undefined;
    const message = typeof frame.message === "string" ? frame.message : undefined;
    if (name && message) return `${name}: ${message}`;
    if (message) return message;
    if (name) return name;
  }
  return `Run failed: ${JSON.stringify(data)}`;
}

/** Messages carry an `id` once persisted; a streaming one may not, so index is the fallback. */
function messageKey(message: Message, index: number): string {
  return (message as { id?: string }).id ?? `index-${index}`;
}

function Bubble({ message }: { message: Message }) {
  // `type` is the SDK's discriminant ("human"/"ai"/"tool"); `role` is what the OpenAI-shaped wire
  // format uses. A thread can hold either depending on how the graph wrote it, so read both.
  const shape = message as { type?: string; role?: string };
  const role = shape.type ?? shape.role ?? "unknown";
  const human = role === "human" || role === "user";
  return (
    <li className={cn("flex", human ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3 py-2 text-[13px] leading-relaxed",
          human ? "bg-primary text-primary-foreground" : "border bg-muted/40",
        )}
      >
        {!human ? (
          <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            {role}
          </div>
        ) : null}
        <Content content={message.content} />
      </div>
    </li>
  );
}

/**
 * Message content is a string, or an array of typed blocks (text, tool calls, images). Render the
 * text and show the rest as JSON rather than silently dropping it — a tool call the console hides is
 * a tool call you debug twice.
 */
function Content({ content }: { content: Message["content"] }) {
  if (typeof content === "string") return <span className="whitespace-pre-wrap">{content}</span>;
  if (!Array.isArray(content)) return <Json value={content} />;
  return (
    <div className="space-y-1.5">
      {content.map((block, index) => {
        if (typeof block === "string") {
          return (
            <span key={index} className="whitespace-pre-wrap">
              {block}
            </span>
          );
        }
        const typed = block as { type?: string; text?: string };
        if (typed.type === "text" && typeof typed.text === "string") {
          return (
            <span key={index} className="whitespace-pre-wrap">
              {typed.text}
            </span>
          );
        }
        return <Json key={index} value={block} />;
      })}
    </div>
  );
}
