import { RUN_STATUSES, type RunStatus } from "@skein-js/core";
import { z } from "zod";

function firstQueryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}
/** Existing GET semantics: absorb malformed values, clamp large requested pages. */
export const pageInteger = z.preprocess((value) => {
  const raw = firstQueryValue(value);
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : undefined;
}, z.number().int().min(1).max(1000).optional());
export const booleanFlag = z.preprocess((value) => {
  const raw = firstQueryValue(value);
  return raw === "true" ? true : raw === "false" ? false : undefined;
}, z.boolean().optional());
export const stringQuery = z.preprocess(firstQueryValue, z.string().optional());
export const runStatus = z.preprocess(
  (value) => {
    const raw = firstQueryValue(value);
    return typeof raw === "string" && RUN_STATUSES.includes(raw as RunStatus) ? raw : undefined;
  },
  z.enum(RUN_STATUSES as [RunStatus, ...RunStatus[]]).optional(),
);
export const deliveryStatus = z.preprocess(
  (value) =>
    typeof value === "string" && ["pending", "delivering", "delivered", "dead"].includes(value)
      ? value
      : undefined,
  z.enum(["pending", "delivering", "delivered", "dead"]).optional(),
);
export const cancelFlag = z.preprocess(
  (value) => firstQueryValue(value) === "1" || firstQueryValue(value) === "true",
  z.boolean(),
);
export const cancelAction = z.preprocess(
  (value) => (firstQueryValue(value) === "rollback" ? "rollback" : "interrupt"),
  z.enum(["interrupt", "rollback"]),
);
export const graphDepth = z.preprocess(
  (value) => booleanFlag.parse(value) ?? pageInteger.parse(value),
  z.union([z.boolean(), z.number().int().min(1).max(1000)]).optional(),
);
export const repeatedStringQuery = z.union([z.string(), z.array(z.string())]).optional();
