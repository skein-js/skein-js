/** SDK request hook: one key per run creation, reused by the SDK's transport retries. */
export function addRunIdempotency(url: URL, request: RequestInit): RequestInit {
  if (request.method !== "POST" || !/\/threads\/[^/]+\/runs$/.test(url.pathname)) return request;
  const headers = new Headers(request.headers);
  headers.set("Idempotency-Key", crypto.randomUUID());
  return { ...request, headers };
}
