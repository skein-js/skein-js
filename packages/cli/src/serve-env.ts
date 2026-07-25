// Shared server-bind helpers for the in-process commands (`skein dev` and `skein start`). Both honor
// a `PORT`/`HOST` from the environment (Railway/Fly/Render/Heroku inject one) unless the flag was
// passed explicitly, and both surface the same clear message when the port is already taken.

/**
 * Port `skein dev` binds when neither `--port` nor `PORT` says otherwise. Matches `langgraph dev`, so
 * an existing local setup (SDK clients, bookmarked Studio URLs) keeps working after the switch.
 */
export const DEFAULT_DEV_PORT = 2024;

/**
 * Port the container binds when the platform injects no `PORT` — `skein start`'s default, the port
 * `skein up` publishes, and the port the generated Dockerfile `EXPOSE`s and health-checks. It is one
 * constant because those four must agree: a bare `docker run -p 8123:8123` (and any platform that
 * makes you *declare* the port rather than injecting one — AWS App Runner, ECS, Kubernetes) works
 * only if the server's own fallback is the port the image advertises. Matches `langgraph up`.
 */
export const DEFAULT_CONTAINER_PORT = 8123;

/**
 * Port to bind, honoring a `PORT` env var. Resolve this *after* the project's `.env` is merged, so a
 * project-declared PORT is honored too — not just an ambient one. Returns `fallback` when PORT is
 * unset or not a valid port.
 */
export function envPort(fallback: number): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

/** Host to bind, honoring a `HOST` env var when set; otherwise `fallback`. */
export function envHost(fallback: string): string {
  const host = process.env.HOST;
  return host !== undefined && host.trim() !== "" ? host : fallback;
}

/**
 * Human-readable message for a `server.listen` failure: a friendly hint for the common
 * `EADDRINUSE`, the raw error otherwise.
 */
export function describeBindError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    return `port ${port} is already in use. Stop the other process or pass --port.`;
  }
  return `failed to start server: ${error instanceof Error ? error.message : String(error)}`;
}
