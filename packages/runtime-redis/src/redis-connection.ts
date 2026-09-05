// Shared connection-teardown helpers for the Redis drivers.
//
// The problem they exist to solve: on connect, ioredis issues `CLIENT SETINFO` (twice) and — for the
// ready check — `INFO`, none of which application code ever awaits. Close a connection while that
// handshake is still in flight and ioredis flushes those commands as rejections with nothing left to
// catch them, so they escape as unhandled rejections. Since Node 15 that terminates the process by
// default, and skein tears connections down early on exactly the paths where it matters: a
// `embedPostgresGraphs` assembly that fails partway, or a process that exits soon after boot.
//
// Both drivers hit it, from different connections — the bus owns its ioredis client directly, while
// BullMQ owns the queue's and opens it eagerly in the constructor — so the guard lives here.

import type { Redis } from "ioredis";

/** How long teardown waits on a connection before giving up and closing it hard. */
export const CONNECTION_SETTLE_TIMEOUT_MS = 1000;

/** A timer that never keeps the process alive on its own. */
export const sleepUnref = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

/** Resolves once a connection has finished handshaking, one way or the other. */
function connectionSettled(client: Redis): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      client.off("ready", finish);
      client.off("end", finish);
      client.off("error", finish);
      resolve();
    };
    client.once("ready", finish);
    client.once("end", finish);
    client.once("error", finish);
  });
}

/**
 * Close a connection we own without orphaning ioredis's in-flight handshake commands.
 *
 * Never opened a socket → close it without one; still handshaking → let it settle first, bounded,
 * because a connection that never becomes ready must not block shutdown.
 */
export async function closeConnection(client: Redis): Promise<void> {
  if (client.status === "end") return;
  if (client.status === "wait") {
    // lazyConnect and never used — there is no socket and nothing in flight.
    client.disconnect();
    return;
  }
  if (client.status !== "ready") {
    await Promise.race([connectionSettled(client), sleepUnref(CONNECTION_SETTLE_TIMEOUT_MS)]);
  }
  // `quit()` drains in-flight commands where `disconnect()` flushes them as rejections, so prefer it.
  await Promise.race([
    client.quit().catch(() => undefined),
    sleepUnref(CONNECTION_SETTLE_TIMEOUT_MS),
  ]);
  client.disconnect();
}

/**
 * Wait for a BullMQ resource's connection to finish handshaking before it is closed.
 *
 * BullMQ owns the connection and opens it eagerly in the constructor, so we cannot make it lazy the
 * way the bus's own client is — but it exposes a promise that resolves once that connection is up,
 * which is enough to turn the race into an ordered shutdown. Bounded, error-swallowing, and
 * indifferent to which BullMQ major is installed: an unreachable Redis, or an API that moved, must
 * make teardown slower or duller, never fail it.
 */
export async function settleBullConnection(resource: {
  client?: Promise<unknown>;
  waitUntilReady?: () => Promise<unknown>;
}): Promise<void> {
  // `client` is BullMQ 5's spelling and `waitUntilReady()` is BullMQ 6's, where the `client` getter
  // is gone and reading it yields `undefined`. Probing for both keeps teardown correct across the
  // boundary — and, more to the point, keeps a *shutdown* helper from being the thing that throws:
  // this used to do `resource.client.then(...)` unconditionally, so on BullMQ 6 every stop ended
  // with `Cannot read properties of undefined (reading 'then')` reported as an unclean shutdown.
  // Neither present is a no-op, not an error: settling is an optimisation over closing, and the
  // close that follows is what actually has to happen.
  //
  // Reading and calling are both inside the try for the same reason the whole helper is forgiving: a
  // partly-constructed Queue or Worker can throw *synchronously* out of either (its `backend` or
  // `blockingConnection` is not there yet), and an exception escaping here would skip the `close()`
  // the caller runs next — which is the one thing teardown genuinely must do.
  let settled: unknown;
  try {
    settled =
      typeof resource.waitUntilReady === "function" ? resource.waitUntilReady() : resource.client;
  } catch {
    return;
  }
  if (settled == null) return;
  await Promise.race([
    Promise.resolve(settled).then(
      () => undefined,
      () => undefined,
    ),
    sleepUnref(CONNECTION_SETTLE_TIMEOUT_MS),
  ]);
}
