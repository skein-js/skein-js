// `GET /info` — the capability/version handshake LangGraph Server exposes and Studio reads. Kept
// deliberately small: it reports what the server can actually be asked to do, and its versions only
// when it genuinely knows them.
//
// Note `/ok` is NOT here. LangGraph groups its liveness probe with `/info` under one `disable_meta`
// flag; skein's `/ok` is the container health probe (see the generated Dockerfile), so a config flag
// must not be able to turn it off and make a healthy instance read as dead. Each adapter serves it.

import type { ResolvedDeps } from "../deps.js";

/** The `GET /info` body — LangGraph's field names, so an existing client reads it unchanged. */
export interface ServerInfo {
  /**
   * skein's own version, when the host told us (see `ProtocolDeps.serverVersion`), else absent.
   *
   * Absent rather than guessed: a library must not read its own `package.json` at runtime (bundlers
   * rewrite `import.meta.url` to the output location — docs/bundling.md), and reporting a stale
   * compiled-in constant would be worse than reporting nothing, since a version is exactly the field
   * a bug report is going to quote.
   */
  version?: string;
  /** The `@langchain/langgraph` actually loaded, read from the dependency's own package export. */
  langgraph_js_version?: string;
  /** Always `"js"` — this is the TypeScript server. */
  context: "js";
  flags: {
    /** Full assistants CRUD + versioning is served. */
    assistants: boolean;
    /** Scheduled runs. Still on the roadmap, so honestly false. */
    crons: boolean;
    /** Whether LangSmith tracing is configured, by the same environment test LangGraph applies. */
    langsmith: boolean;
  };
}

/**
 * Whether LangSmith tracing is on, matching `@langchain/langgraph-api`'s test: a key must be present,
 * and any of the tracing switches explicitly set to `"false"` turns it off.
 */
function langsmithTracingEnabled(env: Record<string, string | undefined>): boolean {
  const apiKey = env["LANGSMITH_API_KEY"] ?? env["LANGCHAIN_API_KEY"];
  if (!apiKey) return false;
  const switches = [
    env["LANGCHAIN_TRACING_V2"],
    env["LANGCHAIN_TRACING"],
    env["LANGSMITH_TRACING_V2"],
    env["LANGSMITH_TRACING"],
  ];
  return !switches.some((value) => value === "false" || value === "False");
}

/**
 * The loaded `@langchain/langgraph` version, or undefined if it cannot be read.
 *
 * A dynamic *package* import, not a file read: `@langchain/langgraph` declares `"./package.json"` in
 * its own `exports`, so a bundler resolves this like any other import instead of leaving a dangling
 * path. Resolved once and memoized — this is a handshake endpoint, and health checkers poll it.
 *
 * `with { type: "json" }` is **required**, not decoration: Node rejects a JSON import without it
 * (`ERR_IMPORT_ATTRIBUTE_MISSING`), so omitting it made this throw on every unbundled deployment and the
 * `.catch` below swallowed it into a permanently absent field. A bundler inlines the JSON either way,
 * which is why a test run under vitest passes regardless — the attribute is what makes plain `node` work.
 */
let langgraphVersion: Promise<string | undefined> | undefined;
function readLanggraphVersion(): Promise<string | undefined> {
  langgraphVersion ??= import("@langchain/langgraph/package.json", { with: { type: "json" } })
    .then((module) => (module as { default?: { version?: string } }).default?.version)
    .catch(() => undefined);
  return langgraphVersion;
}

export interface MetaService {
  /** The `GET /info` payload. */
  info(): Promise<ServerInfo>;
}

export function createMetaService(
  deps: ResolvedDeps,
  env: Record<string, string | undefined> = process.env,
): MetaService {
  return {
    async info() {
      return {
        ...(deps.serverVersion !== undefined ? { version: deps.serverVersion } : {}),
        ...((await readLanggraphVersion()) !== undefined
          ? { langgraph_js_version: await readLanggraphVersion() }
          : {}),
        context: "js",
        flags: {
          assistants: true,
          crons: true,
          langsmith: langsmithTracingEnabled(env),
        },
      };
    },
  };
}
