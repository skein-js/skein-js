import type { IncomingMessage, ServerResponse } from "node:http";

import type { ProtocolRequest } from "@skein-js/agent-protocol";
import { serializeWireJson, SkeinHttpError } from "@skein-js/core";

const sourceUrls = new WeakMap<Request, string>();

/** Strip a mount path for app dispatch while retaining the public URL for asset references. */
export function withNativePath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  const native = new Request(url, request.clone());
  sourceUrls.set(native, sourceUrls.get(request) ?? request.url);
  return native;
}

export function originalNativeUrl(request: Request): string {
  return sourceUrls.get(request) ?? request.url;
}

/** Build a Fetch request from a framework's normalized body without changing protocol responses. */
export function toNativeRequest(
  request: Pick<ProtocolRequest, "method" | "url" | "headers" | "body" | "signal">,
  rawBody?: Uint8Array,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers))
    if (value !== undefined) headers.set(name, value);
  const hasBody = !["GET", "HEAD"].includes(request.method.toUpperCase());
  const body = !hasBody
    ? undefined
    : (rawBody ??
      (request.body === undefined
        ? undefined
        : typeof request.body === "string" || request.body instanceof Uint8Array
          ? request.body
          : serializeWireJson(request.body)));
  // A host may already have parsed JSON; its original byte count no longer describes that body.
  if (!rawBody) headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: body instanceof Uint8Array ? new Uint8Array(body) : body,
    signal: request.signal,
  });
}

/** Native Node bridge also handles binary/form bodies when the host has not parsed them. */
type NativeNodeRequest = IncomingMessage & {
  body?: unknown;
  rawBody?: Uint8Array;
  originalUrl?: string;
};
export function readNativeNodeRequest(
  request: NativeNodeRequest,
  url: string,
  signal?: AbortSignal,
): Promise<Request>;
export function readNativeNodeRequest(
  request: NativeNodeRequest,
  url: string,
  signal: AbortSignal | undefined,
  handler: (request: Request) => Promise<Response | undefined>,
): Promise<Request | undefined>;
export async function readNativeNodeRequest(
  request: NativeNodeRequest,
  url: string,
  signal?: AbortSignal,
  handler?: (request: Request) => Promise<Response | undefined>,
): Promise<Request | undefined> {
  const matcher = (
    handler as unknown as
      Record<symbol, ((method: string, url: string) => boolean) | undefined> | undefined
  )?.[Symbol.for("@skein-js/native-request-matcher")];
  if (matcher?.(request.method ?? "GET", url) === false) return undefined;
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers))
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  let rawBody = request.rawBody;
  if (
    !rawBody &&
    request.body === undefined &&
    !["GET", "HEAD"].includes(request.method ?? "GET") &&
    !request.readableEnded
  ) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(String(chunk));
      size += bytes.byteLength;
      if (size > 100 * 1024)
        throw SkeinHttpError.payloadTooLarge("Request body exceeds 102400 bytes.");
      chunks.push(bytes);
    }
    rawBody = Buffer.concat(chunks);
    request.rawBody = rawBody;
    const text = new TextDecoder().decode(rawBody);
    try {
      request.body = headers["content-type"]?.includes("application/json")
        ? text
          ? JSON.parse(text)
          : {}
        : text;
    } catch {
      throw SkeinHttpError.badRequest("Request body is not valid JSON.");
    }
  }
  const native = toNativeRequest(
    { method: request.method ?? "GET", url, headers, body: request.body, signal },
    rawBody,
  );
  sourceUrls.set(native, new URL(request.originalUrl ?? request.url ?? url, url).href);
  return native;
}

/** Stream binary, HTML, JSON or SSE from a native app with backpressure and cancellation. */
export async function sendNativeResponse(
  response: Response,
  target: ServerResponse,
): Promise<void> {
  target.statusCode = response.status;
  for (const [name, value] of response.headers)
    if (name !== "set-cookie") target.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) target.setHeader("set-cookie", cookies);
  if (!response.body) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  const close = () => {
    void reader.cancel().catch(() => undefined);
  };
  target.once("close", close);
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done || target.destroyed) break;
      if (!target.write(chunk.value))
        await new Promise<void>((resolve) => {
          const done = () => {
            target.removeListener("drain", done);
            target.removeListener("close", done);
            resolve();
          };
          target.once("drain", done);
          target.once("close", done);
        });
    }
  } finally {
    target.removeListener("close", close);
    reader.releaseLock();
    if (!target.writableEnded) target.end();
  }
}
