import { isSkeinHttpError, type TelemetrySink } from "@skein-js/core";

import type { ProtocolHandler, ProtocolHandlers, ProtocolRequest } from "../create-handlers.js";

const INTERNAL_REQUEST = Symbol("internal-protocol-request");

/** Interop service composition is not another network request. */
export function internalProtocolHandlers(handlers: ProtocolHandlers): ProtocolHandlers {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      handler
        ? (request: ProtocolRequest) => handler({ ...request, [INTERNAL_REQUEST]: true })
        : undefined,
    ]),
  ) as unknown as ProtocolHandlers;
}

export function instrumentHttpHandlers(
  handlers: ProtocolHandlers,
  telemetry: TelemetrySink,
): ProtocolHandlers {
  if (!telemetry.onHttpEvent) return handlers;
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => {
      if (!handler) return [name, handler];
      const measured: ProtocolHandler = async (request) => {
        if (INTERNAL_REQUEST in request) return handler(request);
        const started = performance.now();
        let status = 500;
        try {
          const response = await handler(request);
          status = response.status;
          return response;
        } catch (error) {
          status = isSkeinHttpError(error) ? error.status : 500;
          throw error;
        } finally {
          telemetry.onHttpEvent?.({
            type: "request.finished",
            method: request.method,
            route: name,
            status,
            durationMs: performance.now() - started,
          });
        }
      };
      return [name, measured];
    }),
  ) as unknown as ProtocolHandlers;
}
