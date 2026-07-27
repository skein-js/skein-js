// Honoring a stream's backpressure signal when writing SSE frames.
//
// `res.write()` returns `false` once the socket's buffer is full. Ignoring that return value means the
// write loop keeps pulling frames as fast as the graph produces them and queues every one it cannot
// send, so a client on a slow connection is served entirely out of the server's memory — unbounded,
// and per connection. Waiting for `drain` paces the loop to the client instead.
//
// This does not slow the graph down: the run engine publishes into the event bus, and the bus is what
// this loop reads from. Pacing the reader affects how fast frames leave the bus, not how fast they
// enter it.
//
// Lives here rather than in `@skein-js/server-kit` because `@skein-js/express` and `@skein-js/fastify`
// depend on `@skein-js/agent-protocol` (for `SSE_HEADERS`) but not on server-kit — putting it there
// would add a dependency edge to every adapter for the sake of one function.

/**
 * The slice of a writable HTTP response this needs. Structural rather than a Node `ServerResponse`, so
 * Express's `Response`, Fastify's `reply.raw`, and a plain `ServerResponse` all satisfy it — as does a
 * fake in tests, which is what makes the backpressure contract assertable without a socket.
 */
export interface BackpressuredWritable {
  /** Returns `false` when the buffer is full and the caller should wait for `drain`. */
  write(chunk: string): boolean;
  once(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  /**
   * Whether the stream is already torn down. Required, not optional: a dead stream emits **no**
   * further events, so an implementation that cannot answer this cannot be waited on safely. See the
   * dead-stream note on {@link writeWithBackpressure}.
   */
  readonly destroyed: boolean;
  /** Whether `end()` has already been called — same reasoning as {@link BackpressuredWritable.destroyed}. */
  readonly writableEnded: boolean;
}

/**
 * Write one chunk, returning a promise that settles when the stream is ready for more — or
 * `undefined` when it already is.
 *
 * The `undefined` fast path is deliberate: a client keeping up hits it on every frame, and returning a
 * resolved promise there would allocate one per frame on the hottest path in the server. Callers do
 * `const pending = writeWithBackpressure(res, chunk); if (pending) await pending;`.
 *
 * The wait settles on `close` and `error` as well as `drain`. A client that vanishes mid-buffer never
 * emits `drain`, so waiting only on that would hang the loop forever — and with it the frame
 * generator's `finally`, leaking the run's bus subscription for the lifetime of the process.
 *
 * **A stream that is already dead is never waited on.** Writing to a destroyed response returns
 * `false` and emits nothing at all: `close` has already fired, `error` is suppressed for an
 * already-destroyed stream, and `drain` will never come. Waiting there parks the loop permanently,
 * which is strictly worse than the buffering this exists to prevent — the `finally` never runs, so
 * the frame generator is never returned and the run's bus subscription is pinned for the life of the
 * process. The caller's own `close` listener does not cover this: it is registered when streaming
 * begins, and a client can abort while the handler is still awaiting the run, before that listener
 * exists. So the state is checked here rather than inferred from an event that already fired.
 */
export function writeWithBackpressure(
  res: BackpressuredWritable,
  chunk: string,
): Promise<void> | undefined {
  if (res.write(chunk)) return undefined;
  // Checked *after* the write so a live stream still pays only one branch, and synchronously before
  // registering listeners — nothing can tear the stream down in between on a single-threaded loop.
  if (res.destroyed || res.writableEnded) return undefined;

  return new Promise<void>((resolve) => {
    const settle = (): void => {
      res.off("drain", settle);
      res.off("close", settle);
      res.off("error", settle);
      resolve();
    };
    res.once("drain", settle);
    res.once("close", settle);
    res.once("error", settle);
  });
}
