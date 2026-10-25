import {
  serializeWireJson,
  type DeliveryCreate,
  type Delivery,
  type Run,
  type RunResult,
  type RunSettlement,
} from "@skein-js/core";

import {
  DEFAULT_RETAIN_HOURS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  remainingQueueAttempts,
} from "../deliveries/delivery-config.js";
import { buildDeliveryPayload } from "../deliveries/delivery-payload.js";
import type { ResolvedDeps } from "../deps.js";

import { readNativeOrigin, type NativeOrigin } from "./native-origin.js";

export function nativeDelivery(
  deps: ResolvedDeps,
  run: Run,
  origin: NativeOrigin,
  result?: RunResult,
): DeliveryCreate | undefined {
  if (!origin.outcomeTarget) return;
  const now = deps.clock().toISOString();
  let built: ReturnType<typeof buildDeliveryPayload>;
  try {
    built = buildDeliveryPayload({
      run,
      values: result?.values ?? {},
      runStartedAt: run.created_at,
      runEndedAt: now,
      ...(result?.interrupts ? { interrupts: result.interrupts } : {}),
      ...(result?.reply !== undefined ? { reply: result.reply } : {}),
      ...(run.error ? { error: run.error.message } : {}),
      maxPayloadBytes: deps.webhooks?.maxPayloadBytes,
    });
  } catch (error) {
    deps.logger.warn(`run ${run.run_id}: outcome result is not serializable`, error);
    built = {
      payload: { run_id: run.run_id, thread_id: run.thread_id, result_unavailable: true },
      truncated: true,
      bytes: 0,
    };
  }
  let payload: Record<string, unknown> = {
    ...built.payload,
    ...(built.truncated ? { payload_truncated: true } : {}),
    ...(!result ? { result_unavailable: true } : {}),
    command_id: origin.admission.key,
    ...(origin.correlationId ? { correlation_id: origin.correlationId } : {}),
    ...(result?.checkpoint ? { checkpoint: result.checkpoint } : {}),
  };
  if (
    Buffer.byteLength(serializeWireJson(payload)) >
    (deps.webhooks?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)
  ) {
    payload = {
      run_id: run.run_id,
      thread_id: run.thread_id,
      command_id: origin.admission.key,
      ...(origin.correlationId ? { correlation_id: origin.correlationId } : {}),
      result_ref: { run_id: run.run_id },
      ...(!result ? { result_unavailable: true } : {}),
      payload_truncated: true,
    };
    built.truncated = true;
  }
  return {
    delivery_id: origin.deliveryId,
    thread_id: run.thread_id,
    url: origin.outcomeTarget,
    payload,
    payload_truncated: built.truncated,
    next_attempt_at: now,
    expires_at: new Date(
      deps.clock().getTime() + (deps.webhooks?.retainHours ?? DEFAULT_RETAIN_HOURS) * 3_600_000,
    ).toISOString(),
  };
}

export async function settleNativeRun(
  deps: ResolvedDeps,
  run: Run,
  final: RunSettlement,
): Promise<Run["status"]> {
  const origin = readNativeOrigin(await deps.store.runs.getKwargs(run.run_id));
  if (!deps.store.runs.settle)
    throw new Error("Native settlement capability was removed after admission.");
  let result = final.result;
  if (result) {
    try {
      result = JSON.parse(serializeWireJson(result)) as RunResult;
    } catch (error) {
      deps.logger.warn(`run ${run.run_id}: retained result is unavailable`, error);
      result = undefined;
    }
  }
  const delivery = origin
    ? nativeDelivery(
        deps,
        { ...run, status: final.status, ...(final.error ? { error: final.error } : {}) },
        origin,
        result,
      )
    : undefined;
  const settled = await deps.store.runs.settle(run.run_id, {
    status: final.status,
    ...(final.error ? { error: final.error } : {}),
    ...(result ? { result } : {}),
    ...(delivery ? { delivery } : {}),
  });
  await scheduleNativeOutcome(deps, settled.delivery);
  return settled.run?.status ?? final.status;
}

/** Scheduling follows COMMIT; the existing outbox sweep owns recovery if Redis is unavailable. */
export async function scheduleNativeOutcome(
  deps: ResolvedDeps,
  delivery?: Delivery,
): Promise<void> {
  if (
    !delivery ||
    !deps.deliveryQueue ||
    delivery.status === "delivered" ||
    delivery.status === "dead"
  )
    return;
  try {
    await deps.deliveryQueue.schedule(
      { delivery_id: delivery.delivery_id },
      { attempts: remainingQueueAttempts(delivery.attempt, deps.webhooks?.retries) },
    );
  } catch (error) {
    deps.logger.warn(
      `native outcome ${delivery.delivery_id}: delivery scheduling failed; the outbox will recover`,
      error,
    );
  }
}
