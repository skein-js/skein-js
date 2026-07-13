// Thread-scoped streaming and the human-in-the-loop command surface. `POST /threads/{id}/stream`
// starts a streaming run on an existing thread; `GET /threads/{id}/stream` joins its current run;
// `POST /threads/{id}/commands` resumes an interrupted thread by starting a *fresh* run carrying a
// LangGraph `Command` — which the concurrency guard allows because the interrupted run is terminal.

import {
  isTerminalRunStatus,
  SkeinHttpError,
  type Config,
  type Metadata,
  type StreamMode,
} from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import type { CreateRunInput, RunService, StartedStream } from "../runs/run-service.js";

/** Body for `POST /threads/{id}/stream` — a run request without the thread id (it's in the path). */
export interface ThreadStreamInput {
  assistant_id: string;
  input?: unknown;
  config?: Config;
  context?: unknown;
  stream_mode?: StreamMode | StreamMode[];
  metadata?: Metadata;
}

/** Body for `POST /threads/{id}/commands` — a resume/goto/update command for an interrupted thread. */
export interface CommandInput {
  assistant_id?: string;
  command?: { resume?: unknown; update?: unknown; goto?: unknown };
  /** Shorthand for `command.resume`. */
  resume?: unknown;
  stream_mode?: StreamMode | StreamMode[];
  config?: Config;
  context?: unknown;
  metadata?: Metadata;
}

export interface ThreadStreamService {
  stream(threadId: string, input: ThreadStreamInput): Promise<StartedStream>;
  joinStream(threadId: string, afterSeq?: number): Promise<StartedStream>;
  command(threadId: string, input: CommandInput): Promise<StartedStream>;
}

export function createThreadStreamService(
  ctx: ProtocolContext,
  runs: RunService,
): ThreadStreamService {
  const { deps } = ctx;

  const requireThread = async (threadId: string) => {
    const thread = await deps.store.threads.get(threadId);
    if (!thread) throw SkeinHttpError.notFound(`Thread "${threadId}" not found.`);
    return thread;
  };

  const latestRunAssistant = async (threadId: string): Promise<string | undefined> => {
    const threadRuns = await deps.store.runs.listByThread(threadId);
    const latest = [...threadRuns].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return latest?.assistant_id;
  };

  return {
    async stream(threadId, input) {
      await requireThread(threadId);
      return runs.createStream({ ...input, thread_id: threadId });
    },

    async joinStream(threadId, afterSeq) {
      await requireThread(threadId);
      const threadRuns = await deps.store.runs.listByThread(threadId);
      const sorted = [...threadRuns].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const target = sorted.find((run) => !isTerminalRunStatus(run.status)) ?? sorted[0];
      if (!target) throw SkeinHttpError.notFound(`Thread "${threadId}" has no runs to stream.`);
      return { runId: target.run_id, frames: await runs.join(target.run_id, afterSeq) };
    },

    async command(threadId, input) {
      const thread = await requireThread(threadId);
      if (thread.status !== "interrupted") {
        throw SkeinHttpError.conflict(`Thread "${threadId}" is not interrupted.`, {
          code: "thread_not_interrupted",
        });
      }
      const command =
        input.command ?? (input.resume !== undefined ? { resume: input.resume } : undefined);
      if (!command) {
        throw SkeinHttpError.badRequest("A command must provide `command` or `resume`.");
      }
      const assistantId = input.assistant_id ?? (await latestRunAssistant(threadId));
      if (!assistantId) {
        throw SkeinHttpError.badRequest(
          "Cannot resume: no assistant_id and no prior run on the thread.",
        );
      }
      const runInput: CreateRunInput = {
        thread_id: threadId,
        assistant_id: assistantId,
        command,
        stream_mode: input.stream_mode,
        config: input.config,
        context: input.context,
        metadata: input.metadata,
      };
      return runs.createStream(runInput);
    },
  };
}
