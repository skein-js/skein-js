/** Retry-stable admission using the SDK hook; SDK 1.12.7 omits if_thread_status. */
export function addRunIdempotency(url: URL, request: RequestInit): RequestInit {
  if (request.method !== "POST" || !/\/threads\/[^/]+\/runs$/.test(url.pathname)) return request;
  if (typeof request.body !== "string") throw new Error("Expected a serialized SDK run body");
  const body = JSON.parse(request.body) as { command?: { resume?: unknown } };
  const resume = Boolean(body.command && Object.hasOwn(body.command, "resume"));
  const headers = new Headers(request.headers);
  headers.set("Idempotency-Key", crypto.randomUUID());
  return {
    ...request,
    headers,
    body: JSON.stringify({
      ...body,
      if_thread_status: resume ? ["interrupted"] : ["idle", "error"],
    }),
  };
}
