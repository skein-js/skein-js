// Two small edge helpers: turn any thrown value into a serializable payload for an `error` run
// frame, and normalize any thrown value into a `SkeinHttpError` so a handler never leaks an
// untyped 500 to the adapter.

import { isSkeinHttpError, SkeinHttpError } from "@skein-js/core";

/** A JSON-safe description of an error, published as the `data` of an `error` run frame. */
export interface SerializedError {
  message: string;
  name: string;
}

/** Extract a stable `{ name, message }` from anything that was thrown. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

/**
 * Return `error` unchanged if it is already a {@link SkeinHttpError}; otherwise wrap it as a 500 so
 * the failure still carries an HTTP status and the original cause for logs.
 */
export function toSkeinHttpError(error: unknown): SkeinHttpError {
  if (isSkeinHttpError(error)) return error;
  const { message } = serializeError(error);
  return new SkeinHttpError(500, message, { cause: error });
}
