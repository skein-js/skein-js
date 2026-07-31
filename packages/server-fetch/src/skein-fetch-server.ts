import {
  copyThreadIdIntoBody,
  matchSkeinRoute,
  SSE_HEADERS,
  type ProtocolRequest,
  type ProtocolResponse,
} from "@skein-js/agent-protocol";
import { isSkeinHttpError, serializeWireJson, SkeinHttpError } from "@skein-js/core";
import {
  corsPreflightHeaders,
  corsResponseHeaders,
  resolveProtocolRuntime,
  stripBasePath,
  type CorsSetting,
  type Logger,
  type ResolvedProtocolRuntime,
  type SkeinRuntimeOptions,
} from "@skein-js/server-kit";

/**
 * Largest JSON body accepted, matching `express.json()`'s 100kb so the same request is accepted or
 * rejected identically whichever adapter serves it.
 *
 * A bound is not optional here. The Node adapters inherit one from their body parser, but a native
 * Fetch server has none worth relying on: `Bun.serve` defaults to 128MB and `Deno.serve` has no limit
 * at all. Reading an unbounded body into a JS string happens *before* validation or auth, so without
 * this a handful of concurrent large-body requests is an unauthenticated OOM on the 512Mi shape
 * docs/performance.md sizes for.
 */
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024;

/** Options for a native Fetch server. The protocol is mounted at the root unless `basePath` is set. */
export type SkeinFetchServerOptions = SkeinRuntimeOptions & {
  basePath?: string;
  /** Largest accepted JSON body, in bytes. Defaults to {@link DEFAULT_MAX_BODY_BYTES}. */
  maxBodyBytes?: number;
};
export type SkeinFetchHandler = (request: Request) => Promise<Response>;

/** A resolved Fetch handler and the lifecycle it owns. `close` drains the run worker once. */
export interface SkeinFetchServer {
  fetch: SkeinFetchHandler;
  runtime: ResolvedProtocolRuntime["runtime"];
  close: () => Promise<void>;
}

function toQuery(url: URL): ProtocolRequest["query"] {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : (values[0] as string);
  }
  return query;
}

/**
 * Read the body, refusing anything over `maxBodyBytes`.
 *
 * Counted while streaming rather than trusted from `content-length`: the header is absent on a chunked
 * request and is attacker-controlled anyway, so checking it alone would let the very body this bound
 * exists to stop be read in full. The declared length is still checked first, so an oversized request
 * that announces itself is refused without reading it at all.
 */
async function readBoundedText(request: Request, maxBodyBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw SkeinHttpError.payloadTooLarge(`Request body exceeds ${maxBodyBytes} bytes.`);
  }
  if (!request.body) return request.text();

  const decoder = new TextDecoder();
  const reader = request.body.getReader();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBodyBytes) {
        throw SkeinHttpError.payloadTooLarge(`Request body exceeds ${maxBodyBytes} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    // Release the connection instead of leaving a half-read body attached to it.
    await reader.cancel().catch(() => {});
  }
  return text + decoder.decode();
}

async function toProtocolRequest(
  request: Request,
  url: URL,
  skeinPathname: string,
  params: Record<string, string>,
  maxBodyBytes: number,
): Promise<ProtocolRequest> {
  let body: unknown;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const text = await readBoundedText(request, maxBodyBytes);
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw SkeinHttpError.badRequest("Request body is not valid JSON.");
    }
  }
  return {
    method: request.method,
    url: `${url.origin}${skeinPathname}${url.search}`,
    params,
    query: toQuery(url),
    body,
    headers: Object.fromEntries(request.headers),
    signal: request.signal,
  };
}

/** Pull one frame per consumer request and release the source immediately on disconnect. */
function createSseStream(events: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let finished = false;

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (finished) return;
        try {
          const next = await iterator.next();
          if (next.done) {
            finished = true;
            controller.close();
          } else {
            controller.enqueue(encoder.encode(next.value));
          }
        } catch (error) {
          finished = true;
          controller.error(error);
        }
      },
      async cancel() {
        if (finished) return;
        finished = true;
        await iterator.return?.(undefined);
      },
    },
    // The adapter itself retains no more than one encoded frame for a slow consumer.
    { highWaterMark: 1 },
  );
}

/** Serialize a transport-neutral protocol response into a Web `Response`. */
export function toFetchResponse(
  response: ProtocolResponse,
  extraHeaders: Record<string, string> = {},
): Response {
  switch (response.kind) {
    case "json":
      return new Response(serializeWireJson(response.body), {
        status: response.status,
        headers: { "content-type": "application/json", ...response.headers, ...extraHeaders },
      });
    case "empty":
      return new Response(null, {
        status: response.status,
        headers: { ...response.headers, ...extraHeaders },
      });
    case "sse":
      return new Response(createSseStream(response.events), {
        status: response.status,
        headers: { ...SSE_HEADERS, ...response.headers, ...extraHeaders },
      });
  }
}

function errorResponse(
  error: unknown,
  extraHeaders: Record<string, string>,
  logger?: Logger,
): Response {
  const headers = { "content-type": "application/json", ...extraHeaders };
  if (isSkeinHttpError(error)) {
    return new Response(
      JSON.stringify({
        status: error.status,
        message: error.message,
        ...(error.code !== undefined ? { code: error.code } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      }),
      { status: error.status, headers },
    );
  }
  logger?.error("Unhandled error in the skein Fetch adapter.", error);
  return new Response(JSON.stringify({ status: 500, message: "Internal Server Error" }), {
    status: 500,
    headers,
  });
}

function createFetchHandler(
  resolved: ResolvedProtocolRuntime,
  options: SkeinFetchServerOptions,
): SkeinFetchHandler {
  const basePath = options.basePath ?? "";
  const cors: CorsSetting | false | undefined = options.cors ?? resolved.cors;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (request) => {
    const url = new URL(request.url);
    const skeinPathname = stripBasePath(url.pathname, basePath);
    if (skeinPathname === null) return new Response(null, { status: 404 });
    if (skeinPathname === "/ok" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method === "OPTIONS") {
      if (!cors) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 204,
        headers: corsPreflightHeaders(
          request.headers.get("origin") ?? undefined,
          request.headers.get("access-control-request-headers") ?? undefined,
          cors,
        ),
      });
    }

    const extraHeaders = cors
      ? corsResponseHeaders(request.headers.get("origin") ?? undefined, cors)
      : {};
    const match = matchSkeinRoute(request.method, skeinPathname);
    if (!match) {
      return new Response(JSON.stringify({ status: 404, message: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json", ...extraHeaders },
      });
    }

    try {
      const protocolRequest = await toProtocolRequest(
        request,
        url,
        skeinPathname,
        match.params,
        maxBodyBytes,
      );
      const invoke = resolved.runtime.handlers[match.binding.handler];
      const response = await invoke(
        match.binding.foldThreadIdIntoBody
          ? copyThreadIdIntoBody(protocolRequest)
          : protocolRequest,
      );
      return toFetchResponse(response, extraHeaders);
    } catch (error) {
      return errorResponse(error, extraHeaders, resolved.logger);
    }
  };
}

/** Resolve and start a Skein runtime, returning the Fetch handler plus an ordered drain lifecycle. */
export async function createSkeinFetchServer(
  options: SkeinFetchServerOptions,
): Promise<SkeinFetchServer> {
  const resolved = await resolveProtocolRuntime(options);
  let closePromise: Promise<void> | undefined;
  return {
    fetch: createFetchHandler(resolved, options),
    runtime: resolved.runtime,
    close() {
      closePromise ??= resolved.runtime.worker.stop();
      return closePromise;
    },
  };
}
