import { isProtocolAuthExempt, resolveAuthContext } from "../auth/authenticate-request.js";
import type { ProtocolHandler, ProtocolHandlers, ProtocolRequest } from "../create-handlers.js";
import type { ProtocolDeps } from "../deps.js";

const CONFIGURED_REQUEST = Symbol("configured-http-request");
const RUN_CREATES = new Set([
  "createWaitRun",
  "createStreamRun",
  "createBackgroundRun",
  "createStatelessRun",
  "createRunBatch",
  "postThreadStream",
  "postThreadCommands",
]);

function matchesHeader(name: string, pattern: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function selectHeaders(
  headers: ProtocolRequest["headers"],
  selector: NonNullable<ProtocolDeps["configurableHeaders"]>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value !== undefined &&
      !selector.excludes?.some((pattern) => matchesHeader(name, pattern)) &&
      (selector.includes === undefined ||
        selector.includes.some((pattern) => matchesHeader(name, pattern)))
        ? [[name.toLowerCase(), value]]
        : [],
    ),
  );
}

function withHeaderConfig(
  body: unknown,
  headers: Record<string, string>,
  commands = false,
): unknown {
  if (Array.isArray(body)) return body.map((entry) => withHeaderConfig(entry, headers));
  if (typeof body !== "object" || body === null) return body;
  const input = body as Record<string, unknown>;
  if (commands && ("method" in input || "id" in input)) {
    return { ...input, params: withHeaderConfig(input["params"] ?? {}, headers) };
  }
  const config = input["config"];
  // Invalid body/config types still reach the normal boundary validator unchanged.
  if (
    config !== undefined &&
    (typeof config !== "object" || config === null || Array.isArray(config))
  )
    return body;
  const fields = (config ?? {}) as Record<string, unknown>;
  const configurable = fields["configurable"];
  if (
    configurable !== undefined &&
    (typeof configurable !== "object" || configurable === null || Array.isArray(configurable))
  )
    return body;
  return {
    ...input,
    config: {
      ...fields,
      configurable: { ...headers, ...(configurable as Record<string, unknown> | undefined) },
    },
  };
}

/** Normalize before idempotency fingerprints; never use selected headers as an authenticated user. */
export function configureRequestHeaders(
  handlers: ProtocolHandlers,
  deps: ProtocolDeps,
): ProtocolHandlers {
  if (!deps.configurableHeaders && !deps.loggingHeaders) return handlers;
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => {
      if (!handler) return [name, handler];
      const configured: ProtocolHandler = async (original) => {
        const request = {
          ...original,
          ...(deps.configurableHeaders && RUN_CREATES.has(name)
            ? {
                body: withHeaderConfig(
                  original.body,
                  selectHeaders(original.headers, deps.configurableHeaders),
                  name === "postThreadCommands",
                ),
              }
            : {}),
          [CONFIGURED_REQUEST]: true,
        };
        if (
          deps.loggingHeaders &&
          !(CONFIGURED_REQUEST in original) &&
          !isProtocolAuthExempt(name as keyof ProtocolHandlers)
        ) {
          if (deps.auth) await resolveAuthContext(deps.auth, request);
          const selected = selectHeaders(request.headers, deps.loggingHeaders);
          const headers = Object.fromEntries(
            Object.entries(selected).map(([key, value]) => [
              key,
              /authorization|cookie|api[-_]?key|token|secret|password|credential/i.test(key)
                ? "[redacted]"
                : value,
            ]),
          );
          deps.logger?.info("HTTP request headers", { route: name, headers });
        }
        return handler(request);
      };
      return [name, configured];
    }),
  ) as unknown as ProtocolHandlers;
}
