import { z } from "zod";

import type { RouteBinding } from "../http/routes.js";

export const metricsQuerySchema = z.object({ format: z.enum(["prometheus", "json"]).optional() });

/** Native HTTP diagnostics share their dispatch predicates with OpenAPI. */
const nativeDiagnostics = [
  {
    name: "docs",
    path: "/docs",
    status: 200,
    summary: "API reference",
    content: { "text/html": { schema: { type: "string" } } },
    enabled: (routes: readonly RouteBinding[]) =>
      routes.some((route) => route.handler === "getOpenApi"),
  },
  {
    name: "metrics",
    path: "/metrics",
    status: 200,
    query: metricsQuerySchema,
    summary: "Collect host OpenTelemetry metrics",
    content: {
      "text/plain": { schema: { type: "string" } },
      "application/json": { schema: { type: "object" } },
    },
    enabled: (routes: readonly RouteBinding[]) => routes.some((route) => route.group === "meta"),
  },
] as const;

export function enabledNativeDiagnostics(routes: readonly RouteBinding[]) {
  return nativeDiagnostics.filter((diagnostic) => diagnostic.enabled(routes));
}
export function matchNativeDiagnostic(
  method: string,
  url: string,
  routes: readonly RouteBinding[],
) {
  if (method !== "GET") return undefined;
  const pathname = new URL(url).pathname;
  return enabledNativeDiagnostics(routes).find((diagnostic) => diagnostic.path === pathname);
}
