import {
  isSkeinHttpError,
  serializeWireJson,
  SkeinHttpError,
  type ThreadCommandError,
  type ThreadCommandSuccess,
  type ThreadEventFilter,
  type ThreadProtocolEvent,
  type ThreadState,
} from "@skein-js/core";
import { z } from "zod";

import type { ProtocolContext } from "../context.js";
import { requireAgentCapability } from "../graphs/agent-graph.js";
import { resolveCompiledGraph } from "../graphs/resolve-compiled-graph.js";
import { toFactoryConfigurable } from "../runs/run-input.js";
import type { CreateRunInput, RunService } from "../runs/run-service.js";
import { withSseHeartbeats } from "../sse/sse.js";
import { runCreateSchema } from "../validation/schemas.js";

import { encodeThreadFollowEvent } from "./thread-follow-event.js";
import { markThreadProtocolRun } from "./thread-protocol-run.js";
import { createThreadService } from "./thread-service.js";

export const threadEventFilterSchema = z.object({
  channels: z
    .array(
      z.custom<ThreadEventFilter["channels"][number]>(
        (value) =>
          typeof value === "string" &&
          value.length <= 256 &&
          ([
            "values",
            "updates",
            "messages",
            "tools",
            "lifecycle",
            "input",
            "checkpoints",
            "tasks",
            "custom",
          ].includes(value) ||
            /^custom:.+/.test(value)),
      ),
    )
    .min(1)
    .max(100),
  namespaces: z.array(z.array(z.string()).max(100)).max(100).optional(),
  depth: z.number().int().nonnegative().max(1000).optional(),
  since: z.number().int().nonnegative().safe().optional(),
});

export const threadCommandEnvelopeSchema = z.object({
  id: z.number().int().nonnegative().safe(),
  method: z.string().min(1).max(256),
  params: z.record(z.unknown()).optional().default({}),
});

/** Identify the protocol generation before authorization or legacy-body parsing. */
export function isThreadCommandEnvelope(body: unknown): boolean {
  return typeof body === "object" && body !== null && ("method" in body || "id" in body);
}

export function createThreadProtocolService(ctx: ProtocolContext, runs: RunService) {
  const { deps } = ctx;
  const threads = createThreadService(ctx);
  const requireBus = () => {
    if (!deps.threadBus)
      throw SkeinHttpError.unprocessable("Thread subscriptions require a thread event bus.", {
        code: "thread_protocol_unsupported",
      });
    return deps.threadBus;
  };

  const findThread = async (threadId: string) => deps.store.threads.get(threadId);

  const start = async (threadId: string, params: Record<string, unknown>, resume?: unknown) => {
    requireBus();
    const thread = await findThread(threadId);
    const latest = (await deps.store.runs.listByThread(threadId)).sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    )[0];
    const assistantId =
      params["assistant_id"] ?? thread?.metadata?.["assistant_id"] ?? latest?.assistant_id;
    const payload = runCreateSchema.parse({
      ...params,
      assistant_id: assistantId,
      if_not_exists: "create",
      multitask_strategy: params["multitaskStrategy"] ?? params["multitask_strategy"] ?? "enqueue",
      ...(resume !== undefined
        ? { input: undefined, command: { resume, update: params["update"], goto: params["goto"] } }
        : {}),
    }) as CreateRunInput;
    // Resolve before admission so an old custom agent fails without leaving a broken queued run.
    const assistant =
      typeof assistantId === "string" ? await deps.store.assistants.get(assistantId) : null;
    if (!assistant) throw SkeinHttpError.notFound("Assistant not found.");
    const graph = await resolveCompiledGraph(deps.graphs, assistant.graph_id, {
      configurable: toFactoryConfigurable({
        ...payload,
        auth_user: ctx.authUser,
        auth_scopes: ctx.authScopes,
      }),
      checkpointer: deps.checkpointer,
      store: deps.storeBridge?.(deps.store.store),
    });
    requireAgentCapability(graph, "streamProtocol");
    return runs.createBackground(threadId, markThreadProtocolRun(payload));
  };

  const connect = async (threadId: string, since: number | undefined, signal?: AbortSignal) => {
    const stopped = new AbortController();
    ctx.threadStreams?.add(stopped);
    const abort = () => stopped.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) stopped.abort();
    const close = () => {
      stopped.abort();
      ctx.threadStreams?.delete(stopped);
      signal?.removeEventListener("abort", abort);
    };
    try {
      const bus = requireBus();
      const generation = await bus.generation(threadId);
      return {
        source: bus.subscribe(threadId, since, stopped.signal),
        isCurrent: async () =>
          !stopped.signal.aborted && (await bus.generation(threadId)) === generation,
        close,
      };
    } catch (error) {
      close();
      throw error;
    }
  };
  return {
    async follow(
      threadId: string,
      modes: readonly string[],
      since?: number,
      signal?: AbortSignal,
    ): Promise<AsyncIterable<string>> {
      await threads.get(threadId);
      // Without a cursor, start at the tail: earlier runs' frames are history, not live events.
      const connection = await connect(
        threadId,
        since ?? (await requireBus().latestSequence(threadId)),
        signal,
      );
      return withSseHeartbeats(
        (async function* () {
          try {
            if (!(await connection.isCurrent())) return;
            yield ": subscribed\n\n";
            for await (const entry of connection.source) {
              if (!(await connection.isCurrent()) || !(await deps.store.threads.get(threadId)))
                return;
              if (entry.kind === "protocol") continue;
              if (entry.runId && !(await deps.store.runs.get(entry.runId))) continue;
              yield* encodeThreadFollowEvent(entry, modes);
            }
          } finally {
            connection.close();
          }
        })(),
      );
    },
    async command(
      threadId: string,
      body: unknown,
    ): Promise<ThreadCommandSuccess | ThreadCommandError> {
      const parsed = threadCommandEnvelopeSchema.safeParse(body);
      if (!parsed.success)
        return {
          type: "error",
          id: null,
          error: "invalid_argument",
          message: "Commands require a nonnegative integer id, method and object params.",
        };
      const { id, method, params } = parsed.data;
      try {
        switch (method) {
          case "run.start": {
            const thread = await findThread(threadId);
            const run = await start(
              threadId,
              params,
              thread?.status === "interrupted" ? params["input"] : undefined,
            );
            return { type: "success", id, result: { run_id: run.run_id } };
          }
          case "input.respond": {
            const thread = await threads.get(threadId);
            if (thread.status !== "interrupted")
              throw SkeinHttpError.conflict("Thread is not interrupted.");
            const responses = z
              .array(z.object({ interrupt_id: z.string(), response: z.unknown() }))
              .min(1)
              .optional()
              .parse(params["responses"]);
            const resume = responses
              ? Object.fromEntries(
                  responses.map((response) => [response.interrupt_id, response.response]),
                )
              : { [z.string().min(1).parse(params["interrupt_id"])]: params["response"] };
            const pending = new Set(
              Object.values(thread.interrupts ?? {})
                .flat()
                .map((interrupt) => interrupt.id),
            );
            if (Object.keys(resume).some((key) => !pending.has(key)))
              return {
                type: "error",
                id,
                error: "no_such_interrupt",
                message: "Interrupt not found.",
              };
            await start(threadId, params, resume);
            return { type: "success", id, result: {} };
          }
          case "state.get": {
            const namespace = z.array(z.string()).optional().parse(params["namespace"]) ?? [];
            const state = await threads.getState(threadId, {
              checkpoint: { checkpoint_ns: namespace.join("|") },
            });
            const keys = z.array(z.string()).optional().parse(params["keys"]);
            const values = state.values;
            return {
              type: "success",
              id,
              result: {
                values: keys
                  ? Object.fromEntries(Object.entries(values).filter(([key]) => keys.includes(key)))
                  : values,
                ...(state.checkpoint.checkpoint_id
                  ? {
                      checkpoint: {
                        id: state.checkpoint.checkpoint_id,
                        ns: state.checkpoint.checkpoint_ns,
                      },
                    }
                  : {}),
              },
            };
          }
          case "state.listCheckpoints": {
            const namespace = z.array(z.string()).optional().parse(params["namespace"]) ?? [];
            const history = await threads.history(threadId, {
              checkpoint: { checkpoint_ns: namespace.join("|") },
              limit: z.number().int().positive().max(1000).optional().parse(params["limit"]),
              ...(typeof params["before"] === "string"
                ? { before: { configurable: { checkpoint_id: params["before"] } } }
                : {}),
            });
            return {
              type: "success",
              id,
              result: {
                checkpoints: history.map((state) => ({
                  id: state.checkpoint.checkpoint_id ?? "",
                  timestamp: state.created_at ?? "",
                  step: typeof state.metadata?.["step"] === "number" ? state.metadata["step"] : 0,
                  metadata: state.metadata ?? undefined,
                })),
              },
            };
          }
          case "state.fork": {
            const checkpointId = z.string().min(1).parse(params["checkpoint_id"]);
            await threads.get(threadId);
            // Agent snapshots may omit timestamps, and LangGraph echoes even nonexistent IDs.
            // Read the stored coordinate after authorizing the source thread instead.
            const checkpoint = await deps.checkpointer.getTuple({
              configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: checkpointId },
            });
            if (checkpoint?.checkpoint.id !== checkpointId)
              return {
                type: "error",
                id,
                error: "no_such_checkpoint",
                message: "Checkpoint not found.",
              };
            const fork = await threads.copy(threadId);
            let run;
            try {
              run = await start(fork.thread_id, { ...params, checkpoint_id: checkpointId });
            } catch (error) {
              await threads.delete(fork.thread_id);
              throw error;
            }
            return {
              type: "success",
              id,
              result: { run_id: run.run_id, thread_id: fork.thread_id },
            };
          }
          case "agent.getTree": {
            const thread = await threads.get(threadId);
            const state = await threads.getState(threadId, { subgraphs: true });
            const tree = stateTree(state, [], String(thread.metadata?.["graph_id"] ?? "root"));
            tree.status =
              thread.status === "busy"
                ? "running"
                : thread.status === "interrupted"
                  ? "interrupted"
                  : thread.status === "error"
                    ? "failed"
                    : "completed";
            return { type: "success", id, result: { tree } };
          }
          default:
            return {
              type: "error",
              id,
              error:
                method.startsWith("subscription.") || method === "input.inject"
                  ? "not_supported"
                  : "unknown_command",
              message: `Unsupported HTTP command: ${method}`,
            };
        }
      } catch (error) {
        if (
          isSkeinHttpError(error) &&
          (error.status === 401 || error.status === 403 || error.status === 404)
        )
          throw error;
        return {
          type: "error",
          id,
          error:
            error instanceof z.ZodError
              ? "invalid_argument"
              : isSkeinHttpError(error) && error.status === 422
                ? "not_supported"
                : "unknown_error",
          message:
            error instanceof z.ZodError
              ? "Invalid command parameters."
              : isSkeinHttpError(error)
                ? error.message
                : "Command failed.",
        };
      }
    },

    async subscribe(
      threadId: string,
      filter: ThreadEventFilter,
      signal?: AbortSignal,
    ): Promise<AsyncIterable<string>> {
      const replayCursor = filter.since ?? (await requireBus().replayCursor(threadId));
      const cursor = filter.since ?? (await requireBus().latestSequence(threadId));
      const connection = await connect(threadId, replayCursor, signal);
      const baseline: ThreadProtocolEvent[] = [];
      try {
        if (filter.since === undefined) {
          const thread = await findThread(threadId);
          if (thread) {
            const state = await threads.getState(threadId, { subgraphs: true });
            const collectState = (snapshot: ThreadState, namespace: string[]) => {
              baseline.push({
                type: "event",
                method: "values",
                params: { namespace, timestamp: Date.now(), data: snapshot.values },
              });
              for (const task of snapshot.tasks) {
                const childNamespace = task.state?.checkpoint.checkpoint_ns?.split("|") ?? [
                  ...namespace,
                  `${task.name}:${task.id}`,
                ];
                if (task.state) collectState(task.state, childNamespace);
                for (const interrupt of task.interrupts ?? []) {
                  if (interrupt.id)
                    baseline.push({
                      type: "event",
                      method: "input.requested",
                      params: {
                        namespace,
                        timestamp: Date.now(),
                        data: { interrupt_id: interrupt.id, payload: interrupt.value },
                      },
                    });
                }
              }
            };
            collectState(state, []);
            const latest = (await deps.store.runs.listByThread(threadId)).sort((a, b) =>
              b.created_at.localeCompare(a.created_at),
            )[0];
            if (latest && (await requireBus().latestSequence(threadId)) === cursor)
              baseline.push({
                type: "event",
                method: "lifecycle",
                params: {
                  namespace: [],
                  timestamp: Date.now(),
                  data: {
                    event:
                      thread.status === "busy"
                        ? "running"
                        : thread.status === "interrupted"
                          ? "interrupted"
                          : thread.status === "error"
                            ? "failed"
                            : "completed",
                  },
                },
              });
          }
        }
      } catch (error) {
        connection.close();
        throw error;
      }
      const encoded = async function* () {
        try {
          if (!(await connection.isCurrent())) return;
          yield ": subscribed\n\n";
          if (baseline.length && !(await deps.store.threads.get(threadId))) return;
          const encodeBaseline = function* () {
            for (const [index, event] of baseline.entries()) {
              if (!matchesFilter(filter, event)) continue;
              yield encodeProtocolEvent({
                ...event,
                seq: cursor,
                event_id: `${cursor}:snapshot:${index}:${event.method}`,
              });
            }
          };
          let baselinePending = replayCursor < cursor;
          if (!baselinePending) yield* encodeBaseline();
          for await (const entry of connection.source) {
            if (!(await connection.isCurrent()) || !(await deps.store.threads.get(threadId)))
              return;
            // Replay publication order first, then the state baseline, then live events.
            if (baselinePending && entry.seq > cursor) {
              yield* encodeBaseline();
              baselinePending = false;
            }
            if (
              entry.kind === "protocol" &&
              (await deps.store.runs.get(entry.runId)) &&
              matchesFilter(filter, entry.event)
            )
              yield encodeProtocolEvent(entry.event);
            if (baselinePending && entry.seq >= cursor) {
              yield* encodeBaseline();
              baselinePending = false;
            }
          }
        } catch (error) {
          if (!isSkeinHttpError(error) || error.code !== "thread_cursor_expired") throw error;
          yield `event: error\ndata: ${serializeWireJson({ type: "error", id: null, error: "thread_cursor_expired", message: error.message })}\n\n`;
        } finally {
          connection.close();
        }
      };
      return withSseHeartbeats(encoded());
    },
  };
}

function matchesFilter(filter: ThreadEventFilter, event: ThreadProtocolEvent): boolean {
  const channel = event.method.startsWith("input.") ? "input" : event.method;
  const data = event.params.data;
  const custom =
    event.method === "custom" && typeof data === "object" && data !== null && "name" in data
      ? `custom:${String(data.name)}`
      : channel;
  if (
    !(filter.channels as readonly string[]).includes(channel) &&
    !(filter.channels as readonly string[]).includes(custom)
  )
    return false;
  const namespace = event.params.namespace;
  const prefixes = filter.namespaces?.length ? filter.namespaces : [[]];
  return prefixes.some(
    (prefix) =>
      prefix.every(
        (segment, index) =>
          namespace[index] === segment ||
          (!segment.includes(":") && namespace[index]?.split(":")[0] === segment),
      ) &&
      (filter.depth === undefined || namespace.length - prefix.length <= filter.depth),
  );
}

function encodeProtocolEvent(event: ThreadProtocolEvent): string {
  return `id: ${event.seq ?? 0}\nevent: ${event.method.replace(/[\r\n]/g, "")}\ndata: ${serializeWireJson(event)}\n\n`;
}

type ThreadAgentTree = {
  namespace: string[];
  graph_name: string;
  status: "running" | "interrupted" | "completed" | "failed";
  children: ThreadAgentTree[];
};

function stateTree(state: ThreadState, namespace: string[], graphName: string): ThreadAgentTree {
  return {
    namespace,
    graph_name: graphName,
    status: state.next.length ? "interrupted" : "completed",
    children: state.tasks.flatMap((task) =>
      task.state
        ? [
            stateTree(
              task.state,
              task.state.checkpoint.checkpoint_ns?.split("|") ?? [
                ...namespace,
                `${task.name}:${task.id}`,
              ],
              task.name,
            ),
          ]
        : [],
    ),
  };
}
