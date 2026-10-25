/** Extraction is a data path, never JavaScript or an expression language. */
export const EXTRACT_PATH = /^(values|metadata|config|interrupts)(?:\.[A-Za-z0-9_$-]+|\[-?\d+\])*$/;

function extractValue(row: object, path: string): unknown {
  let value: unknown = row;
  const segments = path.match(/[A-Za-z0-9_$-]+|\[-?\d+\]/g) ?? [];
  for (const segment of segments) {
    if (segment.startsWith("[")) {
      if (!Array.isArray(value)) return null;
      value = value.at(Number(segment.slice(1, -1)));
    } else {
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment))
        return null;
      value = (value as Record<string, unknown>)[segment];
    }
  }
  return value ?? null;
}

/** Called only after service authorization/filtering/pagination; never mutates a stored row. */
export function projectSearchRow(
  row: object,
  select?: readonly string[],
  extract?: Record<string, string>,
): object {
  const selected =
    select === undefined
      ? row
      : Object.fromEntries(Object.entries(row).filter(([key]) => select.includes(key)));
  return {
    ...selected,
    ...(extract === undefined
      ? {}
      : {
          extracted: Object.fromEntries(
            Object.entries(extract).map(([alias, path]) => [alias, extractValue(row, path)]),
          ),
        }),
  };
}
