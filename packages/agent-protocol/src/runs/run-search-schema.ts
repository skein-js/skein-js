import { DEFAULT_MAX_PAGE_SIZE, RUN_STATUSES, type RunStatus } from "@skein-js/core";
import { z } from "zod";

// Normalize offsets before comparison so a range means the same instant on every driver.
const timestamp = z
  .string()
  .datetime({ offset: true })
  // Zod checks the ISO syntax but accepts out-of-range offsets. Refuse those before toISOString
  // can throw, so malformed timestamps become boundary errors instead of server failures.
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid datetime")
  .transform((value) => new Date(value).toISOString());
export const runSearchSchema = z
  .object({
    status: z.enum(RUN_STATUSES as [RunStatus, ...RunStatus[]]).optional(),
    assistant_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).optional(),
    created_after: timestamp.optional(),
    created_before: timestamp.optional(),
    updated_after: timestamp.optional(),
    updated_before: timestamp.optional(),
    limit: z.number().int().positive().max(DEFAULT_MAX_PAGE_SIZE).default(100),
    offset: z.number().int().nonnegative().default(0),
  })
  .superRefine((query, context) => {
    for (const [lower, upper] of [
      ["created_after", "created_before"],
      ["updated_after", "updated_before"],
    ] as const) {
      if (query[lower] !== undefined && query[upper] !== undefined && query[lower]! > query[upper]!)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [upper],
          message: `${upper} must not precede ${lower}.`,
        });
    }
  });
