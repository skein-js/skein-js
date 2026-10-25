import { SkeinHttpError, type AdmissionKey, type RunKwargs } from "@skein-js/core";

import type { CancelRunOptions } from "../runs/run-service.js";

import type { NativeResumeTarget } from "./native-client.js";

export interface NativeOrigin {
  admission: AdmissionKey;
  sourceId: string;
  deliveryId: string;
  outcomeTarget?: string;
  correlationId?: string;
  deadlineAt?: string;
  ownsThread?: boolean;
  expected?: NativeResumeTarget;
}
export function assertNativeDeadline(deadlineAt: string | undefined, now: Date): void {
  if (deadlineAt && Date.parse(deadlineAt) <= now.getTime())
    throw SkeinHttpError.unprocessable("The command's admission deadline has expired.", {
      code: "deadline_expired",
    });
}
/** Carry the absolute budget through driver lock waits, using the existing pre-COMMIT signal. */
export function createNativeAdmissionDeadline(
  deadlineAt: string | undefined,
  clock: () => Date,
  parent?: AbortSignal,
) {
  if (!deadlineAt) return { signal: parent, dispose: () => undefined };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const remaining = Date.parse(deadlineAt) - clock().getTime();
    if (remaining <= 0) {
      controller.abort(
        SkeinHttpError.unprocessable("The command's admission deadline has expired.", {
          code: "deadline_expired",
        }),
      );
      return;
    }
    // Long absolute deadlines must not overflow Node's timer range.
    timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    timer.unref();
  };
  arm();
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
const NATIVE_ORIGIN = Symbol("native-origin");
const ADMISSION_SIGNAL = Symbol("admission-signal");
export function markNativeInput<T extends object>(
  input: T,
  origin: NativeOrigin,
  signal?: AbortSignal,
): T {
  return { ...input, [NATIVE_ORIGIN]: origin, ...(signal ? { [ADMISSION_SIGNAL]: signal } : {}) };
}
export function readAdmissionSignal(input: object): AbortSignal | undefined {
  return (input as { [ADMISSION_SIGNAL]?: AbortSignal })[ADMISSION_SIGNAL];
}
export function nativeKwargs(input: object): object {
  return NATIVE_ORIGIN in input ? { native_origin: input[NATIVE_ORIGIN] } : {};
}
export function readNativeOrigin(kwargs: RunKwargs | null): NativeOrigin | undefined {
  return (kwargs as (RunKwargs & { native_origin?: NativeOrigin }) | null)?.native_origin;
}
const recoveredCancels = new WeakSet<object>();
export function markRecoveringCancellation(options: CancelRunOptions): CancelRunOptions {
  recoveredCancels.add(options);
  return options;
}
export function isRecoveringCancellation(options?: CancelRunOptions): boolean {
  return options !== undefined && recoveredCancels.has(options);
}
