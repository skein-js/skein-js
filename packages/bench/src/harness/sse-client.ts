// An SSE reader with a configurable consumption rate. The *slow* variant is the whole point of the
// benchmark: a client reading well below the graph's production rate is what a mobile connection or a
// buffering proxy looks like, and it is the only condition under which a missing-backpressure bug
// shows up. A fast reader establishes the floor to compare it against.

/** How a bench client consumes its stream. */
export interface SseClientOptions {
  /**
   * Frames per second the client will accept, or `0` for "as fast as they arrive". A finite value
   * throttles reads *without* closing the connection, so the server keeps producing into a consumer
   * that cannot keep up.
   */
  framesPerSecond: number;
  /** Aborts the read. The scenario wires this to its overall deadline. */
  signal?: AbortSignal;
}

/** What one client observed over its stream. */
export interface SseClientResult {
  /** SSE frames received (blank-line-delimited records, not lines). */
  frames: number;
  /** Milliseconds from request start to the first frame. */
  timeToFirstFrameMs: number;
  /** Per-frame arrival gaps, for latency percentiles. */
  interFrameMs: number[];
  /** Total wall time of the stream. */
  durationMs: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * POST a streaming run and consume its SSE body at the configured pace.
 *
 * Frames are counted by the `\n\n` record separator rather than parsed: the benchmark cares about
 * frame *arrival*, and running `JSON.parse` per frame would add client-side allocation to a
 * measurement of server-side allocation.
 */
export async function streamRun(
  baseUrl: string,
  threadId: string,
  body: unknown,
  options: SseClientOptions,
): Promise<SseClientResult> {
  const startedAt = performance.now();
  const throttleMs = options.framesPerSecond > 0 ? 1000 / options.framesPerSecond : 0;

  const response = await fetch(`${baseUrl}/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok || !response.body) {
    throw new Error(`stream request failed: ${response.status} ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let frames = 0;
  let timeToFirstFrameMs = 0;
  let lastFrameAt = startedAt;
  const interFrameMs: number[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      // Count completed records and keep only the trailing partial one, so `pending` never grows
      // with the response — the client must not become the thing that leaks.
      let separator = pending.indexOf("\n\n");
      while (separator !== -1) {
        frames += 1;
        const now = performance.now();
        if (frames === 1) timeToFirstFrameMs = now - startedAt;
        else interFrameMs.push(now - lastFrameAt);
        lastFrameAt = now;
        pending = pending.slice(separator + 2);
        separator = pending.indexOf("\n\n");

        if (throttleMs > 0) await sleep(throttleMs);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    frames,
    timeToFirstFrameMs,
    interFrameMs,
    durationMs: performance.now() - startedAt,
  };
}

/** Create a thread and return its id. */
export async function createThread(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`thread create failed: ${response.status} ${await response.text()}`);
  }
  const thread = (await response.json()) as { thread_id: string };
  return thread.thread_id;
}
