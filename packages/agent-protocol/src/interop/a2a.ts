import { internalProtocolHandlers } from "../meta/http-telemetry.js";
import {
  AgentCard,
  Message,
  Part,
  Role,
  Task,
  TaskState,
  formatSSEEvent,
  type SendMessageRequest,
  type StreamResponse,
} from "@a2a-js/sdk";
import { LegacyJsonRpcTransportHandler } from "@a2a-js/sdk/compat/v0_3/server";
import {
  TaskNotFoundError,
  TaskNotCancelableError,
  RequestMalformedError,
  UnsupportedOperationError,
  JsonRpcUnsupportedOperationError,
  toJsonRpcError,
} from "@a2a-js/sdk/errors";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import {
  isTerminalRunStatus,
  serializeWireJson,
  type Assistant,
  type Run,
  type RunResult,
} from "@skein-js/core";
import { z } from "zod";

import type { ProtocolContext } from "../context.js";
import type {
  ProtocolHandler,
  ProtocolHandlers,
  ProtocolRequest,
  ProtocolResponse,
} from "../create-handlers.js";
import { withThreadExecution } from "../runs/thread-locks.js";
import { createProtocolServiceFromContext } from "../service.js";

import { markA2aBody, readA2aOrigin, verifyA2aResume } from "./a2a-origin.js";

function bodyOf<T>(response: ProtocolResponse): T {
  if (response.kind !== "json") throw new Error("Expected a JSON service response.");
  return response.body as T;
}

const TASK_STATES: Record<Run["status"], TaskState> = {
  pending: TaskState.TASK_STATE_SUBMITTED,
  running: TaskState.TASK_STATE_WORKING,
  success: TaskState.TASK_STATE_COMPLETED,
  interrupted: TaskState.TASK_STATE_INPUT_REQUIRED,
  cancelled: TaskState.TASK_STATE_CANCELED,
  error: TaskState.TASK_STATE_FAILED,
  timeout: TaskState.TASK_STATE_FAILED,
};

/** Standard content blocks and A2A parts keep their media bytes, MIME and filename. */
function contentParts(content: unknown): Part[] {
  if (typeof content === "string") return content ? [Part.fromJSON({ text: content })] : [];
  if (!Array.isArray(content)) return [Part.fromJSON({ data: content })];
  return content.flatMap((block: Record<string, unknown>) => {
    if (typeof block["text"] === "string") return [Part.fromJSON({ text: block["text"] })];
    if (block["type"] === "image_url") {
      const image = block["image_url"];
      const url = typeof image === "string" ? image : (image as { url?: string })?.url;
      if (url) return [Part.fromJSON({ url, mediaType: "image/*" })];
    }
    if (block["source_type"] === "url" || block["source_type"] === "base64")
      return [
        Part.fromJSON({
          ...(block["source_type"] === "url" ? { url: block["url"] } : { raw: block["data"] }),
          mediaType: block["mime_type"],
          filename: block["filename"],
        }),
      ];
    return [Part.fromJSON({ data: block })];
  });
}

function inputFor(message: Message): Record<string, unknown> {
  const data = message.parts.filter((part) => part.content?.$case === "data");
  if (message.parts.length === 1 && data.length === 1)
    return data[0]!.content!.value as Record<string, unknown>;
  const content = message.parts.map((part) => {
    switch (part.content?.$case) {
      case "text":
        return { type: "text", text: part.content.value };
      case "url":
        return {
          type: "file",
          source_type: "url",
          url: part.content.value,
          mime_type: part.mediaType,
          filename: part.filename,
        };
      case "raw":
        return {
          type: "file",
          source_type: "base64",
          data: Buffer.from(part.content.value).toString("base64"),
          mime_type: part.mediaType,
          filename: part.filename,
        };
      case "data":
        return { type: "text", text: serializeWireJson(part.content.value) };
      default:
        throw new RequestMalformedError("A message part requires content.");
    }
  });
  return {
    messages: [
      {
        role: "user",
        content: content.every((block) => block.type === "text")
          ? content.map((block) => block["text"]).join("\n")
          : content,
      },
    ],
  };
}

/** Per-request authorization remains in the existing table; SDKs own JSON-RPC and legacy codecs. */
export function createA2aHandler(
  context: ProtocolContext,
  handlers: () => ProtocolHandlers,
): ProtocolHandler {
  return async (request) => {
    const table = internalProtocolHandlers(handlers());
    const assistantId =
      request.params["assistant_id"] ??
      String(request.query["assistant_id"] ?? process.env["DEFAULT_A2A_ASSISTANT_ID"] ?? "");
    const call = <T>(
      name: keyof ProtocolHandlers,
      params: Record<string, string>,
      body?: unknown,
      query: ProtocolRequest["query"] = {},
    ) => table[name]!({ ...request, params, body, query }).then(bodyOf<T>);
    const assistant = await call<Assistant>("getAssistant", { assistant_id: assistantId });
    const modes = assistant.metadata?.["a2a"] as
      { input_modes?: unknown; output_modes?: unknown } | undefined;
    const mediaModes = (value: unknown) =>
      value === undefined ? ["text/plain"] : z.array(z.string().min(1)).min(1).parse(value);
    const publicUrl = process.env["LANGGRAPH_API_URL"] ?? new URL(request.url).origin;
    const card = AgentCard.fromJSON({
      name: assistant.name,
      description: assistant.description ?? assistant.name,
      version: String(assistant.version),
      supportedInterfaces: ["1.0", "0.3"].map((protocolVersion) => ({
        url: `${publicUrl.replace(/\/$/, "")}/a2a/${encodeURIComponent(assistantId)}`,
        protocolBinding: "JSONRPC",
        protocolVersion,
      })),
      capabilities: {
        streaming: true,
        pushNotifications: false,
        extensions: [
          { uri: "https://langchain.com/a2a/extensions/history-scope/v1", required: false },
        ],
      },
      defaultInputModes: mediaModes(modes?.input_modes),
      defaultOutputModes: mediaModes(modes?.output_modes),
      skills: [
        {
          id: assistantId,
          name: assistant.name,
          description: assistant.description ?? assistant.name,
          tags: [],
        },
      ],
    });
    if (request.method === "GET")
      return { kind: "json", status: 200, body: AgentCard.toJSON(card) };
    const rawResult = z
      .object({ method: z.string(), params: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .safeParse(request.body);
    if (!rawResult.success)
      return {
        kind: "json",
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: null,
          error: toJsonRpcError(new RequestMalformedError("Invalid JSON-RPC request.")),
        },
      };
    const raw = rawResult.data;
    const rpcError = (error: unknown): ProtocolResponse => ({
      kind: "json",
      status: 200,
      body: { jsonrpc: "2.0", id: raw["id"] ?? null, error: toJsonRpcError(error) },
    });
    const supported = [
      "SendMessage",
      "SendStreamingMessage",
      "GetTask",
      "CancelTask",
      "ListTasks",
      "GetExtendedAgentCard",
      "message/send",
      "message/stream",
      "tasks/get",
      "tasks/cancel",
    ];
    if (!supported.includes(raw.method))
      return rpcError(
        new JsonRpcUnsupportedOperationError({
          envelopeCode: -32601,
          message: "Method not found.",
        }),
      );
    const params = raw.params ?? {};
    const configuration = (params["configuration"] ?? {}) as Record<string, unknown>;
    const streaming = raw.method === "SendStreamingMessage" || raw.method === "message/stream";
    let scope: "context" | "task" = "context";
    try {
      if (!streaming)
        scope = z
          .enum(["context", "task"])
          .parse(
            configuration["historyScope"] ??
              params["historyScope"] ??
              request.headers["langgraph-a2a-history-scope"] ??
              "context",
          );
      if (!streaming)
        z.number()
          .int()
          .min(0)
          .max(10)
          .nullish()
          .parse(configuration["historyLength"] ?? params["historyLength"]);
      for (const flag of ["returnImmediately", "blocking"])
        z.boolean().nullish().parse(configuration[flag]);
      if (
        configuration["returnImmediately"] == null &&
        typeof configuration["blocking"] === "boolean"
      )
        configuration["returnImmediately"] = !configuration["blocking"];
    } catch (error) {
      return rpcError(
        new RequestMalformedError(
          error instanceof z.ZodError ? "Invalid method parameters." : String(error),
        ),
      );
    }

    const readRun = async (id: string) => {
      const run = await context.deps.store.runs.get(id);
      if (!run || run.assistant_id !== assistantId || !run.metadata?.["skein_a2a"])
        throw new TaskNotFoundError();
      const owned = await call<Run>("getRun", { thread_id: run.thread_id, run_id: id });
      const origin = readA2aOrigin(await context.deps.store.runs.getKwargs(id));
      if (!origin || origin.rootId) throw new TaskNotFoundError();
      return owned;
    };
    const listRuns = async (threadId: string) => {
      const runs: Run[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await call<Run[]>("listThreadRuns", { thread_id: threadId }, undefined, {
          limit: "100",
          offset: String(offset),
        });
        runs.push(...page);
        if (page.length < 100) break;
      }
      return runs.sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.run_id.localeCompare(b.run_id),
      );
    };
    const taskLineage = async (root: Run, runs: Run[]) => {
      const lineage = [root];
      let current = root;
      const candidates = await Promise.all(
        runs
          .filter((run) => run.assistant_id === assistantId)
          .map(async (run) => ({
            run,
            origin: readA2aOrigin(await context.deps.store.runs.getKwargs(run.run_id)),
          })),
      );
      const visited = new Set([root.run_id]);
      for (;;) {
        const next = candidates.find(
          (candidate) =>
            candidate.origin?.rootId === root.run_id &&
            candidate.origin.expectedRunId === current.run_id &&
            !visited.has(candidate.run.run_id),
        );
        if (!next) return lineage;
        current = next.run;
        visited.add(current.run_id);
        lineage.push(current);
      }
    };
    const taskFor = async (id: string, historyLength?: number): Promise<Task> => {
      const root = await readRun(id);
      const runs = await listRuns(root.thread_id);
      const lineage = await taskLineage(root, runs);
      const latest = lineage.at(-1) ?? root;
      const result = await context.deps.store.runs.getResult?.(latest.run_id);
      const values = (result?.values ?? {}) as Record<string, unknown>;
      const messages = Array.isArray(values["messages"])
        ? (values["messages"] as Array<Record<string, unknown>>)
        : [];
      const parts =
        latest.status === "success"
          ? contentParts(result?.reply ?? messages.at(-1)?.["content"] ?? values)
          : [];
      const artifacts =
        latest.status === "interrupted"
          ? [
              {
                artifactId: `${id}:interrupt`,
                name: "Interrupt",
                parts: Object.values(result?.interrupts ?? {})
                  .flat()
                  .map((interrupt) =>
                    Part.toJSON(
                      Part.fromJSON({ data: { id: interrupt.id, value: interrupt.value } }),
                    ),
                  ),
              },
            ]
          : parts.length
            ? [
                {
                  artifactId: `${id}:reply`,
                  name: "Reply",
                  parts: parts.map((part) => Part.toJSON(part)),
                },
              ]
            : [];
      let history = scope === "context" ? runs : lineage;
      history = history.filter(
        (run) => run.assistant_id === assistantId && run.metadata?.["skein_a2a"],
      );
      const historyMessages: unknown[] = [];
      for (const run of history) {
        if (!readA2aOrigin(await context.deps.store.runs.getKwargs(run.run_id))) continue;
        const original = run.metadata?.["skein_a2a_message"];
        if (original) historyMessages.push(original);
        const previous = await context.deps.store.runs.getResult?.(run.run_id);
        if (run.status === "success" && previous) {
          const messages = (previous.values as Record<string, unknown>)["messages"];
          const last = Array.isArray(messages)
            ? (messages.at(-1) as { content?: unknown } | undefined)
            : undefined;
          historyMessages.push(
            Message.toJSON(
              Message.fromJSON({
                messageId: `${run.run_id}:reply`,
                contextId: run.thread_id,
                taskId: run.metadata?.["skein_a2a_root"] ?? run.run_id,
                role: "ROLE_AGENT",
                parts: contentParts(previous.reply ?? last?.content ?? previous.values).map(
                  (part) => Part.toJSON(part),
                ),
              }),
            ),
          );
        }
      }
      return Task.fromJSON({
        id,
        contextId: root.thread_id,
        status: {
          state: latest.status ? TASK_STATES[latest.status] : TaskState.TASK_STATE_FAILED,
          timestamp: latest.updated_at,
        },
        artifacts,
        history:
          historyLength === 0
            ? []
            : historyLength === undefined
              ? historyMessages
              : historyMessages.slice(-historyLength),
      });
    };
    const begin = async (input: SendMessageRequest): Promise<{ id: string; run: Run }> => {
      if (!context.deps.store.runs.recordResult || !context.deps.store.runs.getResult)
        throw new UnsupportedOperationError("This store cannot retain A2A task results.");
      const message = input.message;
      if (!message || !message.parts.length || message.role !== Role.ROLE_USER)
        throw new RequestMalformedError("A user message with content is required.");
      let threadId = message.contextId;
      let expectedRunId: string | undefined;
      let previousResult: RunResult | null | undefined;
      let resume: unknown;
      if (message.taskId) {
        const task = await taskFor(message.taskId, 0);
        if (threadId && threadId !== task.contextId) throw new TaskNotFoundError();
        if (task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED)
          throw new UnsupportedOperationError("Task is not awaiting input.");
        threadId = task.contextId;
        const runs = await listRuns(threadId);
        expectedRunId = (await taskLineage(await readRun(message.taskId), runs)).at(-1)?.run_id;
        previousResult = expectedRunId
          ? await context.deps.store.runs.getResult!(expectedRunId)
          : undefined;
        const responses = message.parts.filter(
          (part) =>
            part.content?.$case === "data" &&
            typeof part.content.value === "object" &&
            part.content.value !== null &&
            "resume" in part.content.value,
        );
        if (responses.length > 1)
          throw new RequestMalformedError("Send at most one resume data part.");
        resume = responses.length
          ? (responses[0]!.content!.value as { resume: unknown }).resume
          : message.parts
              .filter((part) => part.content?.$case === "text")
              .map((part) => part.content!.value)
              .join("\n");
      }
      if (threadId) await call("getThread", { thread_id: threadId });
      else
        threadId = bodyOf<{ thread_id: string }>(
          await table.createThread({ ...request, params: {}, body: {} }),
        ).thread_id;
      const origin = {
        ...(message.taskId ? { rootId: message.taskId } : {}),
        ...(expectedRunId ? { expectedRunId, checkpoint: previousResult?.checkpoint } : {}),
      };
      const body = markA2aBody(
        {
          assistant_id: assistantId,
          ...(streaming ? { stream_mode: ["messages", "values"] } : {}),
          ...(message.taskId
            ? {
                command: { resume },
                if_thread_status: ["interrupted"],
                multitask_strategy: "reject",
                checkpoint: previousResult?.checkpoint,
              }
            : { input: inputFor(message) }),
          metadata: {
            skein_a2a: true,
            ...(message.taskId ? { skein_a2a_root: message.taskId } : {}),
            skein_a2a_message: Message.toJSON(message),
          },
        },
        origin,
      );
      const create = async () => {
        if (expectedRunId) {
          try {
            await verifyA2aResume(context.deps, threadId, "", origin);
          } catch {
            throw new UnsupportedOperationError("Task no longer owns the interrupted checkpoint.");
          }
        }
        return call<Run>("createBackgroundRun", { thread_id: threadId }, body);
      };
      const run = expectedRunId
        ? await withThreadExecution(
            context.executionLocks,
            context.deps.threadExecutionGate,
            threadId,
            create,
          )
        : await create();
      return { id: message.taskId || run.run_id, run };
    };
    const wait = async (run: Run) =>
      table.joinRun({
        ...request,
        params: { thread_id: run.thread_id, run_id: run.run_id },
        query: {},
      });
    const unsupported = async (): Promise<never> => {
      throw new UnsupportedOperationError();
    };
    const handler: A2ARequestHandler = {
      getAgentCard: async () => card,
      getAuthenticatedExtendedAgentCard: async () => card,
      sendMessage: async (input) => {
        const started = await begin(input);
        if (!input.configuration?.returnImmediately) await wait(started.run);
        return taskFor(started.id, input.configuration?.historyLength);
      },
      async *sendMessageStream(input) {
        const started = await begin(input);
        yield { payload: { $case: "task", value: await taskFor(started.id, 0) } };
        await call<Run>("getRun", { thread_id: started.run.thread_id, run_id: started.run.run_id });
        const frames = await createProtocolServiceFromContext(context).runs.join(
          started.run.run_id,
          0,
        );
        for await (const frame of frames) {
          if (request.signal?.aborted) return;
          if (frame.event !== "messages" && frame.event !== "messages-tuple") continue;
          const payload = JSON.parse(serializeWireJson(frame.data)) as unknown;
          const message = (Array.isArray(payload) ? payload[0] : payload) as
            { content?: unknown } | undefined;
          const parts = contentParts(message?.content ?? "");
          if (parts.length)
            yield {
              payload: {
                $case: "artifactUpdate",
                value: {
                  taskId: started.id,
                  contextId: started.run.thread_id,
                  artifact: {
                    artifactId: `${started.id}:reply`,
                    name: "Reply",
                    description: "",
                    parts,
                    metadata: undefined,
                    extensions: [],
                  },
                  append: true,
                  lastChunk: false,
                  metadata: undefined,
                },
              },
            };
        }
        const task = await taskFor(started.id, 0);
        for (const artifact of task.artifacts)
          yield {
            payload: {
              $case: "artifactUpdate",
              value: {
                taskId: task.id,
                contextId: task.contextId,
                artifact,
                append: false,
                lastChunk: true,
                metadata: undefined,
              },
            },
          };
        yield {
          payload: {
            $case: "statusUpdate",
            value: {
              taskId: task.id,
              contextId: task.contextId,
              status: task.status,
              final: true,
              metadata: undefined,
            },
          },
        };
      },
      getTask: (input) => taskFor(input.id, input.historyLength),
      cancelTask: async (input) => {
        const root = await readRun(input.id);
        const runs = await listRuns(root.thread_id);
        const latest = (await taskLineage(root, runs)).at(-1) ?? root;
        if (isTerminalRunStatus(latest.status)) throw new TaskNotCancelableError();
        await table.cancelRun({
          ...request,
          params: { thread_id: latest.thread_id, run_id: latest.run_id },
          query: {},
        });
        return taskFor(input.id);
      },
      listTasks: async (input) => {
        const threads: Array<{ thread_id: string }> = input.contextId
          ? [{ thread_id: input.contextId }]
          : [];
        if (!input.contextId)
          for (let offset = 0; ;) {
            const page = await call<Array<{ thread_id: string }>>(
              "listThreads",
              {},
              { limit: 1000, offset },
            );
            if (!page.length) break;
            threads.push(...page);
            offset += page.length;
          }
        const tasks: Task[] = [];
        for (const thread of threads)
          for (const run of await listRuns(thread.thread_id)) {
            if (run.assistant_id !== assistantId || !run.metadata?.["skein_a2a"]) continue;
            const origin = readA2aOrigin(await context.deps.store.runs.getKwargs(run.run_id));
            if (origin && origin.rootId === undefined)
              tasks.push(await taskFor(run.run_id, input.historyLength));
          }
        const after = input.statusTimestampAfter
          ? Date.parse(input.statusTimestampAfter)
          : undefined;
        if (after !== undefined && !Number.isFinite(after))
          throw new RequestMalformedError("Invalid status timestamp.");
        const matching = tasks
          .filter(
            (task) =>
              (!input.status || task.status?.state === input.status) &&
              (after === undefined || Date.parse(task.status?.timestamp ?? "") > after),
          )
          .sort(
            (a, b) =>
              (b.status?.timestamp ?? "").localeCompare(a.status?.timestamp ?? "") ||
              b.id.localeCompare(a.id),
          );
        // The A2A spec defaults `includeArtifacts` to false to keep listings small.
        if (input.includeArtifacts !== true) for (const task of matching) task.artifacts = [];
        const offset = input.pageToken ? Number(input.pageToken) : 0;
        const pageSize = Math.min(input.pageSize ?? 50, 1000);
        if (!Number.isSafeInteger(offset) || offset < 0 || pageSize < 1)
          throw new RequestMalformedError("Invalid task pagination.");
        return {
          tasks: matching.slice(offset, offset + pageSize),
          pageSize,
          totalSize: matching.length,
          nextPageToken: matching.length > offset + pageSize ? String(offset + pageSize) : "",
        };
      },
      createTaskPushNotificationConfig: unsupported,
      getTaskPushNotificationConfig: unsupported,
      listTaskPushNotificationConfigs: unsupported,
      deleteTaskPushNotificationConfig: unsupported,
      async *resubscribe(): AsyncGenerator<StreamResponse> {
        yield await unsupported();
      },
    };
    const legacy = raw.method.includes("/");
    const transport = legacy
      ? new LegacyJsonRpcTransportHandler(handler)
      : new JsonRpcTransportHandler(handler);
    const result = await transport.handle(
      raw,
      new ServerCallContext({ requestedVersion: legacy ? "0.3" : "1.0" }),
    );
    if (Symbol.asyncIterator in result)
      return {
        kind: "sse",
        status: 200,
        events: (async function* () {
          try {
            for await (const event of result) yield formatSSEEvent(event);
          } catch (error) {
            yield formatSSEEvent({
              jsonrpc: "2.0",
              id: raw["id"] ?? null,
              error: toJsonRpcError(error),
            });
          }
        })(),
      };
    return { kind: "json", status: 200, body: result };
  };
}
