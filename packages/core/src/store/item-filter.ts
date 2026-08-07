// Value filtering for the long-term store — the `filter` on `POST /store/items/search` and on
// LangGraph's `BaseStore.search`.
//
// The operator set is LangGraph's, verbatim, because a graph written against `getStore()` must see
// the same filter here as on LangGraph Platform. The *implementation* is ours: upstream's engine
// (`compareValues` in `@langchain/langgraph-checkpoint/dist/store/utils.js`) is internal, absent from
// the package's exports and from its `.d.ts`, so there is nothing to import. The conformance suite
// pins our behaviour on both drivers; it cannot detect upstream drift, so this file is the record of
// what we promised.
//
// One deliberate departure, in `matchesItemFilter` below: ordering operators compare numbers only.

import { SkeinHttpError } from "../errors/skein-http-error.js";

/** A value a filter compares against. Scalars only — see {@link StoreItemFilter}. */
export type StoreFilterScalar = string | number | boolean | null;

/**
 * The operators a store filter understands. Multiple operators on one key are ANDed.
 *
 * Ordering operators take a number because they compare numbers — see {@link matchesItemFilter}.
 */
export interface StoreFilterOperators {
  $eq?: StoreFilterScalar;
  $ne?: StoreFilterScalar;
  $gt?: number;
  $gte?: number;
  $lt?: number;
  $lte?: number;
  $in?: StoreFilterScalar[];
  $nin?: StoreFilterScalar[];
}

/** A bare scalar (compared for equality) or a bag of operators. */
export type StoreFilterCondition = StoreFilterScalar | StoreFilterOperators;

/**
 * Narrows a store search by the **top-level** keys of an item's `value`. Keys are ANDed.
 *
 * Top-level only, matching LangGraph, which reads `item.value[key]` — `"a.b"` is the literal key
 * `"a.b"`, not a path into a nested object.
 */
export type StoreItemFilter = Record<string, StoreFilterCondition>;

/**
 * Every operator name, as values.
 *
 * The Zod schema at the HTTP boundary and the Postgres predicate builder both enumerate from this,
 * so the set of operators that validate and the set that reach SQL cannot drift apart.
 */
export const STORE_FILTER_OPERATORS = [
  "$eq",
  "$ne",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
] as const satisfies readonly (keyof StoreFilterOperators)[];

/**
 * True when `condition` is an operator bag rather than a bare scalar.
 *
 * Every key must be a known operator. A mixed object (`{ $eq: 1, colour: "red" }`) is therefore not
 * an operator bag, and falls through to scalar comparison — where it never matches. The HTTP boundary
 * rejects that shape outright rather than letting it silently match nothing.
 */
export function isStoreFilterOperators(
  condition: StoreFilterCondition,
): condition is StoreFilterOperators {
  if (condition === null || typeof condition !== "object") return false;
  const operators: readonly string[] = STORE_FILTER_OPERATORS;
  return Object.keys(condition).every((key) => operators.includes(key));
}

/** True for the JSON scalars a filter may compare against. */
function isStoreFilterScalar(value: unknown): value is StoreFilterScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Why `value` is not a usable store filter, or `null` if it is one.
 *
 * The single definition of what a filter may contain. Both entry points run through it: the HTTP
 * schema refines with it, and {@link parseStoreItemFilter} guards `getStore()`. Two hand-kept copies
 * would drift, and the drift would be invisible — the conformance suite only ever sees filters that
 * already passed one of the two gates.
 */
export function storeItemFilterProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "filter must be an object keyed by the item value's top-level fields.";
  }

  for (const [key, condition] of Object.entries(value)) {
    if (isStoreFilterScalar(condition)) continue;

    const operators: readonly string[] = STORE_FILTER_OPERATORS;
    const conditionKeys =
      condition !== null && typeof condition === "object" && !Array.isArray(condition)
        ? Object.keys(condition)
        : null;

    // A `$`-prefixed key means the caller intended an operator bag, however malformed. Without one,
    // an array or a plain nested object was meant as a *value* — and `===` against either is always
    // false, so accepting it would mean a filter that silently matches nothing. (An empty object is
    // the exception: it is a bag stating no conditions, which matches everything, and is allowed.)
    if (
      conditionKeys === null ||
      (conditionKeys.length > 0 && !conditionKeys.some((candidate) => candidate.startsWith("$")))
    ) {
      return `filter."${key}" must be a scalar or an operator object; use $in for membership.`;
    }

    for (const [operator, operand] of Object.entries(condition as Record<string, unknown>)) {
      if (!operators.includes(operator)) {
        // A typo'd operator would state no condition, so the bag would match *everything* — and a
        // non-operator key mixed into a bag drops the whole condition to scalar comparison, which
        // matches nothing. Both are silent, so both are refused.
        return `filter."${key}" has unknown operator "${operator}". Supported: ${STORE_FILTER_OPERATORS.join(", ")}.`;
      }
      if (operator === "$in" || operator === "$nin") {
        if (!Array.isArray(operand) || !operand.every(isStoreFilterScalar)) {
          return `filter."${key}".${operator} must be an array of scalars.`;
        }
        continue;
      }
      if (operator === "$eq" || operator === "$ne") {
        if (!isStoreFilterScalar(operand)) return `filter."${key}".${operator} must be a scalar.`;
        continue;
      }
      // Ordering compares numbers only — see `matchesItemFilter`.
      if (typeof operand !== "number" || Number.isNaN(operand)) {
        return `filter."${key}".${operator} must be a number.`;
      }
    }
  }
  return null;
}

/**
 * Validate an untrusted filter, or throw a 400.
 *
 * The `getStore()` path needs this because it has no schema in front of it: a graph node calling
 * `store.search(ns, { filter })` reaches the driver directly, where an unchecked operand is not a
 * wrong answer but a *crash* — Postgres raises `invalid input syntax for type numeric` on a string
 * bound to `$gt`, surfacing as a 500 from inside a run.
 */
export function parseStoreItemFilter(value: unknown): StoreItemFilter {
  const problem = storeItemFilterProblem(value);
  if (problem) throw SkeinHttpError.badRequest(problem);
  return value as StoreItemFilter;
}

/**
 * True if every key's condition holds against `value[key]`. An absent or empty filter matches all.
 *
 * **Ordering operators compare numbers only.** `$gt`/`$gte`/`$lt`/`$lte` match when the stored value
 * is a JSON number and the comparison holds; a string, boolean, `null`, object, array or absent key
 * never matches. LangGraph instead coerces both sides with `Number()`, which we cannot reproduce in
 * Postgres — `'abc'::numeric` throws where `Number("abc")` merely yields `NaN` — and which would make
 * `true > 0`, `null >= 0` and `"" <= 5` all true. One rule both drivers implement beats two rules
 * that agree by accident; the divergence is limited to numeric strings.
 *
 * Absent keys otherwise behave exactly as `undefined` does in JS: `$ne` and `$nin` match, `$eq`,
 * `$in` and a bare scalar do not. A present JSON `null` is distinguishable from an absent key on both
 * drivers, so `{ deleted: null }` means "present and null".
 */
export function matchesItemFilter(
  value: Record<string, unknown>,
  filter?: StoreItemFilter,
): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, condition]) =>
    matchesCondition(value[key], condition),
  );
}

function matchesCondition(actual: unknown, condition: StoreFilterCondition): boolean {
  if (!isStoreFilterOperators(condition)) return actual === condition;
  // An empty bag states no conditions, so it matches — as `[].every(...)` does.
  return Object.entries(condition).every(([operator, operand]) =>
    matchesOperator(actual, operator as keyof StoreFilterOperators, operand),
  );
}

function matchesOperator(
  actual: unknown,
  operator: keyof StoreFilterOperators,
  operand: unknown,
): boolean {
  switch (operator) {
    case "$eq":
      return actual === operand;
    case "$ne":
      return actual !== operand;
    case "$gt":
      return compareNumbers(actual, operand, (left, right) => left > right);
    case "$gte":
      return compareNumbers(actual, operand, (left, right) => left >= right);
    case "$lt":
      return compareNumbers(actual, operand, (left, right) => left < right);
    case "$lte":
      return compareNumbers(actual, operand, (left, right) => left <= right);
    case "$in":
      return Array.isArray(operand) && operand.includes(actual as StoreFilterScalar);
    case "$nin":
      return Array.isArray(operand) && !operand.includes(actual as StoreFilterScalar);
  }
}

/** Numbers only, both sides. `NaN` is excluded so it never compares true against itself. */
function compareNumbers(
  actual: unknown,
  operand: unknown,
  holds: (left: number, right: number) => boolean,
): boolean {
  if (typeof actual !== "number" || Number.isNaN(actual)) return false;
  if (typeof operand !== "number" || Number.isNaN(operand)) return false;
  return holds(actual, operand);
}
