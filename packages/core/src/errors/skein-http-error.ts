// The one error type skein-js throws at its edges. Handlers and drivers throw a `SkeinHttpError`
// with the HTTP status the protocol expects; the framework adapters (Express, …) catch it and
// serialize `{ status, message, code?, details? }`. Nothing else in core knows about HTTP.

/** Options for a {@link SkeinHttpError}. */
export interface SkeinHttpErrorOptions {
  /** Stable machine-readable code (e.g. `"thread_not_found"`), distinct from the message. */
  code?: string;
  /** Structured detail carried to the client (validation issues, conflicting ids, …). */
  details?: unknown;
  /** Underlying error, preserved for logs. */
  cause?: unknown;
}

/** An error carrying the HTTP status the Agent Protocol response should use. */
export class SkeinHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(status: number, message: string, options: SkeinHttpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SkeinHttpError";
    this.status = status;
    this.code = options.code;
    this.details = options.details;
  }

  /** 400 — the request was malformed (failed boundary validation). */
  static badRequest(message: string, options?: SkeinHttpErrorOptions): SkeinHttpError {
    return new SkeinHttpError(400, message, options);
  }

  /** 401 — the caller is not authenticated (no/invalid credentials for the configured auth). */
  static unauthorized(message: string, options?: SkeinHttpErrorOptions): SkeinHttpError {
    return new SkeinHttpError(401, message, options);
  }

  /** 403 — the caller is authenticated but not permitted to perform this action. */
  static forbidden(message: string, options?: SkeinHttpErrorOptions): SkeinHttpError {
    return new SkeinHttpError(403, message, options);
  }

  /** 404 — the addressed resource does not exist. */
  static notFound(message: string, options?: SkeinHttpErrorOptions): SkeinHttpError {
    return new SkeinHttpError(404, message, options);
  }

  /** 409 — the request conflicts with current state (e.g. a thread already has an active run). */
  static conflict(message: string, options?: SkeinHttpErrorOptions): SkeinHttpError {
    return new SkeinHttpError(409, message, options);
  }

  /**
   * 422 — the request was well-formed but can't be processed in the current state. Used for a
   * `reject` multitask strategy hitting a busy thread, matching `@langchain/langgraph-api`.
   */
  static unprocessable(message: string, options?: SkeinHttpErrorOptions): SkeinHttpError {
    return new SkeinHttpError(422, message, options);
  }
}

/** Narrow an unknown thrown value to a {@link SkeinHttpError}. */
export function isSkeinHttpError(value: unknown): value is SkeinHttpError {
  return value instanceof SkeinHttpError;
}
