// Reading a graph's input shape out of `GET /assistants/{id}/schemas`.
//
// This is messier than it should be, and the mess is a real finding rather than defensive habit.
// `@langchain/langgraph-sdk` types the response as `{ graph_id, input_schema, output_schema,
// state_schema, config_schema }`, but skein answers with a map of graph symbol → `{ state, input,
// output, config }`:
//
//   SDK expects:  { "input_schema": { "properties": { "messages": … } } }
//   skein sends:  { "graph":        { "input":     { "properties": { "messages": … } } } }
//
// So `client.assistants.getSchemas()` returns an object whose every documented field is `undefined`.
// The console reads both shapes so it works either way, and the divergence is written up in
// docs/roadmap.md — see the note there. Do not "simplify" this to the SDK shape until the server
// answers in it.

/** A JSON-schema-ish object, only as far as this file needs to look into one. */
interface SchemaLike {
  properties?: Record<string, unknown>;
}

function hasProperty(schema: unknown, property: string): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const properties = (schema as SchemaLike).properties;
  return typeof properties === "object" && properties !== null && property in properties;
}

/**
 * Does this graph accept `messages` — i.e. is it a chat graph?
 *
 * Checks the SDK-documented fields first, then skein's per-graph map. Falls back to `false`, so an
 * unrecognized shape gets the JSON editor: showing a chat box for a graph that wants
 * `{ repo, limit }` is a worse failure than showing an editor to a chatbot.
 */
export function acceptsMessages(schemas: unknown): boolean {
  if (typeof schemas !== "object" || schemas === null) return false;
  const record = schemas as Record<string, unknown>;

  // The shape the SDK documents.
  if (hasProperty(record["input_schema"], "messages")) return true;
  if (hasProperty(record["state_schema"], "messages")) return true;

  // The shape skein currently sends: { <graph symbol>: { state, input, output, config } }.
  for (const value of Object.values(record)) {
    if (typeof value !== "object" || value === null) continue;
    const graph = value as Record<string, unknown>;
    if (hasProperty(graph["input"], "messages")) return true;
    if (hasProperty(graph["state"], "messages")) return true;
  }
  return false;
}

/** The graph's input schema, from whichever shape the server sent. */
export function inputSchemaOf(schemas: unknown): SchemaLike | undefined {
  if (typeof schemas !== "object" || schemas === null) return undefined;
  const record = schemas as Record<string, unknown>;
  const direct = record["input_schema"] ?? record["state_schema"];
  if (typeof direct === "object" && direct !== null) return direct as SchemaLike;
  for (const value of Object.values(record)) {
    if (typeof value !== "object" || value === null) continue;
    const graph = value as Record<string, unknown>;
    const nested = graph["input"] ?? graph["state"];
    if (typeof nested === "object" && nested !== null) return nested as SchemaLike;
  }
  return undefined;
}

/**
 * A starting input object for the JSON editor, built from the graph's own schema.
 *
 * Without this the editor opens on `{}` and the first thing anyone does is go read the graph source to
 * find out what it wants — exactly the trip to the code the playground exists to save.
 *
 * The template has to be *valid input*, not just the right key names. An earlier version emitted
 * `{"item": null}` for anything it could not type, and pressing Send on the default the console had
 * just written produced `Expected object, received null` — a worked example of the wrong answer.
 */
export function sampleInputFor(schemas: unknown): string {
  const schema = inputSchemaOf(schemas);
  const properties = schema?.properties;
  if (!properties || Object.keys(properties).length === 0) return "{}";
  const sample: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(properties)) {
    sample[key] = blankFor(definition, schema, new Set());
  }
  return JSON.stringify(sample, null, 2);
}

/** `#/definitions/Foo` or `#/$defs/Foo` → the named subschema, if the document carries one. */
function resolveRef(reference: string, root: SchemaLike | undefined): unknown {
  for (const container of ["#/definitions/", "#/$defs/"]) {
    if (!reference.startsWith(container)) continue;
    const name = reference.slice(container.length);
    const definitions = (
      root as { definitions?: Record<string, unknown>; $defs?: Record<string, unknown> }
    )[container === "#/definitions/" ? "definitions" : "$defs"];
    if (definitions && Object.prototype.hasOwnProperty.call(definitions, name))
      return definitions[name];
  }
  return undefined;
}

/**
 * An empty value of the right type.
 *
 * `seen` guards against a self-referential schema (a tree node whose children are the same type),
 * which would otherwise recurse until the stack gives out.
 */
function blankFor(
  definition: unknown,
  root: SchemaLike | undefined,
  seen: ReadonlySet<string>,
): unknown {
  if (typeof definition !== "object" || definition === null) return null;
  const node = definition as {
    type?: unknown;
    properties?: Record<string, unknown>;
    $ref?: unknown;
    enum?: unknown[];
    anyOf?: unknown[];
    oneOf?: unknown[];
    items?: unknown;
  };

  if (typeof node.$ref === "string") {
    if (seen.has(node.$ref)) return {};
    const resolved = resolveRef(node.$ref, root);
    if (resolved === undefined) return {};
    return blankFor(resolved, root, new Set(seen).add(node.$ref));
  }

  // A union is most usefully sampled by its first concrete branch — that is the shape someone is
  // most likely to want, and an empty object teaches nothing.
  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union) && union.length > 0) return blankFor(union[0], root, seen);
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];

  switch (node.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "null":
      return null;
    default:
      break;
  }

  // No usable `type`, but it describes properties — treat it as the object it plainly is. This is the
  // case that produced `null` before, because LangGraph's introspection omits `type` on `$ref` targets.
  if (node.properties) {
    return Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [key, blankFor(value, root, seen)]),
    );
  }
  return null;
}
