import type { AdmissionKey } from "@skein-js/core";

import type { ProtocolRequest } from "../create-handlers.js";

const requests = new WeakMap<ProtocolRequest, AdmissionKey>();
const ADMISSION = Symbol("background-admission");
export function bindRequestAdmission(request: ProtocolRequest, admission: AdmissionKey): void {
  requests.set(request, admission);
}
export function markRequestAdmission<T extends object>(request: ProtocolRequest, input: T): T {
  const admission = requests.get(request);
  return admission ? { ...input, [ADMISSION]: admission } : input;
}
export function readInputAdmission(input: object): AdmissionKey | undefined {
  return (input as { [ADMISSION]?: AdmissionKey })[ADMISSION];
}
