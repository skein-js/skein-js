// Assistants: a named, versioned binding of a graph to a config. Every update mints a new immutable
// version rather than mutating in place, which is what makes `setLatest` a rollback.

import type { Assistant, AssistantVersion, Config, Metadata } from "../wire/wire.js";

/** Fields accepted when registering an assistant (from a langgraph.json graph or the API). */
export interface AssistantCreate {
  graph_id: string;
  /** Server-assigned when omitted. */
  assistant_id?: string;
  name?: string;
  description?: string;
  config?: Config;
  context?: unknown;
  metadata?: Metadata;
}

/**
 * Partial update; omitted fields keep the current version's value. Every update mints a NEW
 * immutable version (see {@link AssistantRepo.update}) — there is no in-place field mutation.
 */
export interface AssistantUpdate {
  graph_id?: string;
  name?: string;
  description?: string;
  config?: Config;
  context?: unknown;
  metadata?: Metadata;
}

/** Filter + pagination for `POST /assistants/search`. Omitted fields don't constrain the result. */
export interface AssistantSearchQuery {
  /** Restrict to assistants of this graph. */
  graph_id?: string;
  /** Restrict to assistants with this exact name. */
  name?: string;
  /** Match assistants whose metadata contains every one of these key/value pairs (subset match). */
  metadata?: Metadata;
  limit?: number;
  offset?: number;
  /** Sort key; defaults to `created_at`. */
  sortBy?: "assistant_id" | "graph_id" | "name" | "created_at" | "updated_at";
  /** Sort direction; defaults to `desc`. */
  sortOrder?: "asc" | "desc";
}

/** Filter + pagination for `POST /assistants/{id}/versions`. */
export interface AssistantVersionsQuery {
  /** Match versions whose metadata contains every one of these key/value pairs (subset match). */
  metadata?: Metadata;
  limit?: number;
  offset?: number;
}

export interface AssistantRepo {
  list(): Promise<Assistant[]>;
  /** Filtered + paginated listing backing `POST /assistants/search`. */
  search(query: AssistantSearchQuery): Promise<Assistant[]>;
  /** Number of assistants matching `query` (ignores limit/offset), backing `POST /assistants/count`. */
  count(query: AssistantSearchQuery): Promise<number>;
  get(assistantId: string): Promise<Assistant | null>;
  /**
   * Create an assistant, seeding version 1 (the live row and its first {@link AssistantVersion}
   * snapshot are written together). Throws `SkeinHttpError.conflict` (409) when `assistant_id` is
   * already taken — the service layer turns that into `if_exists` handling, and callers that want
   * idempotent registration (e.g. graph auto-registration) get-before-create and tolerate the 409.
   */
  create(input: AssistantCreate): Promise<Assistant>;
  /**
   * Apply a partial patch by minting a NEW version: snapshot the current fields with `patch` applied,
   * bump the live row to those fields + the new version number. Throws `SkeinHttpError.notFound` when
   * the assistant is unknown. Returns the (now-active) assistant.
   */
  update(assistantId: string, patch: AssistantUpdate): Promise<Assistant>;
  /** Version history, newest-first, filtered + paginated. Empty when the assistant is unknown. */
  listVersions(assistantId: string, query?: AssistantVersionsQuery): Promise<AssistantVersion[]>;
  /**
   * Roll the live row back to an existing version's snapshot (no new version is minted). Throws
   * `SkeinHttpError.notFound` when the assistant or the target version is unknown.
   */
  setLatest(assistantId: string, version: number): Promise<Assistant>;
  delete(assistantId: string): Promise<void>;
}
