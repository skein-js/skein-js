// Boundary validation. Every raw request body/param is run through a Zod schema here; a failure
// becomes a `SkeinHttpError.badRequest` carrying the flattened issues, so the adapter serializes a
// clean 400. Interior code then works with fully-typed, trusted values.

import { SkeinHttpError } from "@skein-js/core";
import { z, type ZodType, type ZodTypeDef } from "zod";

/** Validate `raw` against `schema`, or throw a 400 describing what was wrong. */
export function parse<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  raw: unknown,
  subject = "request body",
): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw SkeinHttpError.badRequest(`Invalid ${subject}.`, { details: result.error.flatten() });
  }
  return result.data;
}

export const pathParameterSchema = z.string().min(1);

/** Require a non-empty string path param (e.g. `thread_id`), or throw a 400. */
export function requireParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  const result = pathParameterSchema.safeParse(value);
  if (!result.success) {
    throw SkeinHttpError.badRequest(`Missing path parameter "${name}".`);
  }
  return result.data;
}
