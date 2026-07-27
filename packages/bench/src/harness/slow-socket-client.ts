// A deliberately slow SSE client built on a raw TCP socket.
//
// The obvious implementation — `fetch` plus a throttled `reader.read()` loop — does not model a slow
// client at all. undici drains the kernel socket into its own buffer as fast as the server writes,
// so the backlog lands in the *client's* memory and the server's socket never fills. Measured against
// it, a server with no backpressure looks perfectly well behaved.
//
// Pausing a raw socket instead stops reads at the kernel, the TCP receive window closes, and the
// server's `writableLength` grows exactly as it would for a real client on a bad connection. That is
// the condition the backpressure work exists to handle, so it is the one the benchmark has to create.

import { connect, type Socket } from "node:net";

export interface SlowSocketClientOptions {
  host: string;
  port: number;
  path: string;
  /** JSON request body. */
  body: string;
  /**
   * Frames the client accepts per second. Between reads the socket stays paused, so unread bytes
   * accumulate on the server rather than locally.
   */
  framesPerSecond: number;
  /** Give up if the response has not completed within this many milliseconds. */
  timeoutMs: number;
}

export interface SlowSocketClientResult {
  frames: number;
  timeToFirstFrameMs: number;
  interFrameMs: number[];
  durationMs: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * POST a streaming run over a raw socket and consume the SSE body at a throttled pace.
 *
 * Frames are counted by the `\n\n` record separator. Only the trailing partial record is retained, so
 * the client's own memory stays flat and any growth the benchmark observes is genuinely the server's.
 */
export async function streamRunSlowly(
  options: SlowSocketClientOptions,
): Promise<SlowSocketClientResult> {
  const { host, port, path, body, framesPerSecond, timeoutMs } = options;
  const throttleMs = framesPerSecond > 0 ? 1000 / framesPerSecond : 0;
  const startedAt = performance.now();

  const socket: Socket = connect({ host, port });
  socket.setNoDelay(true);

  let frames = 0;
  let timeToFirstFrameMs = 0;
  let lastFrameAt = startedAt;
  const interFrameMs: number[] = [];
  let pending = "";
  let headersDone = false;

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", resolve);
    });

    const request =
      `POST ${path} HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      `Content-Type: application/json\r\n` +
      `Accept: text/event-stream\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n` +
      body;
    socket.write(request);

    // Paused from the outset: every byte the server sends now waits in its socket buffer until this
    // loop explicitly asks for it.
    socket.pause();

    let finished = false;
    let failure: Error | undefined;
    socket.once("end", () => {
      finished = true;
    });
    socket.once("close", () => {
      finished = true;
    });
    socket.once("error", (error: Error) => {
      failure = error;
      finished = true;
    });

    const deadline = startedAt + timeoutMs;
    while (!finished) {
      if (performance.now() > deadline) {
        throw new Error(`slow client timed out after ${timeoutMs}ms (${frames} frames)`);
      }

      const chunk = socket.read() as Buffer | null;
      if (chunk === null) {
        // Nothing buffered locally yet — wait briefly rather than spinning.
        await sleep(throttleMs > 0 ? throttleMs : 5);
        continue;
      }

      pending += chunk.toString("utf8");

      if (!headersDone) {
        const headerEnd = pending.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const statusLine = pending.slice(0, pending.indexOf("\r\n"));
        if (!statusLine.includes(" 200 ")) {
          throw new Error(`slow client got a non-200 response: ${statusLine}`);
        }
        headersDone = true;
        pending = pending.slice(headerEnd + 4);
      }

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

    if (failure) throw failure;
  } finally {
    socket.destroy();
  }

  return {
    frames,
    timeToFirstFrameMs,
    interFrameMs,
    durationMs: performance.now() - startedAt,
  };
}
