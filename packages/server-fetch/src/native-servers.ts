export interface NativeServerOptions {
  port: number;
  hostname?: string;
}

export interface BunServerHandle {
  hostname: string;
  port: number;
  stop: (closeActiveConnections?: boolean) => void;
}

interface BunRuntime {
  serve(options: {
    port: number;
    hostname?: string;
    fetch: (request: Request) => Response | Promise<Response>;
  }): BunServerHandle;
}

export interface DenoServerHandle {
  addr: { hostname: string; port: number };
  finished: Promise<void>;
  shutdown: () => Promise<void>;
}

interface DenoRuntime {
  serve(
    options: {
      port: number;
      hostname?: string;
      onListen?: (address: { hostname: string; port: number }) => void;
    },
    fetch: (request: Request) => Response | Promise<Response>,
  ): DenoServerHandle;
}

/** Start a native `Bun.serve` listener without importing a Node HTTP compatibility layer. */
export function startBunServer(
  fetch: (request: Request) => Response | Promise<Response>,
  options: NativeServerOptions,
): BunServerHandle {
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!bun) throw new Error("Bun.serve is unavailable. Run this launcher with Bun.");
  return bun.serve({ ...options, fetch });
}

/** Start a native `Deno.serve` listener without importing a Node HTTP compatibility layer. */
export function startDenoServer(
  fetch: (request: Request) => Response | Promise<Response>,
  options: NativeServerOptions,
): DenoServerHandle {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoRuntime }).Deno;
  if (!deno) throw new Error("Deno.serve is unavailable. Run this launcher with Deno.");
  return deno.serve(options, fetch);
}
