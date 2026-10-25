import type { NativeResumeInput, NativeStartInput } from "@skein-js/agent-protocol";
import type { Run } from "@skein-js/core";

/** The BullMQ adapter's wire format. Authority, destinations and deadlines belong to the host. */
export type BullMqCommand = { version: 1; commandId: string; correlationId?: string } & (
  | { operation: "start"; input: NativeStartInput }
  | { operation: "resume"; input: NativeResumeInput }
  | { operation: "cancel"; runId: string; action?: "interrupt" | "rollback"; wait?: boolean }
  | { operation: "run.get"; runId: string; offset?: number; digest?: string }
  | { operation: "state.get"; threadId: string; offset?: number; digest?: string }
  | { operation: "result.get"; runId: string; offset?: number; digest?: string }
  | { operation: "receipt.get"; idempotencyKey: string }
);

/** Durable receiver deduplication uses eventId, including after BullMQ jobs have been removed. */
export interface BullMqOutcome {
  version: 1;
  operation: "run.settled";
  eventId: string;
  commandId: string;
  correlationId?: string;
  runId: string;
  threadId: string;
  status: Run["status"];
  resultRef: { runId: string };
  truncated: boolean;
  outcome?: unknown;
}

/** Byte offsets address a base64 encoded slice of the serialized whole value. */
export interface BullMqChunk {
  encoding: "base64";
  digest: string;
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
  content: string;
}
