// The direct backpressure signal. When an SSE writer ignores `res.write()`'s return value, the bytes
// it produced but the client has not read pile up in each socket's writable buffer — so the sum of
// `writableLength` across live sockets *is* the leak, observed at its source rather than inferred
// from RSS. A working backpressure fix drives this series to roughly zero regardless of how slow the
// client is; without one it tracks the graph's total output.

import type { Server } from "node:http";
import type { Socket } from "node:net";

/** Tracks live server sockets and reports their combined unflushed bytes. */
export interface SocketBufferProbe {
  /** Bytes currently queued across every open connection. */
  bufferedBytes(): number;
  /** Connections currently open. */
  openSockets(): number;
  /** Detach the listeners. Safe to call more than once. */
  stop(): void;
}

/**
 * Watch `server` for connections and expose their aggregate writable-buffer depth.
 *
 * Sockets are held in a `Set` and removed on `close`, so a scenario that opens and drops hundreds of
 * streams does not accumulate dead handles inside the probe measuring the leak.
 */
export function trackSocketBuffers(server: Server): SocketBufferProbe {
  const sockets = new Set<Socket>();

  const onConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  server.on("connection", onConnection);

  return {
    bufferedBytes: () => {
      let total = 0;
      for (const socket of sockets) total += socket.writableLength;
      return total;
    },
    openSockets: () => sockets.size,
    stop: () => {
      server.off("connection", onConnection);
      sockets.clear();
    },
  };
}
