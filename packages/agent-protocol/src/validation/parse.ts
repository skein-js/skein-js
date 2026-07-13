// Boundary validation. Every raw request body/param is run through a Zod schema here; a failure
// becomes a `SkeinHttpError.badRequest` carrying the flattened issues, so the adapter serializes a
// clean 400. Interior code then works with fully-typed, trusted values.

import { SkeinHttpError } from "@skein-js/core";
import type { ZodType } from "zod";

/** Validate `raw` against `schema`, or throw a 400 describing what was wrong. */
export function parse<T>(schema: ZodType<T>, raw: unknown, subject = "request body"): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw SkeinHttpError.badRequest(`Invalid ${subject}.`, { details: result.error.flatten() });
  }
  return result.data;
}

/** Require a non-empty string path param (e.g. `thread_id`), or throw a 400. */
export function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw SkeinHttpError.badRequest(`Missing path parameter "${name}".`);
  }
  return value;
}
