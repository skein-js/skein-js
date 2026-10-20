// Where a caller's durable `/memories/` files live in the store.
//
// Deep Agents' `StoreBackend` lets the deployment choose the namespace; this example chooses "one per
// authenticated user". That choice belongs to the application, not to skein — skein's part is that
// `langgraph_auth_user_id` is stamped by the server and stripped from anything a client sends, so the
// namespace below cannot be pointed at someone else's files.

import type { StoreBackendContext } from "deepagents";

/**
 * Store namespace components accept letters, digits and `-_.@+:~` only. Anything else in an identity
 * (a space, a slash) is percent-style escaped rather than dropped, so two different identities can
 * never collapse onto one namespace.
 */
function toNamespaceComponent(identity: string): string {
  return identity.replace(
    /[^A-Za-z0-9\-_.@+:]/g,
    (character) => `~${character.codePointAt(0)!.toString(16)}~`,
  );
}

/** `["memories", <user>]` — the caller's own memory, shared by every thread they start. */
export function memoryNamespaceFor(context: StoreBackendContext): string[] {
  const userId = context.config?.configurable?.["langgraph_auth_user_id"];
  if (typeof userId !== "string" || userId.length === 0) {
    // No principal means no `auth` is configured. Refuse rather than pool everyone's memory together.
    throw new Error(
      "Durable memory needs an authenticated user; configure `auth` in langgraph.json.",
    );
  }
  return ["memories", toNamespaceComponent(userId)];
}
