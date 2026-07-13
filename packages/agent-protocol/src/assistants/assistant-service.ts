// Assistants are the served graphs. At startup we register one assistant per graph declared in the
// resolver, with `assistant_id` defaulting to the `graph_id` — this matches @langchain/langgraph-api
// and lets a client address a graph by its id without a create call. The run engine resolves a run's
// `assistant_id` to an assistant row and then to its `graph_id`.

import { SkeinHttpError, type Assistant } from "@skein-js/core";

import type { GraphSchemas, ResolvedDeps } from "../deps.js";

export interface AssistantSearch {
  graph_id?: string;
  limit?: number;
  offset?: number;
}

export interface AssistantService {
  /** Register one assistant per declared graph (idempotent — safe to call on every boot). */
  registerGraphAssistants(): Promise<Assistant[]>;
  get(assistantId: string): Promise<Assistant>;
  list(): Promise<Assistant[]>;
  search(query: AssistantSearch): Promise<Assistant[]>;
  schemas(assistantId: string): Promise<GraphSchemas>;
}

export function createAssistantService(deps: ResolvedDeps): AssistantService {
  const requireAssistant = async (assistantId: string): Promise<Assistant> => {
    const assistant = await deps.store.assistants.get(assistantId);
    if (!assistant) throw SkeinHttpError.notFound(`Assistant "${assistantId}" not found.`);
    return assistant;
  };

  return {
    async registerGraphAssistants() {
      const registered: Assistant[] = [];
      for (const graphId of deps.graphs.ids) {
        // assistant_id === graph_id: creating with a fixed id is an upsert-by-id in every driver.
        const existing = await deps.store.assistants.get(graphId);
        registered.push(
          existing ??
            (await deps.store.assistants.create({ graph_id: graphId, assistant_id: graphId })),
        );
      }
      return registered;
    },

    get: requireAssistant,

    list: () => deps.store.assistants.list(),

    async search(query) {
      const all = await deps.store.assistants.list();
      const filtered = query.graph_id
        ? all.filter((assistant) => assistant.graph_id === query.graph_id)
        : all;
      const offset = query.offset ?? 0;
      return filtered.slice(offset, query.limit === undefined ? undefined : offset + query.limit);
    },

    async schemas(assistantId) {
      const assistant = await requireAssistant(assistantId);
      return deps.graphs.schemas(assistant.graph_id);
    },
  };
}
