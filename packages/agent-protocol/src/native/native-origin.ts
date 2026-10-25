import type { AdmissionKey, RunKwargs } from "@skein-js/core";

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
