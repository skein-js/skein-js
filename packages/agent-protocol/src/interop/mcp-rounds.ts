import { randomBytes, randomUUID } from "node:crypto";

import {
  inputRequired,
  ProtocolError,
  type CallToolResult,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import {
  isSkeinHttpError,
  isTerminalRunStatus,
  serializeWireJson,
  type Run,
  type RunResult,
  type Thread,
} from "@skein-js/core";
import { z } from "zod";

import { resolveAuthContext } from "../auth/authenticate-request.js";
import type { ProtocolContext } from "../context.js";
import type { ProtocolHandlers, ProtocolRequest, ProtocolResponse } from "../create-handlers.js";
import { canonicalJson } from "../crypto/canonical-json.js";
import { sha256Hex } from "../crypto/hash.js";
import { verifyResumeTarget } from "../runs/resume-target.js";
import { withThreadExecution } from "../runs/thread-locks.js";

import { invalidMcpAnswer, mcpQuestions, mcpResumeAnswers } from "./mcp-elicitation.js";
import { markMcpBody, readMcpOrigin } from "./mcp-origin.js";

type McpToolResult = CallToolResult | InputRequiredResult;
const roundSchema = z.object({ threadId: z.string(), runId: z.string() });
type Round = z.infer<typeof roundSchema>;

export function mcpJsonBody<T>(response: ProtocolResponse): T {
  if (response.kind !== "json") throw new Error("Expected a JSON service response.");
  return response.body as T;
}
export function mcpToolResult(output: unknown, error = false): CallToolResult {
  const serialized = serializeWireJson(output);
  const normalized: unknown = JSON.parse(serialized);
  return {
    content: [{ type: "text", text: typeof output === "string" && error ? output : serialized }],
    ...(typeof normalized === "object" && normalized !== null
      ? { structuredContent: normalized }
      : {}),
    isError: error || (typeof output === "object" && output !== null && "__error__" in output),
  };
}

/** Transport state uses the existing owned/expiring records; graph policy stays in the graph. */
export async function callMcpTool(options: {
  context: ProtocolContext;
  table: ProtocolHandlers;
  request: ProtocolRequest;
  assistantId: string;
  args: Record<string, unknown>;
  modern: boolean;
  requestState?: unknown;
  inputResponses?: Record<string, unknown>;
  runtimeContext?: unknown;
}): Promise<McpToolResult> {
  const { context, table, request, assistantId, args, modern } = options;
  const { deps } = context;
  await table.getAssistant({ ...request, body: undefined, params: { assistant_id: assistantId } });
  const auth = deps.auth ? await resolveAuthContext(deps.auth, request) : undefined;
  const scope = `mcp-round-v1 ${canonicalJson([auth?.user.identity ?? "", assistantId, sha256Hex(canonicalJson(args))])}`;
  const resultsSupported = !!deps.store.runs.recordResult && !!deps.store.runs.getResult;
  const call = async <T>(name: "getThread" | "getRun", round: Round): Promise<T> =>
    mcpJsonBody<T>(
      await table[name]({
        ...request,
        body: undefined,
        params: { thread_id: round.threadId, run_id: round.runId },
      }),
    );
  const expiryFor = async (round: Round, durationMs: number): Promise<string> => {
    const thread = await call<Thread>("getThread", round);
    const ttl = await deps.store.threads.getTtl?.(round.threadId);
    const threadDeadline = thread.expires_at
      ? Date.parse(thread.expires_at)
      : typeof ttl?.ttl === "number"
        ? Date.parse(thread.created_at) + ttl.ttl * 60_000
        : Infinity;
    return new Date(
      Math.min(
        deps.clock().getTime() + durationMs,
        deps.clock().getTime() + (deps.idempotency?.retentionHours ?? 24) * 3_600_000,
        threadDeadline,
      ),
    ).toISOString();
  };
  const readOutput = async (round: Round): Promise<{ run: Run; result: RunResult | null }> => {
    await call("getThread", round);
    const run = await call<Run>("getRun", round);
    return { run, result: resultsSupported ? await deps.store.runs.getResult!(round.runId) : null };
  };
  const makeResult = async (round: Round, output: unknown): Promise<McpToolResult> => {
    const { run, result } = await readOutput(round);
    if (run.status === "cancelled") return mcpToolResult("The tool call was cancelled.", true);
    if (run.status !== "interrupted") return mcpToolResult(output);
    if (!modern)
      return mcpToolResult(
        "This tool paused to ask for human input, and this client can't answer it.",
        true,
      );
    if (!result || !result.checkpoint?.checkpoint_id)
      return mcpToolResult(
        "This tool paused to ask for human input, and this store cannot retain a resumable call. Use the run/thread APIs with a checkpoint-capable store.",
        true,
      );
    let questions: ReturnType<typeof mcpQuestions>;
    try {
      questions = mcpQuestions(result);
    } catch (error) {
      return mcpToolResult(
        `This tool needs input that can't be asked over MCP: ${error instanceof Error ? error.message : "unsupported interrupt"}`,
        true,
      );
    }
    if (!Object.keys(questions.inputRequests).length)
      return mcpToolResult(
        "This tool stopped at a static breakpoint. Resume it through the run/thread API.",
        true,
      );
    const state = randomBytes(32).toString("base64url");
    const claimId = randomUUID();
    const expiresAt = await expiryFor(round, 24 * 3_600_000);
    await deps.store.idempotency.claim({
      scope,
      key: state,
      fingerprint: "round",
      claim_id: claimId,
      now: deps.clock().toISOString(),
      expires_at: expiresAt,
    });
    await deps.store.idempotency.record(scope, state, claimId, {
      status: 200,
      body: round,
      thread_id: round.threadId,
      run_id: round.runId,
      expires_at: expiresAt,
    });
    return inputRequired({ inputRequests: questions.inputRequests, requestState: state });
  };
  const execute = async (body: object): Promise<{ round: Round; output: unknown }> => {
    // The round owns resume deduplication; a caller's key must not collide with a different round.
    const headers = { ...request.headers };
    if (modern) delete headers["idempotency-key"];
    const response = await table.createWaitRun({ ...request, headers, params: {}, body });
    const location = /^\/threads\/([^/]+)\/runs\/([^/]+)$/.exec(
      response.headers?.["content-location"] ?? "",
    );
    if (!location) throw new Error("The run response has no resource location.");
    return {
      round: { threadId: location[1]!, runId: location[2]! },
      output: mcpJsonBody(response),
    };
  };

  let state = options.requestState;
  let initialRound: Round | undefined;
  if (state === undefined) {
    const thread = modern
      ? mcpJsonBody<Thread>(await table.createThread({ ...request, params: {}, body: {} }))
      : undefined;
    const started = await execute(
      markMcpBody(
        {
          assistant_id: assistantId,
          ...(thread ? { thread_id: thread.thread_id } : {}),
          input: args,
          on_disconnect: "cancel",
          ...(options.runtimeContext !== undefined ? { context: options.runtimeContext } : {}),
        },
        {},
      ),
    );
    const output = await makeResult(started.round, started.output);
    if (!("resultType" in output) || !options.inputResponses) return output;
    state = output.requestState;
    initialRound = started.round;
  }
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state))
    invalidMcpAnswer("Invalid or expired requestState");
  const record = await deps.store.idempotency.get(scope, state);
  if (!record || Date.parse(record.expires_at) <= deps.clock().getTime())
    invalidMcpAnswer("Invalid or expired requestState");
  const round = roundSchema.parse(record.response?.body);
  const { run: previousRun, result } = await readOutput(round);
  // Re-evaluate a shortened thread lifetime even if its physical TTL sweep has not run yet.
  if (Date.parse(await expiryFor(round, 24 * 3_600_000)) <= deps.clock().getTime())
    invalidMcpAnswer("Invalid or expired requestState");
  if (
    !result ||
    !resultsSupported ||
    !result.checkpoint?.checkpoint_id ||
    previousRun.status !== "interrupted"
  )
    invalidMcpAnswer("Invalid or expired requestState");
  let questions: ReturnType<typeof mcpQuestions>;
  try {
    questions = mcpQuestions(result);
  } catch {
    invalidMcpAnswer("The pending input cannot be asked over MCP.");
  }
  let answers: Awaited<ReturnType<typeof mcpResumeAnswers>>;
  try {
    answers = await mcpResumeAnswers(questions.prompts, options.inputResponses);
  } catch (error) {
    if (initialRound)
      await table
        .deleteThread({ ...request, params: { thread_id: initialRound.threadId }, body: undefined })
        .catch(() => undefined);
    throw error;
  }
  if ("missing" in answers)
    return inputRequired({ requestState: state, inputRequests: questions.inputRequests });
  const fingerprint = sha256Hex(canonicalJson(answers));
  const answerScope = `${scope} answers`;
  const claimId = randomUUID();
  const claimed = await deps.store.idempotency.claim({
    scope: answerScope,
    key: state,
    fingerprint,
    claim_id: claimId,
    now: deps.clock().toISOString(),
    expires_at: record.expires_at,
  });
  if (claimed.record.fingerprint !== fingerprint)
    invalidMcpAnswer("This round already accepted different answers.");
  const replay = async (recorded: typeof claimed.record): Promise<McpToolResult> => {
    // Physical record erasure is best-effort. Authorization and resource existence must still
    // hold for the run which produced the cached output, not only its interrupted predecessor.
    if (recorded.run_id) await readOutput({ threadId: round.threadId, runId: recorded.run_id });
    return recorded.response!.body as McpToolResult;
  };
  if (!claimed.claimed && claimed.record.response) return replay(claimed.record);
  // The association is saved with pending admission, before invocation. Never guess that a lost
  // inline request can be retried as a new resume, even when its response record was not written.
  const attempts = await deps.store.runs.listByThread(round.threadId);
  const existing = [] as Run[];
  for (const attempt of attempts) {
    const origin = readMcpOrigin(await deps.store.runs.getKwargs(attempt.run_id));
    if (origin?.roundState === state) {
      if (origin.answerFingerprint !== fingerprint)
        invalidMcpAnswer("This round already accepted different answers.");
      existing.push(attempt);
    }
  }
  let response: McpToolResult;
  let outputRound = round;
  if (existing.length) {
    const attempt = existing[0]!;
    const completed = await readOutput({ threadId: round.threadId, runId: attempt.run_id });
    if (!isTerminalRunStatus(completed.run.status) || !completed.result)
      throw new ProtocolError(
        -32000,
        `The prior inline attempt ${attempt.run_id} is unfinished. Inspect its run before choosing recovery; the answer was not resubmitted.`,
      );
    outputRound = { threadId: round.threadId, runId: attempt.run_id };
    response = await makeResult(
      outputRound,
      completed.run.error ? { __error__: completed.run.error } : completed.result.values,
    );
  } else if (!claimed.claimed) {
    throw new ProtocolError(-32000, "This answer is being accepted. Retry shortly.");
  } else if ("error" in answers) response = mcpToolResult(answers.error, true);
  else {
    try {
      await withThreadExecution(
        context.executionLocks,
        deps.threadExecutionGate,
        round.threadId,
        async () => {
          try {
            await verifyResumeTarget(deps, round.threadId, "", {
              expectedRunId: round.runId,
              checkpoint: result.checkpoint,
              interruptIds: questions.prompts.map((prompt) => prompt.id),
            });
          } catch (error) {
            if (isSkeinHttpError(error) && error.code === "stale_resume")
              invalidMcpAnswer("Invalid or expired requestState");
            throw error;
          }
        },
      );
      const resumed = await execute(
        markMcpBody(
          {
            assistant_id: assistantId,
            thread_id: round.threadId,
            command: { resume: answers.resume },
            if_thread_status: ["interrupted"],
            multitask_strategy: "reject",
            on_disconnect: "cancel",
            ...(options.runtimeContext !== undefined ? { context: options.runtimeContext } : {}),
          },
          {
            roundState: state,
            answerFingerprint: fingerprint,
            expectedRunId: round.runId,
            checkpoint: result.checkpoint,
            interruptIds: questions.prompts.map((prompt) => prompt.id),
          },
        ),
      );
      outputRound = resumed.round;
      response = await makeResult(outputRound, resumed.output);
    } catch (error) {
      // Releasing is safe only if no provenance-bearing attempt was admitted. Preserve the claim
      // otherwise so a transport retry cannot submit a second answer after an ambiguous failure.
      const runs = await deps.store.runs.listByThread(round.threadId);
      let admitted = false;
      for (const candidate of runs)
        if (readMcpOrigin(await deps.store.runs.getKwargs(candidate.run_id))?.roundState === state)
          admitted = true;
      if (!admitted) await deps.store.idempotency.release(answerScope, state, claimId);
      throw error;
    }
  }
  const acceptedState = state;
  return withThreadExecution(
    context.executionLocks,
    deps.threadExecutionGate,
    round.threadId,
    async () => {
      // Re-check resources after execution: deletion/revocation wins. Concurrent rediscovery must
      // publish the same next-round state rather than replacing another response's opaque token.
      await readOutput(round);
      await readOutput(outputRound);
      const recorded = await deps.store.idempotency.get(answerScope, acceptedState);
      if (recorded?.response) return replay(recorded);
      const expiresAt = await expiryFor(round, 10 * 60_000);
      await deps.store.idempotency.record(answerScope, acceptedState, claimed.record.claim_id, {
        status: 200,
        body: response,
        thread_id: round.threadId,
        run_id: outputRound.runId,
        expires_at: expiresAt,
      });
      await deps.store.idempotency.record(scope, acceptedState, record.claim_id, {
        status: 200,
        body: round,
        thread_id: round.threadId,
        run_id: round.runId,
        expires_at: expiresAt,
      });
      return response;
    },
  );
}
