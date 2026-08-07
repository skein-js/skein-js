// Request-body parity against the installed `@langchain/langgraph-sdk`.
//
// skein's body schemas are `.passthrough()`, which is the right call — a client must not 400 because
// it sent a field this server has not learned yet. The cost is that a field the SDK sends and skein
// does not read is **invisible**: it validates, it reaches the service, and it is dropped. That is how
// `if_exists` came to clobber threads on one driver and 500 on the other, and how `after_seconds`
// came to succeed while doing nothing at all (issue #7).
//
// So: read the keys the SDK actually puts on the wire, and require each one to be *named* in the
// matching skein schema. Named, not necessarily honoured — several are deliberately accepted and
// ignored, and each says so in a comment where it is declared. What this forbids is the silent case.
//
// Both sides are read as **text** rather than imported: the schemas are internal to
// `@skein-js/agent-protocol` (exporting Zod objects would be a new public commitment), and the SDK's
// client is compiled JS. The same shape as `static-imports.test.ts`, which parses built output, and
// `package-exports.test.ts`, which reads manifests.
//
// It lives here because it is a workspace-level assertion. `packages/test-support/project.json` gives
// the `test` target explicit inputs covering both files, because Nx's default inputs would otherwise
// replay a cached pass after an SDK bump — exactly when this guard matters most.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sdkRoot = path.dirname(require.resolve("@langchain/langgraph-sdk/package.json"));

const sdkClient = (name: string): string =>
  readFileSync(path.join(sdkRoot, "dist", "client", name, "index.js"), "utf8");

const skeinSchemas = (): string =>
  readFileSync(path.join(packagesDir, "agent-protocol/src/validation/schemas.ts"), "utf8");

/**
 * The top-level keys of an object literal, starting from the `{` at or after `from`.
 *
 * Brace-counted rather than regexed, because both sides nest: the SDK's run body nests
 * `langsmith_tracer`, and skein's schemas nest `z.object({...})` inside a field's validator. A flat
 * regex would report those inner keys as fields of the outer body.
 */
function topLevelKeys(source: string, from: number): string[] {
  const start = source.indexOf("{", from);
  const keys: string[] = [];
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && (source[i - 1] === "\n" || source[i - 1] === "\t")) {
      const match = /^[ \t]*([a-z_][a-z0-9_]*)\s*:/.exec(source.slice(i, i + 80));
      if (match) {
        keys.push(match[1] as string);
        i += match[0].length - 1;
      }
    }
  }
  return [...new Set(keys)];
}

/** The keys of the request body one SDK client method sends. */
function sdkBodyKeys(source: string, methodSignature: string): string[] {
  const methodAt = source.indexOf(methodSignature);
  if (methodAt === -1) {
    throw new Error(`method not found in the installed SDK: ${methodSignature}`);
  }
  // Every spelling the client uses: `const json = {` and `const payload = {` (assigned, then passed
  // as `json:`), and an inline `json: {`. The store methods use `payload`, and missing that spelling
  // is not a loud failure in the wrong direction — `sdkBodyKeys` throws rather than reporting an
  // empty body, so a fourth spelling shows up as a red test rather than a vacuous pass.
  const candidates = [/const json = \{/g, /const payload = \{/g, /\bjson: \{/g]
    .map((pattern) => {
      pattern.lastIndex = methodAt;
      return pattern.exec(source)?.index;
    })
    .filter((index): index is number => index !== undefined);
  if (candidates.length === 0) throw new Error(`no request body found for ${methodSignature}`);
  return topLevelKeys(source, Math.min(...candidates));
}

/** The fields a skein Zod schema names explicitly (i.e. does not merely pass through). */
function skeinSchemaKeys(source: string, schemaName: string): string[] {
  const declaredAt = source.search(new RegExp(`^(?:export )?const ${schemaName} = `, "m"));
  if (declaredAt === -1) throw new Error(`schema not found: ${schemaName}`);
  // `.object({` for a plain schema, `.extend({` for one built on another (the cron bodies). Whichever
  // comes first is this declaration's own field list.
  const openers = [source.indexOf(".object(", declaredAt), source.indexOf(".extend(", declaredAt)];
  const objectAt = Math.min(...openers.filter((index) => index !== -1));
  if (!Number.isFinite(objectAt)) throw new Error(`schema declares no fields: ${schemaName}`);
  return topLevelKeys(source, objectAt);
}

/**
 * The three run-create methods. Their bodies are not identical — `on_disconnect` rides only the two
 * that hold a connection open — so each is checked, and the union has to be covered too.
 */
const RUN_CREATE_METHODS = [
  "async *stream(threadId, assistantId, payload)",
  "async create(threadId, assistantId, payload)",
  "async wait(threadId, assistantId, payload)",
];

const STORE_SEARCH_METHOD = "async searchItems(namespacePrefix, options)";
const STORE_NAMESPACES_METHOD = "async listNamespaces(options)";

describe("SDK request-body parity", () => {
  // Self-guarding. Every assertion below is a "nothing is missing" check, which passes vacuously if
  // either extractor quietly stops finding anything. Pin the shapes so a broken parse fails loudly.
  it("still reads both sides", () => {
    const runs = sdkClient("runs");
    for (const method of RUN_CREATE_METHODS) {
      expect(sdkBodyKeys(runs, method).length).toBeGreaterThan(15);
    }
    expect(sdkBodyKeys(sdkClient("threads"), "async create(payload)")).toContain("if_exists");
    expect(skeinSchemaKeys(skeinSchemas(), "runCreateSchema").length).toBeGreaterThan(15);
    expect(skeinSchemaKeys(skeinSchemas(), "threadCreateSchema")).toContain("if_exists");
    // The store methods were the gap this file was blind to: `filter` and `max_depth` reached the
    // server, validated, and were dropped — for `filter`, the whole point of the request.
    expect(sdkBodyKeys(sdkClient("store"), STORE_SEARCH_METHOD)).toContain("filter");
    expect(sdkBodyKeys(sdkClient("store"), STORE_NAMESPACES_METHOD)).toContain("max_depth");
    expect(skeinSchemaKeys(skeinSchemas(), "storeSearchSchema")).toContain("filter");
    expect(skeinSchemaKeys(skeinSchemas(), "listNamespacesSchema")).toContain("max_depth");
  });

  it.each(RUN_CREATE_METHODS)("names every field runs.%s sends", (method) => {
    const sent = sdkBodyKeys(sdkClient("runs"), method);
    const named = skeinSchemaKeys(skeinSchemas(), "runCreateSchema");

    expect(sent.filter((key) => !named.includes(key)).sort()).toEqual([]);
  });

  it("names every field threads.create sends", () => {
    const sent = sdkBodyKeys(sdkClient("threads"), "async create(payload)");
    const named = skeinSchemaKeys(skeinSchemas(), "threadCreateSchema");

    expect(sent.filter((key) => !named.includes(key)).sort()).toEqual([]);
  });

  it("names every field threads.update sends", () => {
    const sent = sdkBodyKeys(sdkClient("threads"), "async update(threadId, payload)");
    const named = skeinSchemaKeys(skeinSchemas(), "threadPatchSchema");

    expect(sent.filter((key) => !named.includes(key)).sort()).toEqual([]);
  });

  it("names every field store.searchItems sends", () => {
    const sent = sdkBodyKeys(sdkClient("store"), STORE_SEARCH_METHOD);
    const named = skeinSchemaKeys(skeinSchemas(), "storeSearchSchema");

    expect(sent.filter((key) => !named.includes(key)).sort()).toEqual([]);
  });

  it("names every field store.listNamespaces sends", () => {
    const sent = sdkBodyKeys(sdkClient("store"), STORE_NAMESPACES_METHOD);
    const named = skeinSchemaKeys(skeinSchemas(), "listNamespacesSchema");

    expect(sent.filter((key) => !named.includes(key)).sort()).toEqual([]);
  });

  it("names every field crons.create sends", () => {
    const sent = sdkBodyKeys(sdkClient("crons"), "async create(assistantId, payload)");
    const named = skeinSchemaKeys(skeinSchemas(), "cronCreateSchema");

    // `cronCreateSchema` extends `cronRunPayloadSchema`, so the run-shaped half is declared there.
    const inherited = skeinSchemaKeys(skeinSchemas(), "cronRunPayloadSchema");
    expect(sent.filter((key) => ![...named, ...inherited].includes(key)).sort()).toEqual([]);
  });
});
