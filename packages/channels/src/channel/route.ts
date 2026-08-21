// The routes a configured channel adds to the protocol table.

import type { RouteBinding } from "@skein-js/agent-protocol";

/**
 * One `POST /channels/:channel` binding per configured channel — and **none at all** when none is
 * configured.
 *
 * Built here and appended to the resolved route table rather than declared in `skeinRoutes`, for two
 * reasons that pull the same way.
 *
 * **It carries no `RouteGroup`.** A group is a member of a closed union that can never be withdrawn,
 * and it is 1:1 with LangGraph's `http.disable_*` flags — so a `"channels"` member would also need a
 * skein-only `disable_channels` in the *un-namespaced* `http` block, which is exactly the collision
 * the reserved `skein.*` namespace exists to avoid. The run-scoped delivery routes declined a group
 * for the same reason. `RouteBinding.group` is optional and means "never disabled", which is the
 * right answer here.
 *
 * **And a disable flag would be weaker than what this does anyway.** The routes are absent from the
 * table entirely unless a channel is configured, so there is nothing to disable: a deployment that
 * never configures one cannot tell the feature exists, which is the actual goal.
 *
 * A literal path per channel rather than one `:channel` parameter route, so an unconfigured name is a
 * transport-level 404 — the router never dispatches it — instead of reaching a handler that has to
 * decide whether the name is unknown or the request is malformed.
 */
export function channelRouteBindings(names: readonly string[]): RouteBinding[] {
  return names.map((name) => ({
    method: "post" as const,
    path: `/channels/${name}`,
    handler: "handleInboundEvent" as const,
  }));
}
