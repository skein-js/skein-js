// Assistants are the served graphs. At startup we register one assistant per graph declared in the
// resolver, with `assistant_id` defaulting to the `graph_id` — this matches @langchain/langgraph-api
// and lets a client address a graph by its id without a create call. The run engine resolves a run's
// `assistant_id` to an assistant row and then to its `graph_id`.
//
// Beyond that seed, assistants are full CRUD + versioning (LangGraph parity): create/update/delete,
// a version history you can roll back to (`setLatest`), and graph/subgraph introspection. Versioning
// itself lives in the store (both drivers, one conformance suite); this service stays thin — it adds
// `if_exists`, the `delete_threads` cascade, and compiling a graph for introspection.

import type { CompiledGraph } from "@langchain/langgraph";
import {
  isSkeinHttpError,
  SkeinHttpError,
  type Assistant,
  type AssistantCreate,
  type AssistantGraph,
  type AssistantSearchQuery,
  type AssistantUpdate,
  type AssistantVersion,
  type AssistantVersionsQuery,
  type Thread,
} from "@skein-js/core";

import type { ProtocolContext } from "../context.js";
import type { GraphSchemas } from "../deps.js";
import type { ThreadService } from "../threads/thread-service.js";

/** `POST /assistants` — create input plus LangGraph's `if_exists` conflict policy. */
export interface CreateAssistantInput extends AssistantCreate {
  /** When the `assistant_id` already exists: `"raise"` (default, 409) or `"do_nothing"` (return it). */
  ifExists?: "raise" | "do_nothing";
}

/** `DELETE /assistants/{id}` options. */
export interface DeleteAssistantOptions {
  /** Also delete threads whose `metadata.assistant_id` is this assistant (aborting their runs). */
  deleteThreads?: boolean;
}

/** `GET /assistants/{id}/graph` options. */
export interface DrawGraphOptions {
  /** Include subgraphs in the drawn graph; an integer bounds the depth (mirrors LangGraph). */
  xray?: number | boolean;
}

/** `GET /assistants/{id}/subgraphs[/{namespace}]` options. */
export interface SubgraphsOptions {
  /** Restrict to this subgraph namespace. */
  namespace?: string;
  /** Recurse into nested subgraphs. */
  recurse?: boolean;
}

export interface AssistantService {
  /** Register one assistant per declared graph (idempotent — safe to call on every boot). */
  registerGraphAssistants(): Promise<Assistant[]>;
  get(assistantId: string): Promise<Assistant>;
  list(): Promise<Assistant[]>;
  /** Filtered + paginated listing — `POST /assistants/search`. */
  search(query: AssistantSearchQuery): Promise<Assistant[]>;
  /** Count matching assistants (ignores limit/offset) — `POST /assistants/count`. */
  count(query: AssistantSearchQuery): Promise<number>;
  schemas(assistantId: string): Promise<GraphSchemas>;
  /** Create an assistant, honoring `if_exists` — `POST /assistants`. */
  create(input: CreateAssistantInput): Promise<Assistant>;
  /** Patch an assistant, minting a new version — `PATCH /assistants/{id}`. */
  update(assistantId: string, patch: AssistantUpdate): Promise<Assistant>;
  /** Delete an assistant (and, optionally, its threads) — `DELETE /assistants/{id}`. */
  delete(assistantId: string, options?: DeleteAssistantOptions): Promise<void>;
  /** Version history, newest-first — `POST /assistants/{id}/versions`. */
  listVersions(assistantId: string, query?: AssistantVersionsQuery): Promise<AssistantVersion[]>;
  /** Roll back to an existing version — `POST /assistants/{id}/latest`. */
  setLatest(assistantId: string, version: number): Promise<Assistant>;
  /** The drawable graph JSON — `GET /assistants/{id}/graph`. */
  drawGraph(assistantId: string, options?: DrawGraphOptions): Promise<AssistantGraph>;
  /** Each subgraph's schema, keyed by namespace — `GET /assistants/{id}/subgraphs`. */
  subgraphs(assistantId: string, options?: SubgraphsOptions): Promise<GraphSchemas>;
}

/** The `configurable` block of an assistant's config, passed to a graph *factory* at compile time. */
function factoryConfigurable(config: unknown): { configurable?: Record<string, unknown> } {
  const configurable = (config as { configurable?: Record<string, unknown> } | undefined)
    ?.configurable;
  return { configurable };
}

export function createAssistantService(
  ctx: ProtocolContext,
  threads: ThreadService,
): AssistantService {
  const { deps } = ctx;

  const requireAssistant = async (assistantId: string): Promise<Assistant> => {
    const assistant = await deps.store.assistants.get(assistantId);
    if (!assistant) throw SkeinHttpError.notFound(`Assistant "${assistantId}" not found.`);
    return assistant;
  };

  // A user-created assistant must reference a declared graph (auto-registered assistants always do).
  // Reject an unknown graph_id up front rather than persisting a row that 500s on every run/schemas.
  const requireGraph = (graphId: string): void => {
    if (!deps.graphs.ids.includes(graphId)) {
      throw SkeinHttpError.badRequest(`Unknown graph "${graphId}".`);
    }
  };

  // The threads owned by an assistant that this caller is allowed to delete. Assistants are gate-only
  // (no ownership filter), so without scoping the cascade here, a caller with assistants:delete could
  // destroy other owners' threads. When auth is configured we authorize a threads:delete for the
  // caller and keep only the threads its ownership filter matches; denial (403) cascades nothing.
  const deletableThreads = async (assistantId: string): Promise<Thread[]> => {
    const owned = await deps.store.threads.search({ metadata: { assistant_id: assistantId } });
    const engine = deps.auth;
    if (!engine?.enabled || !ctx.authUser) return owned;
    try {
      const { filters } = await engine.authorize({
        resource: "threads",
        action: "delete",
        value: { assistant_id: assistantId },
        context: { user: ctx.authUser, scopes: ctx.authScopes ?? [] },
      });
      if (!filters) return owned;
      return owned.filter((thread) => engine.matchesFilters(thread.metadata ?? undefined, filters));
    } catch {
      return []; // caller not permitted to delete threads → cascade none
    }
  };

  // Compile the assistant's graph for introspection (draw/subgraphs). A factory export is built with
  // the assistant's own `configurable`, exactly as the run engine does, so its shape matches a run's.
  const compileGraph = async (assistant: Assistant): Promise<CompiledGraph<string>> => {
    const resolved = await deps.graphs.load(assistant.graph_id);
    return typeof resolved === "function"
      ? await resolved(factoryConfigurable(assistant.config))
      : resolved;
  };

  return {
    async registerGraphAssistants() {
      const registered: Assistant[] = [];
      for (const graphId of deps.graphs.ids) {
        // assistant_id === graph_id, seeded once. get-before-create keeps it idempotent; if a
        // concurrent boot wins the race, create throws 409 and we fall back to the row it wrote.
        const existing = await deps.store.assistants.get(graphId);
        if (existing) {
          registered.push(existing);
          continue;
        }
        try {
          registered.push(
            await deps.store.assistants.create({ graph_id: graphId, assistant_id: graphId }),
          );
        } catch (error) {
          if (isSkeinHttpError(error) && error.status === 409) {
            const now = await deps.store.assistants.get(graphId);
            if (now) {
              registered.push(now);
              continue;
            }
          }
          throw error;
        }
      }
      return registered;
    },

    get: requireAssistant,

    list: () => deps.store.assistants.list(),

    search: (query) => deps.store.assistants.search(query),

    count: (query) => deps.store.assistants.count(query),

    async schemas(assistantId) {
      const assistant = await requireAssistant(assistantId);
      return deps.graphs.schemas(assistant.graph_id);
    },

    async create({ ifExists, ...input }) {
      requireGraph(input.graph_id);
      // Atomic if_exists: let the store enforce uniqueness (it throws 409 on a duplicate id) rather
      // than a racy get-then-create. do_nothing recovers the existing row; raise re-throws the 409.
      try {
        return await deps.store.assistants.create(input);
      } catch (error) {
        if (
          input.assistant_id !== undefined &&
          ifExists === "do_nothing" &&
          isSkeinHttpError(error) &&
          error.status === 409
        ) {
          const existing = await deps.store.assistants.get(input.assistant_id);
          if (existing) return existing;
        }
        throw error;
      }
    },

    update(assistantId, patch) {
      if (patch.graph_id !== undefined) requireGraph(patch.graph_id);
      return deps.store.assistants.update(assistantId, patch);
    },

    async delete(assistantId, options) {
      await requireAssistant(assistantId);
      if (options?.deleteThreads) {
        // Threads carry their most-recent run's `assistant_id` in metadata (stamped by the run
        // service), so the store's subset-match search finds them. Delete each via the thread service
        // (aborts any in-flight run, then removes the thread + its runs) — concurrently, since the
        // deletions are independent — scoped to the threads this caller may actually delete.
        const owned = await deletableThreads(assistantId);
        await Promise.all(owned.map((thread) => threads.delete(thread.thread_id)));
      }
      await deps.store.assistants.delete(assistantId);
    },

    async listVersions(assistantId, query) {
      // 404 an unknown assistant (rather than returning an empty list) so the caller can tell "no
      // such assistant" from "assistant exists but this metadata filter matched no version".
      await requireAssistant(assistantId);
      return deps.store.assistants.listVersions(assistantId, query);
    },

    setLatest: (assistantId, version) => deps.store.assistants.setLatest(assistantId, version),

    async drawGraph(assistantId, options) {
      const assistant = await requireAssistant(assistantId);
      const graph = await compileGraph(assistant);
      const drawable = await graph.getGraphAsync({
        ...(assistant.config ?? {}),
        xray: options?.xray,
      } as Parameters<CompiledGraph<string>["getGraphAsync"]>[0]);
      return drawable.toJSON() as AssistantGraph;
    },

    async subgraphs(assistantId, options) {
      const assistant = await requireAssistant(assistantId);
      const graph = await compileGraph(assistant);
      const schemas = await deps.graphs.schemas(assistant.graph_id);
      // Schemas are keyed by the root graph id (no `|`) and `${rootGraphId}|${namespace}` per
      // subgraph — mirror @langchain/langgraph-api's lookup. Iterating the compiled graph's actual
      // subgraphs is what tells us which namespaces exist (and honors namespace/recurse filters).
      const rootGraphId = Object.keys(schemas).find((key) => !key.includes("|"));
      const result: GraphSchemas = {};
      for await (const [namespace] of graph.getSubgraphsAsync(
        options?.namespace,
        options?.recurse,
      )) {
        const schema =
          schemas[`${rootGraphId}|${namespace}`] ??
          (rootGraphId !== undefined ? schemas[rootGraphId] : undefined);
        if (schema !== undefined) result[namespace] = schema;
      }
      return result;
    },
  };
}
