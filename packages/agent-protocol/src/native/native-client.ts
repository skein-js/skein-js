import type {
  AdmissionReceipt,
  AuthContext,
  Checkpoint,
  Run,
  RunResult,
  ThreadState,
} from "@skein-js/core";

import type { CancelRunOptions, CreateRunInput } from "../runs/run-service.js";

/** Host-bound authority ceiling; no value here is read from graph input or broker claims. */
export interface NativeSourceOptions {
  sourceId: string;
  allowedAssistants: readonly string[];
  /** Trusted dispatcher address. Enables complete durable lifecycle outcomes. */
  outcomeTarget?: string;
}

export interface NativeCallOptions {
  authContext?: AuthContext;
  idempotencyKey?: string;
  /** Trusted adapter's original command, before routing. Must include all caller-controlled meaning. */
  idempotencyInput?: unknown;
  correlationId?: string;
  /** Absolute execution deadline; retries never extend the first admission's budget. */
  deadlineAt?: string;
}

export type NativeStartInput = Omit<CreateRunInput, "command" | "webhook">;
export interface NativeResumeTarget {
  runId: string;
  checkpoint: Checkpoint;
  interruptIds?: readonly string[];
}
export type NativeResumeInput = Omit<
  NativeStartInput,
  | "input"
  | "checkpoint"
  | "checkpoint_id"
  | "if_thread_status"
  | "multitask_strategy"
  | "if_not_exists"
> & {
  thread_id: string;
  expected: NativeResumeTarget;
  resume: unknown;
};
export interface NativeCancellation {
  receipt: AdmissionReceipt;
  status: Run["status"];
  stopped: boolean;
}
export interface NativeClient {
  start(input: NativeStartInput, options?: NativeCallOptions): Promise<AdmissionReceipt>;
  resume(input: NativeResumeInput, options?: NativeCallOptions): Promise<AdmissionReceipt>;
  cancel(
    runId: string,
    options?: NativeCallOptions & CancelRunOptions,
  ): Promise<NativeCancellation>;
  getRun(runId: string, options?: NativeCallOptions): Promise<Run>;
  getState(threadId: string, options?: NativeCallOptions): Promise<ThreadState>;
  getResult(runId: string, options?: NativeCallOptions): Promise<RunResult>;
  getReceipt(idempotencyKey: string, options?: NativeCallOptions): Promise<AdmissionReceipt>;
}
