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

import type { Message, Run } from "@langchain/langgraph-sdk";
import { MessageTupleManager, toMessageDict } from "@langchain/langgraph-sdk/ui";
import { CornerDownLeft, PanelRightClose, PanelRightOpen, Plus, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { createConsoleClient, createSkeinConsoleClient, fetchServerInfo } from "@/api";
import { GraphDiagram } from "@/components/graph-diagram";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";
import type { GraphEdge, GraphNode } from "@/graph-layout";
import { acceptsMessages, inputSchemaOf, sampleInputFor } from "@/graph-schema";
import { cn } from "@/lib/utils";
import { routeHref } from "@/router";
import { useAsync } from "@/use-async";
import { useFrameBuffer } from "@/use-frame-buffer";
import { usePagedRows } from "@/use-paged-rows";
import { useRunStream } from "@/use-run-stream";

import { ActivityFeed, describeExecution } from "./activity";
import { InterruptPanel, pendingInterrupts } from "./interrupts";
import { Async, Json, Pagination, Panel } from "./parts";
import { DEFAULT_RUN_OPTIONS, parseRunOptions, RunOptionsForm } from "./run-options";
import { Transcript } from "./transcript";

type InputMode = "chat" | "json";

export function ChatView({ threadId }: { threadId?: string }) {
  const [client] = useState(() => createConsoleClient({}));
  const assistants = usePagedRows(
    (offset, limit, signal) => client.assistants.search({ offset, limit, signal }),
    "playground-assistants",
    25,
    (signal) => client.assistants.count({ signal }),
  );
  const [selection, setSelection] = useState<{
    assistantId: string;
    threadId?: string;
    sessionKey?: string;
  }>();
  const restored = useAsync(
    async (signal) => {
      if (!threadId) return undefined;
      const [latest, thread] = await Promise.all([
        client.runs.list(threadId, { limit: 1, signal }),
        client.threads.get(threadId, { signal }),
      ]);
      return {
        run: latest[0],
        assistantId:
          latest[0]?.assistant_id ??
          (typeof thread.metadata?.assistant_id === "string"
            ? thread.metadata.assistant_id
            : undefined),
      };
    },
    [threadId],
  );
  // An owned submission updates selection before the hash event arrives. Keep the same
  // session through both renders; an external route change starts a different session.
  const [previousThreadId, setPreviousThreadId] = useState(threadId);
  if (previousThreadId !== threadId) {
    setPreviousThreadId(threadId);
    if (selection?.threadId !== threadId) setSelection(undefined);
  }
  const knownSelection = selection?.assistantId;
  const selected =
    knownSelection ?? (threadId ? restored.data?.assistantId : assistants.rows?.[0]?.assistant_id);
  const sessionKey = selection?.sessionKey ?? threadId ?? "new";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-end gap-3">
        <label className="field-label w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-xs">
          Assistant
          <select
            className="field"
            value={selected ?? ""}
            onChange={(event) => {
              setSelection({ assistantId: event.target.value, threadId });
            }}
          >
            <option value="" disabled>
              Select an Assistant
            </option>
            {selected &&
              !assistants.rows?.some((assistant) => assistant.assistant_id === selected) && (
                <option value={selected}>{selected} · current Assistant</option>
              )}
            {assistants.rows?.map((assistant) => (
              <option key={assistant.assistant_id} value={assistant.assistant_id}>
                {assistant.name || assistant.graph_id} · {assistant.graph_id}
              </option>
            ))}
          </select>
        </label>
        <span className="help pb-2">An Assistant is a saved configuration of a graph.</span>
        {(assistants.hasNext || assistants.offset > 0) && (
          <Pagination
            {...assistants}
            compact
            count={assistants.rows?.length ?? 0}
            onPrevious={assistants.previous}
            onNext={assistants.next}
          />
        )}
      </div>
      {(assistants.error || assistants.loading || !assistants.rows?.length) && (
        <Async
          state={{ ...assistants, data: assistants.rows }}
          empty="No Assistants registered. Add a graph to langgraph.json to get started."
        >
          {() => null}
        </Async>
      )}
      {restored.error && !knownSelection && (
        <p className="action-error" role="alert">
          Unable to identify this thread&apos;s Assistant: {restored.error.message}. Select one
          explicitly before continuing.
        </p>
      )}
      {selected && (knownSelection || !threadId || !restored.loading) ? (
        <Session
          key={`${selected}:${sessionKey}`}
          assistantId={selected}
          threadId={threadId}
          initialRun={restored.data?.run}
          onThreadCreated={(id) =>
            setSelection({ assistantId: selected, threadId: id, sessionKey })
          }
          onNewThread={() => setSelection({ assistantId: selected, sessionKey: "new" })}
        />
      ) : (
        <Panel title="Get started" padded>
          <p className="text-sm text-muted-foreground">
            Select an Assistant above to run your graph.
          </p>
        </Panel>
      )}
    </div>
  );
}

function Session({
  assistantId,
  threadId,
  initialRun,
  onThreadCreated,
  onNewThread,
}: {
  assistantId: string;
  threadId?: string;
  initialRun?: Run;
  onThreadCreated: (id: string) => void;
  onNewThread: () => void;
}) {
  const [client] = useState(() => createConsoleClient({}));
  const capabilities = useAsync((signal) => fetchServerInfo(signal), []);
  const [options, setOptions] = useState(DEFAULT_RUN_OPTIONS);
  const [batchRuns, setBatchRuns] = useState<{ run_id: string; thread_id: string }[]>([]);
  const [requestedMode, setMode] = useState<InputMode | undefined>();
  /**
   * One draft per mode.
   *
   * A single shared draft meant the JSON template seeded for a non-chat graph was still sitting in the
   * box after switching to Chat — so the first thing you sent a chatbot was a state object.
   */
  const [drafts, setDrafts] = useState<Partial<Record<InputMode, string>>>({ chat: "" });
  const [messages, setMessages] = useState<Message[]>([]);
  const [values, setValues] = useState<unknown>();
  const [running, setRunning] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const restoreActivity = useRef(Boolean(threadId));
  const observeHistory = restoreActivity.current && !submitted && Boolean(initialRun);
  const history = useRunStream(threadId ?? "", initialRun?.run_id ?? "", observeHistory);
  const [error, setError] = useState<Error | undefined>();
  const [activeNode, setActiveNode] = useState<string | undefined>();
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set());
  const {
    frames,
    dropped,
    append: appendFrame,
    clear: clearFrames,
    flush: flushFrames,
  } = useFrameBuffer();
  const [terminalStatus, setTerminalStatus] = useState<string>();
  const [inspector, setInspector] = useState<"activity" | "graph" | "state">("activity");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const messageChunks = useRef(new MessageTupleManager());
  const [runIdentity, setRunIdentity] = useState<{ threadId: string; runId: string }>();
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
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

  const mode = !chatSupported
    ? "json"
    : (requestedMode ?? (schemas.data === undefined ? undefined : "chat"));

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
    if (followOutput.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, running, history.frames]);

  const draft = mode ? (drafts[mode] ?? (mode === "json" ? sampleInputFor(schemas.data) : "")) : "";
  const setDraft = useCallback(
    (value: string) => setDrafts((current) => (mode ? { ...current, [mode]: value } : current)),
    [mode],
  );

  const send = useCallback(async () => {
    if (draft.trim() === "" || running || mode === undefined) return;
    setError(undefined);
    setSubmitted(true);
    setRunning(true);
    setVisited(new Set());
    setActiveNode(undefined);
    clearFrames();
    setTerminalStatus(undefined);
    setRunIdentity(undefined);
    setBatchRuns([]);
    messageChunks.current.clear();
    const controller = new AbortController();
    abort.current = controller;
    let observedStatus: string | undefined;
    let reportedFailure = false;

    try {
      const parsedOptions = parseRunOptions(options);
      if (
        parsedOptions.timeoutMs !== undefined &&
        capabilities.data?.flags?.per_run_timeout !== true
      )
        throw new Error("This server has not confirmed execution timeout support.");
      const submissionClient = createConsoleClient({
        executionTimeoutMs: parsedOptions.timeoutMs,
        idempotencyKey: parsedOptions.idempotencyKey,
        completion: options.target === "stateless" ? options.completion : undefined,
      });
      let input: Record<string, unknown>;
      if (mode === "chat") {
        const id = parsedOptions.idempotencyKey
          ? `console-${parsedOptions.idempotencyKey}`
          : crypto.randomUUID();
        setMessages((previous) => [...previous, { id, type: "human", content: draft } as Message]);
        input = { messages: [{ id, role: "human", content: draft }] };
      } else {
        const parsed: unknown = JSON.parse(draft);
        if (options.target === "batch") {
          if (
            !Array.isArray(parsed) ||
            !parsed.length ||
            parsed.length > 100 ||
            parsed.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))
          )
            throw new Error("Batch input must be an array of 1–100 JSON objects.");
          const rows = await createSkeinConsoleClient().createBatchRuns(
            parsed.map((entry) => ({
              assistant_id: assistantId,
              input: entry,
              stream_mode: options.capture,
              after_seconds: parsedOptions.afterSeconds,
              on_completion: options.completion,
              multitask_strategy: options.multitask,
              ...(parsedOptions.timeoutMs === undefined
                ? {}
                : { timeout_ms: parsedOptions.timeoutMs }),
            })),
            parsedOptions.idempotencyKey,
            controller.signal,
          );
          setBatchRuns(rows);
          setTerminalStatus("submitted");
          setDrafts((current) => (current.json === draft ? { ...current, json: "" } : current));
          return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Graph input must be a JSON object.");
        input = parsed as Record<string, unknown>;
      }

      // The thread is created on first send rather than on mount, so opening the playground and
      // walking away does not litter the thread list with empties.
      let target = options.target === "stateless" ? null : options.threadId || activeThread.current;
      if (target === undefined) {
        const created = await client.threads.create({ metadata: { source: "console-playground" } });
        target = created.thread_id;
        activeThread.current = target;
        onThreadCreated(target);
        window.location.hash = routeHref(`playground/${encodeURIComponent(target)}`);
      }
      if (target && target !== activeThread.current) {
        activeThread.current = target;
        onThreadCreated(target);
        window.location.hash = routeHref(`playground/${encodeURIComponent(target)}`);
      }
      const payload = {
        input,
        streamMode: options.capture,
        multitaskStrategy: options.multitask,
        afterSeconds: parsedOptions.afterSeconds,
        onDisconnect: "cancel" as const,
        onRunCreated: ({ run_id, thread_id }: { run_id: string; thread_id?: string }) => {
          const resolvedThread = thread_id ?? target;
          if (resolvedThread) setRunIdentity({ threadId: resolvedThread, runId: run_id });
        },
        signal: controller.signal,
      };
      const background = Boolean(
        parsedOptions.afterSeconds ||
        parsedOptions.idempotencyKey ||
        options.target === "stateless",
      );
      const createdRun = background
        ? await submissionClient.runs.create(target ?? null, assistantId, payload)
        : undefined;
      if (createdRun) {
        target = createdRun.thread_id;
        setRunIdentity({ threadId: target, runId: createdRun.run_id });
        onThreadCreated(target);
        {
          activeThread.current = target;
          window.location.hash = routeHref(`playground/${encodeURIComponent(target)}`);
        }
      }
      const chunks = createdRun
        ? submissionClient.runs.joinStream(target ?? null, createdRun.run_id, {
            signal: controller.signal,
            cancelOnDisconnect: false,
          })
        : target === null
          ? submissionClient.runs.stream(null, assistantId, {
              input,
              streamMode: options.capture,
              onDisconnect: "cancel",
              signal: controller.signal,
            })
          : submissionClient.runs.stream(target, assistantId, payload);

      for await (const chunk of chunks) {
        if (controller.signal.aborted) break;
        appendFrame(String(chunk.event), chunk.data);
        if (String(chunk.event) === "messages" || String(chunk.event) === "messages-tuple") {
          const tuple = chunk.data as unknown as [Message, Record<string, unknown>];
          if (Array.isArray(tuple) && tuple[0]) {
            const id = messageChunks.current.add(tuple[0], tuple[1]);
            const assembled = messageChunks.current.get(id)?.chunk;
            if (assembled) {
              const message = toMessageDict(assembled);
              setMessages((previous) => {
                const index = previous.findIndex((item) => item.id === message.id);
                return index < 0
                  ? [...previous, message]
                  : previous.map((item, position) => (position === index ? message : item));
              });
            }
          }
          continue;
        }
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
          reportedFailure = true;
          setError(new Error(describeRunFailure(chunk.data)));
          continue;
        }
        // `end` carries the terminal status. The SDK's event union does not name it (skein
        // synthesizes the frame), so it is read through a widened type rather than left unhandled.
        const frame = chunk as { event: string; data?: { status?: string } };
        if (frame.event === "end") {
          const status = frame.data?.status;
          observedStatus = status;
          setTerminalStatus(status);
          if (
            !reportedFailure &&
            status !== undefined &&
            status !== "success" &&
            status !== "interrupted" &&
            status !== "cancelled"
          ) {
            setError(new Error(`Run ended with status "${status}".`));
          }
        }
      }
      if (!controller.signal.aborted) {
        if (
          !reportedFailure &&
          (observedStatus === "success" || observedStatus === "interrupted")
        ) {
          setDrafts((current) =>
            (current[mode] ?? draft) === draft ? { ...current, [mode]: "" } : current,
          );
        } else if (!reportedFailure && observedStatus === undefined) {
          setError(
            new Error(
              "Observation ended before a final status was received. Inspect the thread before submitting again; the run may still be executing.",
            ),
          );
        }
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(
          new Error(
            `${caught instanceof Error ? caught.message : String(caught)}${options.target === "batch" ? " A failed batch may already have created some runs. Inspect Threads before submitting again." : ""}`,
          ),
        );
      }
    } finally {
      flushFrames();
      ranUntil.current = Date.now();
      setRunning(false);
      abort.current = undefined;
      thread.reload();
    }
  }, [
    assistantId,
    client,
    draft,
    mode,
    running,
    thread,
    options,
    capabilities.data,
    onThreadCreated,
    appendFrame,
    clearFrames,
    flushFrames,
  ]);

  const interrupts = pendingInterrupts(thread.data);
  const structure = graph.data as { nodes?: GraphNode[]; edges?: GraphEdge[] } | undefined;

  const displayedFrames = observeHistory ? history.frames : frames;
  const displayedDropped = observeHistory ? history.dropped : dropped;
  const observedEnd = observeHistory
    ? ([...history.frames].reverse().find((frame) => frame.event === "end")?.data as
        { status?: string } | undefined)
    : undefined;
  const observedStatus = observeHistory
    ? (observedEnd?.status ?? initialRun?.status)
    : terminalStatus;
  const observingInFlight =
    observeHistory &&
    !observedEnd &&
    (initialRun?.status === "running" || initialRun?.status === "pending");
  const observedValues = observeHistory
    ? [...history.frames].reverse().find((frame) => frame.event === "values")?.data
    : undefined;
  const displayedValues = observedValues ?? values;
  const displayedMessages = observeHistory
    ? ((observedValues as { messages?: Message[] } | undefined)?.messages ?? messages)
    : messages;
  const observedFailure = observeHistory
    ? [...history.frames].reverse().find((frame) => frame.event === "error")?.data
    : undefined;
  const observedNodes = useMemo(
    () =>
      new Set(
        displayedFrames
          .filter((frame) => frame.event === "updates")
          .flatMap((frame) =>
            Object.keys(frame.data ?? {}).filter((name) => name !== "__interrupt__"),
          ),
      ),
    [displayedFrames],
  );
  const executionRunning = running || observingInFlight;
  const cancellableRun =
    runIdentity ??
    (observingInFlight && threadId && initialRun
      ? { threadId, runId: initialRun.run_id }
      : undefined);

  const summary =
    terminalStatus === "submitted"
      ? {
          title: "Batch submitted",
          description:
            "Open a run below to follow its execution. Batch runs continue in the background.",
          tone: "text-status-running",
        }
      : options.target === "stateless" && observedStatus === "success"
        ? {
            title: "Run completed",
            description:
              options.completion === "delete"
                ? "Review the captured output. The generated thread was deleted as requested. Send another input to start a fresh run."
                : "Review the output or inspect the generated thread. Each stateless submission starts fresh.",
            tone: "text-status-success",
          }
        : describeExecution({
            running: executionRunning,
            status: observedStatus,
            lastNode: activeNode ?? [...observedNodes].at(-1),
            pending: interrupts.length,
            error:
              error ??
              (observedFailure ? new Error(describeRunFailure(observedFailure)) : undefined),
          });
  const inspectorBody = (
    <>
      <Tabs
        label="Execution inspector"
        value={inspector}
        onChange={setInspector}
        tabs={[
          { value: "activity", label: "Activity" },
          { value: "graph", label: "Graph" },
          { value: "state", label: "State" },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {inspector === "activity" ? (
          <ActivityFeed frames={displayedFrames} dropped={displayedDropped} />
        ) : inspector === "graph" ? (
          structure?.nodes?.length ? (
            <>
              <p className="help mb-4">
                Highlighted nodes have reported output. The diagram does not predict which node is
                executing now.
              </p>
              <GraphDiagram
                nodes={structure.nodes}
                edges={structure.edges ?? []}
                visited={observeHistory ? observedNodes : visited}
              />
            </>
          ) : (
            <p className="help">Graph structure is unavailable for this Assistant.</p>
          )
        ) : displayedValues === undefined ? (
          <p className="help">State appears after the graph reports it.</p>
        ) : (
          <Json value={displayedValues} />
        )}
      </div>
    </>
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3 sm:gap-3">
        <div className="flex rounded-lg bg-muted p-1">
          {(["chat", "json"] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={mode === value}
              disabled={
                running || (value === "chat" && (!chatSupported || options.target === "batch"))
              }
              onClick={() => setMode(value)}
              title={
                value === "chat" && !chatSupported
                  ? "This graph expects structured input instead of messages."
                  : undefined
              }
              className={cn(
                "rounded-md px-3 py-1 text-sm",
                mode === value ? "bg-card font-medium shadow-sm" : "text-muted-foreground",
              )}
            >
              {value === "chat" ? "Chat" : "JSON"}
            </button>
          ))}
        </div>
        <p className="help order-last basis-full sm:order-none sm:basis-auto sm:flex-1">
          {mode === undefined
            ? schemas.error
              ? "Choose an input mode; the graph schema is unavailable."
              : "Loading input schema…"
            : mode === "chat"
              ? schemas.error
                ? "Chat mode selected manually."
                : "This graph accepts messages."
              : `Structured input${inputKeys.length ? `: ${inputKeys.join(", ")}` : ". Submit a JSON object."}`}
        </p>
        {threadId &&
          !(
            options.target === "stateless" &&
            options.completion === "delete" &&
            observedStatus === "success"
          ) && (
            <a
              href={routeHref(`threads/${threadId}`)}
              className="text-xs text-primary"
              title={threadId}
            >
              Inspect thread ↗
            </a>
          )}
        <Button
          variant="outline"
          size="sm"
          disabled={running}
          onClick={() => {
            activeThread.current = undefined;
            onNewThread();
            window.location.hash = routeHref("playground");
            setMessages([]);
            setValues(undefined);
            setVisited(new Set());
            clearFrames();
            setError(undefined);
            setTerminalStatus(undefined);
            setSubmitted(true);
          }}
        >
          {" "}
          <Plus className="size-3.5" />
          <span className="sr-only sm:not-sr-only">New thread</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="hidden lg:inline-flex"
          aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
          aria-expanded={inspectorOpen}
          onClick={() => setInspectorOpen(!inspectorOpen)}
        >
          {inspectorOpen ? (
            <PanelRightClose className="size-4" />
          ) : (
            <PanelRightOpen className="size-4" />
          )}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="lg:hidden"
          aria-label="Inspect activity"
          onClick={() => setDrawerOpen(true)}
        >
          <PanelRightOpen className="size-4" />
        </Button>
      </div>
      <div
        className="flex shrink-0 items-start gap-3 border-b bg-muted/40 px-4 py-3"
        role="status"
        aria-live="polite"
      >
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            running
              ? "bg-status-running motion-safe:animate-pulse"
              : interrupts.length
                ? "bg-status-interrupted"
                : "bg-primary",
          )}
        />
        <div className="min-w-0">
          <p className={cn("text-sm font-semibold", summary.tone)}>{summary.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {summary.description}
          </p>
        </div>
      </div>
      {batchRuns.length > 0 && (
        <div className="border-b p-4">
          <p className="mb-2 text-sm font-medium">Created {batchRuns.length} runs</p>
          {batchRuns.map((run) => (
            <a
              key={run.run_id}
              className="mr-4 inline-block text-xs text-primary underline"
              href={routeHref(`threads/${run.thread_id}/runs/${run.run_id}`)}
            >
              {run.run_id.slice(0, 8)} ↗
            </a>
          ))}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            ref={transcript}
            role="region"
            aria-label="Conversation output"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-y-auto"
            onScroll={(event) => {
              const element = event.currentTarget;
              followOutput.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
          >
            <div className="p-4 sm:p-6">
              {schemas.error && (
                <div role="alert" className="mb-4 action-error">
                  <p className="font-medium">Input schema unavailable</p>
                  <p className="mt-1 text-xs">
                    {schemas.error.message}. Select Chat or JSON explicitly, or choose a different
                    Assistant.
                  </p>
                  <Button
                    className="mt-3"
                    variant="outline"
                    size="sm"
                    disabled={schemas.loading}
                    onClick={schemas.reload}
                  >
                    Retry schema
                  </Button>
                </div>
              )}
              {mode === "chat" ? (
                displayedMessages.length === 0 ? (
                  <Hint>
                    Send a message to see your Assistant&apos;s response and follow its reported
                    steps.
                  </Hint>
                ) : (
                  <Transcript messages={displayedMessages} />
                )
              ) : displayedValues === undefined ? (
                <Hint>
                  Edit the schema-based input below, then run it. The resulting state will appear
                  here.
                </Hint>
              ) : (
                <Json value={displayedValues} />
              )}
              {threadId && (
                <div className="mt-6">
                  <InterruptPanel
                    threadId={threadId}
                    assistantId={assistantId}
                    interrupts={interrupts}
                    onResumed={() => thread.reload()}
                    onRunCreated={(run) =>
                      setRunIdentity({ threadId: run.thread_id, runId: run.run_id })
                    }
                    onObserving={(observing) => {
                      setRunning(observing);
                      if (observing) {
                        setSubmitted(true);
                        setRunIdentity(undefined);
                        setError(undefined);
                        setTerminalStatus(undefined);
                      } else {
                        ranUntil.current = Date.now();
                        thread.reload();
                      }
                    }}
                    onFrame={(event, payload) => {
                      appendFrame(event, payload);
                      if (event === "values") {
                        setValues(payload);
                        const next = payload as { messages?: Message[] };
                        if (next?.messages) setMessages(next.messages);
                      } else if (event === "updates") {
                        const nodes = Object.keys((payload ?? {}) as Record<string, unknown>);
                        setActiveNode(nodes.at(-1));
                        setVisited((previous) => new Set([...previous, ...nodes]));
                      } else if (event === "end") {
                        setTerminalStatus((payload as { status?: string })?.status);
                      } else if (event === "error") {
                        setError(new Error(describeRunFailure(payload)));
                      }
                    }}
                  />
                </div>
              )}
              {observeHistory && history.error && (
                <p role="alert" className="mt-4 action-error">
                  The observer disconnected. The last server status was {initialRun?.status}.
                  Inspect the run before submitting again.
                </p>
              )}
              {error && (
                <div className="mt-4 action-error" role="alert">
                  {error.message}
                </div>
              )}
              <div ref={bottom} />
            </div>
          </div>
          <form
            className="relative max-h-full shrink-0 overflow-y-auto border-t bg-card p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <RunOptionsForm
              value={options}
              onChange={setOptions}
              timeoutSupported={capabilities.data?.flags?.per_run_timeout === true}
              disabled={running}
              jsonMode={mode === "json"}
            />
            <label className="sr-only" htmlFor="graph-input">
              {mode === "json" ? "Graph input (JSON)" : "Message"}
            </label>
            <textarea
              id="graph-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  !event.nativeEvent.isComposing &&
                  event.key === "Enter" &&
                  ((mode === "chat" && !event.shiftKey) || event.metaKey || event.ctrlKey)
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
              rows={mode === "json" ? 6 : 2}
              spellCheck={mode !== "json"}
              placeholder={
                mode === "json" ? "Enter graph input as JSON…" : "Message your Assistant…"
              }
              className={cn("field block resize-y", mode === "json" && "font-mono text-xs")}
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="help">
                {mode === "chat"
                  ? "Enter to send · Shift + Enter for a new line"
                  : "Ctrl / ⌘ + Enter to run"}
              </span>
              {executionRunning ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!cancellableRun}
                  title={
                    !cancellableRun ? "Waiting for the server to identify this run." : undefined
                  }
                  onClick={async () => {
                    try {
                      if (cancellableRun)
                        await createConsoleClient({}).runs.cancel(
                          cancellableRun.threadId,
                          cancellableRun.runId,
                          true,
                          "interrupt",
                        );
                      abort.current?.abort();
                      setTerminalStatus("cancelled");
                      setSubmitted(true);
                    } catch (caught) {
                      setError(caught instanceof Error ? caught : new Error(String(caught)));
                    }
                  }}
                >
                  <Square className="size-3.5" />
                  {cancellableRun ? "Stop run" : "Submitting run…"}
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={
                    !mode || draft.trim() === "" || interrupts.length > 0 || observingInFlight
                  }
                >
                  <CornerDownLeft className="size-3.5" />
                  {mode === "json" ? "Run input" : "Send message"}
                </Button>
              )}
            </div>
          </form>
        </div>
        {inspectorOpen && (
          <aside
            aria-label="Execution inspector"
            className="hidden w-80 shrink-0 flex-col border-l bg-muted/20 lg:flex"
          >
            {inspectorBody}
          </aside>
        )}
      </div>
      <Dialog
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Execution inspector"
        description="Inspect reported activity, graph structure, and current state."
        side
      >
        {inspectorBody}
      </Dialog>
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
