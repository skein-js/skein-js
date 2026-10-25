import { createHash, randomUUID } from "node:crypto";

import {
  isTerminalRunStatus,
  serializeWireJson,
  SkeinHttpError,
  type AdmissionKey,
  type AdmissionReceipt,
} from "@skein-js/core";
import { z } from "zod";

import { createAuthScopedStore } from "../auth/auth-scoped-store.js";
import type { ProtocolContext } from "../context.js";
import { canonicalJson } from "../crypto/canonical-json.js";
import type { CreateRunInput } from "../runs/run-service.js";
import { withThreadExecution } from "../runs/thread-locks.js";
import { createProtocolServiceFromContext } from "../service.js";
import { runCreateSchema } from "../validation/schemas.js";

import type {
  NativeCallOptions,
  NativeClient,
  NativeSourceOptions,
  NativeStartInput,
} from "./native-client.js";
import {
  assertNativeDeadline,
  createNativeAdmissionDeadline,
  markNativeInput,
  markRecoveringCancellation,
  type NativeOrigin,
} from "./native-origin.js";
import { nativeDelivery } from "./native-outcome.js";
import { verifyNativeResumeTarget } from "./native-resume-target.js";
import { readNativeState } from "./native-state.js";

const sourceSchema = z
  .object({
    sourceId: z.string().min(1).max(255),
    allowedAssistants: z.array(z.string().min(1)),
    outcomeTarget: z.string().url().optional(),
  })
  .strict();
const optionsSchema = z
  .object({
    idempotencyKey: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x20-\x7e]+$/)
      .optional(),
    correlationId: z.string().max(255).optional(),
    deadlineAt: z.string().datetime({ offset: true }).optional(),
    authContext: z
      .object({
        user: z
          .object({
            identity: z.string().min(1),
            display_name: z.string(),
            is_authenticated: z.boolean(),
            permissions: z.array(z.string()),
          })
          .passthrough(),
        scopes: z.array(z.string()),
      })
      .optional(),
  })
  .passthrough();

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw SkeinHttpError.badRequest("Invalid native operation.", {
      code: "invalid_native_input",
      details: parsed.error.issues,
    });
  return parsed.data;
}

function threadIdForAdmission(scope: string, key: string): string {
  const hex = createHash("sha256")
    .update(JSON.stringify([scope, key]))
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** The runtime owns this constructor; its only public entry is runtime.createNativeClient. */
export function createNativeClientFromContext(
  context: ProtocolContext,
  sourceInput: NativeSourceOptions,
): NativeClient {
  const source = parse(sourceSchema, sourceInput);
  const { deps } = context;
  const optionsFor = (input: NativeCallOptions = {}): NativeCallOptions => {
    const options = parse(optionsSchema, input);
    if (deps.auth?.enabled && !options.authContext?.user.is_authenticated)
      throw SkeinHttpError.unauthorized(
        "Native callers must supply adapter-authenticated context.",
      );
    return options;
  };
  const scopeFor = (options: NativeCallOptions) =>
    `native ${JSON.stringify([source.sourceId, options.authContext?.user.identity ?? ""])}`;
  const authorize = async (
    action: "create_run" | "read" | "update",
    value: Record<string, unknown>,
    options: NativeCallOptions,
  ): Promise<ProtocolContext> => {
    const decision = await deps.auth?.authorize({
      resource: "threads",
      action,
      value,
      context: options.authContext,
    });
    return {
      ...context,
      authUser: options.authContext?.user,
      authScopes: options.authContext?.scopes,
      deps:
        decision?.filters && deps.auth
          ? {
              ...deps,
              store: createAuthScopedStore(deps.store, deps.auth, decision.filters, "threads"),
            }
          : deps,
    };
  };
  const allowAssistant = async (assistantId: string): Promise<void> => {
    const assistant = await deps.store.assistants.get(assistantId);
    if (
      !source.allowedAssistants.includes(assistantId) &&
      !(assistant && source.allowedAssistants.includes(assistant.graph_id))
    )
      throw SkeinHttpError.forbidden("Assistant is outside this source's allowlist.", {
        code: "assistant_not_allowed",
      });
  };
  const ownedRun = async (
    runId: string,
    action: "read" | "update" | "create_run",
    options: NativeCallOptions,
  ) => {
    const run = await deps.store.runs.get(runId);
    if (!run) throw SkeinHttpError.notFound("Run not found.");
    await allowAssistant(run.assistant_id);
    // Resolve canonical identities before invoking check-only authorizers.
    const targeted = await authorize(
      action,
      { run_id: runId, thread_id: run.thread_id, assistant_id: run.assistant_id },
      options,
    );
    const service = createProtocolServiceFromContext(targeted);
    await service.threads.get(run.thread_id);
    await service.runs.get(runId);
    return { run, scoped: targeted };
  };
  const lookup = async (
    key: string,
    options: NativeCallOptions,
    action: "read" | "create_run" | "update" = "read",
    fingerprint?: string,
  ): Promise<AdmissionReceipt | undefined> => {
    const record = await deps.store.idempotency.get(scopeFor(options), key);
    if (!record || Date.parse(record.expires_at) <= deps.clock().getTime()) return;
    if (fingerprint && record.fingerprint !== fingerprint)
      throw SkeinHttpError.conflict("The operation key was already used for different input.", {
        code: "idempotency_key_reused",
      });
    if (!record.run_id || !record.thread_id)
      throw SkeinHttpError.conflict("Admission is in progress.", {
        code: "idempotency_key_in_flight",
      });
    await ownedRun(record.run_id, action, options);
    return { idempotencyKey: key, threadId: record.thread_id, runId: record.run_id };
  };
  const admissionKey = (operation: unknown, options: NativeCallOptions): AdmissionKey => {
    let fingerprint: string;
    try {
      fingerprint = createHash("sha256")
        .update(
          canonicalJson(
            JSON.parse(
              serializeWireJson(
                options.idempotencyInput !== undefined ? options.idempotencyInput : operation,
              ),
            ),
          ),
        )
        .digest("hex");
    } catch {
      throw SkeinHttpError.badRequest("Native input must be JSON serializable.", {
        code: "invalid_native_input",
      });
    }
    return {
      scope: scopeFor(options),
      key: options.idempotencyKey ?? randomUUID(),
      fingerprint,
      now: deps.clock().toISOString(),
      expiresAt: new Date(
        deps.clock().getTime() + (deps.idempotency?.retentionHours ?? 24) * 3_600_000,
      ).toISOString(),
    };
  };
  const requireAdmission = () => {
    if (!deps.store.admission || !deps.store.runs.settle || !deps.store.runs.getResult)
      throw SkeinHttpError.notImplemented(
        "This driver does not provide atomic native admission and settlement.",
        { code: "native_admission_unsupported" },
      );
    return deps.store.admission;
  };
  const start = async (
    raw: NativeStartInput,
    options: NativeCallOptions,
    origin: NativeOrigin,
    admissionSignal?: AbortSignal,
  ): Promise<AdmissionReceipt> => {
    requireAdmission();
    assertNativeDeadline(origin.deadlineAt, deps.clock());
    const input = parse(runCreateSchema, raw) as CreateRunInput;
    await allowAssistant(input.assistant_id);
    if (!(await deps.store.assistants.get(input.assistant_id)))
      throw SkeinHttpError.notFound(`Assistant "${input.assistant_id}" not found.`);
    const threadId =
      input.thread_id ?? threadIdForAdmission(origin.admission.scope, origin.admission.key);
    const scoped = await authorize("create_run", { ...input, thread_id: threadId }, options);
    const service = createProtocolServiceFromContext(scoped);
    admissionSignal?.throwIfAborted();
    assertNativeDeadline(origin.deadlineAt, deps.clock());
    const deadline = createNativeAdmissionDeadline(origin.deadlineAt, deps.clock, admissionSignal);
    try {
      if (!input.thread_id || input.if_not_exists === "create")
        await service.threads.create({
          thread_id: threadId,
          metadata: input.metadata,
          ifExists: "do_nothing",
        });
      const run = await service.runs.createBackground(
        threadId,
        markNativeInput(
          { ...input, ...(origin.outcomeTarget ? { webhook: origin.outcomeTarget } : {}) },
          { ...origin, ownsThread: input.thread_id === undefined },
          deadline.signal,
        ),
      );
      return { idempotencyKey: origin.admission.key, threadId: run.thread_id, runId: run.run_id };
    } catch (error) {
      // A failed Redis enqueue after COMMIT is still accepted: the owned intent is recoverable.
      const accepted = await lookup(
        origin.admission.key,
        options,
        "create_run",
        origin.admission.fingerprint,
      );
      if (accepted) return accepted;
      throw error;
    } finally {
      deadline.dispose();
    }
  };
  return {
    start: async (input, callOptions) => {
      const options = optionsFor(callOptions);
      if (!input || typeof input !== "object")
        throw SkeinHttpError.badRequest("Invalid native operation.", {
          code: "invalid_native_input",
        });
      if ("command" in input || "webhook" in input)
        throw SkeinHttpError.badRequest(
          "Use resume for commands and source configuration for outcomes.",
          { code: "invalid_native_input" },
        );
      const admission = admissionKey({ operation: "start", input }, options);
      const previous = await lookup(admission.key, options, "create_run", admission.fingerprint);
      if (previous) return previous;
      return start(input, options, {
        admission,
        sourceId: source.sourceId,
        deliveryId: randomUUID(),
        ...(source.outcomeTarget ? { outcomeTarget: source.outcomeTarget } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
        ...(options.deadlineAt ? { deadlineAt: new Date(options.deadlineAt).toISOString() } : {}),
      });
    },
    resume: async (input, callOptions) => {
      const options = optionsFor(callOptions);
      const admission = admissionKey({ operation: "resume", input }, options);
      const previous = await lookup(admission.key, options, "create_run", admission.fingerprint);
      if (previous) return previous;
      if (!input || typeof input !== "object")
        throw SkeinHttpError.badRequest("Invalid native operation.", {
          code: "invalid_native_input",
        });
      if (
        !("resume" in input) ||
        [
          "webhook",
          "command",
          "input",
          "checkpoint",
          "checkpoint_id",
          "if_thread_status",
          "multitask_strategy",
          "if_not_exists",
        ].some((field) => field in input)
      )
        throw SkeinHttpError.badRequest(
          "Resume requires a resume value; outcomes belong to source configuration.",
          { code: "invalid_native_input" },
        );
      const expected = parse(
        z
          .object({
            runId: z.string().min(1),
            checkpoint: z
              .object({
                checkpoint_id: z.string().min(1),
                checkpoint_ns: z.string().default(""),
                thread_id: z.string(),
                checkpoint_map: z.record(z.string()).nullable().default(null),
              })
              .strict(),
            interruptIds: z.array(z.string().min(1)).nonempty().optional(),
          })
          .strict(),
        input.expected,
      );
      const { run } = await ownedRun(expected.runId, "create_run", options);
      if (run.thread_id !== input.thread_id || expected.checkpoint.thread_id !== input.thread_id)
        throw SkeinHttpError.conflict("Resume target belongs to another thread.", {
          code: "stale_resume",
        });
      await allowAssistant(input.assistant_id);
      return withThreadExecution(
        context.executionLocks,
        deps.threadExecutionGate,
        run.thread_id,
        async (leaseSignal) => {
          try {
            await verifyNativeResumeTarget(deps, run.thread_id, "", expected, leaseSignal);
            leaseSignal?.throwIfAborted();
            const { expected: _expected, resume, ...rest } = input;
            return await start(
              {
                ...rest,
                command: { resume },
                checkpoint: expected.checkpoint,
                if_thread_status: ["interrupted"],
                multitask_strategy: "reject",
              } as NativeStartInput,
              options,
              {
                admission,
                sourceId: source.sourceId,
                deliveryId: randomUUID(),
                expected,
                ...(source.outcomeTarget ? { outcomeTarget: source.outcomeTarget } : {}),
                ...(options.correlationId ? { correlationId: options.correlationId } : {}),
                ...(options.deadlineAt
                  ? { deadlineAt: new Date(options.deadlineAt).toISOString() }
                  : {}),
              },
              leaseSignal,
            );
          } catch (error) {
            if (leaseSignal?.aborted)
              throw SkeinHttpError.conflict(
                "The execution lease was lost before admission committed.",
                { code: "execution_lease_lost", cause: error },
              );
            throw error;
          }
        },
      );
    },
    cancel: async (runId, callOptions) => {
      const options = optionsFor(callOptions) as NativeCallOptions & {
        action?: "interrupt" | "rollback";
        wait?: boolean;
      };
      parse(
        z
          .object({
            action: z.enum(["interrupt", "rollback"]).optional(),
            wait: z.boolean().optional(),
          })
          .passthrough(),
        options,
      );
      const { run, scoped } = await ownedRun(runId, "update", options);
      if (options.wait && deps.abortChannel && !deps.threadExecutionGate)
        throw SkeinHttpError.notImplemented(
          "Remote execution stop requires a thread execution gate.",
          {
            code: "execution_stop_unsupported",
          },
        );
      const admission = admissionKey(
        { operation: "cancel", runId, action: options.action ?? "interrupt" },
        options,
      );
      const prior = await lookup(admission.key, options, "update", admission.fingerprint);
      let receipt = prior;
      if (!receipt) {
        assertNativeDeadline(options.deadlineAt, deps.clock());
        const origin = (await import("./native-origin.js")).readNativeOrigin(
          await deps.store.runs.getKwargs(runId),
        );
        const delivery = origin
          ? nativeDelivery(deps, { ...run, status: "cancelled" }, origin)
          : undefined;
        requireAdmission();
        assertNativeDeadline(options.deadlineAt, deps.clock());
        receipt = await scoped.deps.store.admission!.admitCancel({
          ...admission,
          runId,
          action: options.action,
          ...(delivery ? { delivery } : {}),
        });
      }
      const service = createProtocolServiceFromContext(scoped);
      const latest = await service.runs.cancel(
        runId,
        markRecoveringCancellation({ action: options.action, wait: false }),
      );
      // A best-effort rollback may have swallowed a gate failure. The requested wait is not proof.
      if (options.wait) {
        try {
          await withThreadExecution(
            context.executionLocks,
            deps.threadExecutionGate,
            run.thread_id,
            async () => undefined,
          );
        } catch (error) {
          throw new SkeinHttpError(
            503,
            "Cancellation was admitted, but execution stop could not be confirmed.",
            {
              code: "execution_stop_unconfirmed",
              cause: error,
            },
          );
        }
      }
      const stopped =
        options.wait === true ||
        (!deps.threadExecutionGate && !deps.abortChannel && !context.control.isTracking(runId));
      return { receipt, status: latest.status, stopped };
    },
    getRun: async (runId, callOptions) =>
      (await ownedRun(runId, "read", optionsFor(callOptions))).run,
    getState: async (threadId, callOptions) => {
      const options = optionsFor(callOptions);
      return readNativeState(context, threadId, allowAssistant, (target) =>
        authorize("read", target, options),
      );
    },
    getResult: async (runId, callOptions) => {
      const { run, scoped } = await ownedRun(runId, "read", optionsFor(callOptions));
      if (!isTerminalRunStatus(run.status))
        throw SkeinHttpError.conflict("Run result is not ready.", { code: "run_result_pending" });
      if (!scoped.deps.store.runs.getResult)
        throw SkeinHttpError.notImplemented("The driver has no retained result capability.", {
          code: "run_result_unsupported",
        });
      const result = await scoped.deps.store.runs.getResult(runId);
      if (!result)
        throw SkeinHttpError.unprocessable("The run has no retained result.", {
          code: "run_result_unavailable",
        });
      return result;
    },
    getReceipt: async (key, callOptions) => {
      const receipt = await lookup(key, optionsFor(callOptions));
      if (!receipt)
        throw SkeinHttpError.notFound("Acceptance receipt is unavailable.", {
          code: "receipt_unavailable",
        });
      return receipt;
    },
  };
}
