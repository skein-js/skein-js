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
 * way the bus's own client is — but `client` resolves once that connection is up, which is enough to
 * turn the race into an ordered shutdown. Bounded and error-swallowing: an unreachable Redis must
 * make teardown slower, never hang it.
 */
export async function settleBullConnection(resource: { client: Promise<unknown> }): Promise<void> {
  await Promise.race([
    resource.client.then(
      () => undefined,
      () => undefined,
    ),
    sleepUnref(CONNECTION_SETTLE_TIMEOUT_MS),
  ]);
}
