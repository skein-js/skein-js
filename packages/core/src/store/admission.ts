import type { DeliveryCreate } from "./deliveries.js";
import type { RunCreate, RunCreateGuard, RunSettlement } from "./runs.js";

/** Stable acceptance identity; completion is observed on the referenced run. */
export interface AdmissionReceipt {
  idempotencyKey: string;
  threadId: string;
  runId: string;
}

/** Trusted, already authorized identity of one mutation. */
export interface AdmissionKey {
  scope: string;
  key: string;
  fingerprint: string;
  now: string;
  expiresAt: string;
}

export interface RunAdmission extends AdmissionKey {
  /** Cooperative pre-commit cancellation. Never persist it; a dispatched COMMIT can still win. */
  readonly signal?: AbortSignal;
  run: RunCreate;
  guard: RunCreateGuard;
  /** Reserve this interrupted predecessor once, independently of command-key retention. */
  expectedRunId?: string;
  /** All active runs observed when preparing interrupt/rollback; checked before any mutation. */
  displacements?: readonly { runId: string; settlement: RunSettlement }[];
}

export interface CancelAdmission extends AdmissionKey {
  runId: string;
  action?: "interrupt" | "rollback";
  delivery?: DeliveryCreate;
}

export interface DispatchClaim {
  runId: string;
  threadId: string;
  token: string;
  notBefore: string;
  kind: "run" | "cancel";
  action?: "interrupt" | "rollback";
}

/** Optional atomic admission capability. Implementations must never emulate it with CRUD calls. */
export interface AdmissionRepo {
  admitRun(input: RunAdmission): Promise<AdmissionReceipt>;
  admitCancel(input: CancelAdmission): Promise<AdmissionReceipt>;
  /**
   * Lease owned dispatches in bounded batches. Pending/running run intents become claimable again
   * after the lease, including after ACK: a queue may lose an acknowledged job. Cancel intents are
   * one-shot after ACK. Retain admission ownership until run deletion, even once terminal.
   */
  claimDispatches(query: {
    now: string;
    leaseUntil: string;
    limit?: number;
  }): Promise<DispatchClaim[]>;
  /** ACK only the matching lease token; it does not relinquish ownership of active run intents. */
  markDispatched(runId: string, token: string): Promise<void>;
}
