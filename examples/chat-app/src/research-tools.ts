// The research agent's tools and their pure building blocks — web search and long-term memory.
// Kept separate from `research-agent.ts` so the unit suite can import these without constructing the
// Gemini model (which needs an API key at construction time).

import { type BaseMessage, SystemMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { type BaseStore, getStore, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";

// --- web search ---------------------------------------------------------------------------------

/** One search hit, trimmed to what a model needs to reason and cite. */
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

/**
 * Search the web. Uses Tavily when `TAVILY_API_KEY` is set (a real, production-shaped search);
 * otherwise returns a deterministic canned result so the example runs on `GOOGLE_API_KEY` alone and
 * the unit tests stay hermetic. Network/parse failures fall back to the canned result too, so a
 * flaky search never breaks a run.
 */
export async function searchWeb(query: string): Promise<WebSearchResult[]> {
  const apiKey = process.env["TAVILY_API_KEY"];
  if (!apiKey) return cannedResults(query);

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      // Send both the Bearer header (current Tavily API) and the body `api_key` (legacy) so a valid
      // key works regardless of which form the server expects.
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5 }),
      // Don't let a hung connection stall the whole run — degrade to the canned result instead.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return cannedResults(query);
    const body = (await response.json()) as TavilyResponse;
    const results = (body.results ?? [])
      .filter((result) => result.url)
      .map((result) => ({
        title: result.title ?? result.url ?? "Untitled",
        url: result.url ?? "",
        snippet: result.content ?? "",
      }));
    return results.length > 0 ? results : cannedResults(query);
  } catch {
    return cannedResults(query);
  }
}

/**
 * A stand-in result for when no search key is set. It deliberately does NOT say "search is broken"
 * — that makes the model give up and apologize. Instead it tells the model to answer from its own
 * knowledge, so the demo produces a real answer on the Gemini key alone. Set TAVILY_API_KEY for
 * genuine live results.
 */
function cannedResults(query: string): WebSearchResult[] {
  return [
    {
      title: `No live results for "${query}"`,
      url: "https://example.com/",
      snippet: `Live web search isn't configured (set TAVILY_API_KEY to enable it). Answer the user from your own knowledge instead, and briefly note that your information may be out of date.`,
    },
  ];
}

export const webSearchTool = tool(
  async ({ query }: { query: string }) => {
    const results = await searchWeb(query);
    return results
      .map((result) => `- ${result.title} (${result.url})\n  ${result.snippet}`)
      .join("\n");
  },
  {
    name: "web_search",
    description:
      "Search the web for up-to-date information on a topic. Returns titles, URLs, and snippets.",
    schema: z.object({ query: z.string().describe("The search query") }),
  },
);

// --- long-term memory ---------------------------------------------------------------------------

/** The store namespace holding a given user's memories. Cross-thread: the same user, every thread. */
export function memoryNamespace(userId: string): string[] {
  return ["memories", userId];
}

/**
 * A content-addressed key for a memory, so saving the same fact twice **upserts** instead of appending.
 *
 * Dedup on content rather than on similarity, deliberately. The tempting alternative — semantic search for
 * a near-duplicate before writing — inverts on most substrates: both the in-memory driver and Postgres
 * *without* `store.index` return `score: 1` for every text hit, so a "score >= 0.9 means duplicate" rule
 * classifies everything as a duplicate and the agent silently stops recording anything. See
 * docs/memory.md#the-dedup-trap.
 *
 * `globalThis.crypto.subtle` rather than `node:crypto`, so the same graph still runs on an edge runtime.
 */
export async function memoryKey(content: string): Promise<string> {
  const normalized = content.trim().toLowerCase().replace(/\s+/g, " ");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hex = [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `mem-${hex}`;
}

/**
 * Persist a durable fact about the user.
 *
 * `key` is optional: omitted, it is derived from `content`, which is what makes repeated saves idempotent.
 * Callers pass one explicitly only to make a write deterministic in a test.
 */
export async function saveMemory(
  store: BaseStore,
  userId: string,
  content: string,
  key?: string,
): Promise<void> {
  await store.put(memoryNamespace(userId), key ?? (await memoryKey(content)), { content });
}

/** Recall the user's most relevant memories for a query (semantic search on the Postgres driver). */
export async function recallMemories(
  store: BaseStore,
  userId: string,
  query: string,
  limit = 5,
): Promise<string[]> {
  const namespace = memoryNamespace(userId);
  const ranked = await store.search(namespace, { query, limit });
  if (ranked.length > 0) return ranked.map(memoryContent);
  // The in-memory driver only substring-matches, so a natural-language query often misses even when
  // relevant memories exist. Fall back to surfacing this user's stored memories so recall still works
  // without pgvector; on the Postgres driver the ranked path above already did semantic search.
  const stored = await store.search(namespace, { limit });
  return stored.map(memoryContent);
}

/** The stored fact inside a memory item, coerced to a string. */
function memoryContent(item: { value: Record<string, unknown> }): string {
  return String((item.value as { content?: unknown }).content ?? "");
}

/** Memory is scoped per `configurable.user_id`; auth (src/auth.ts) maps the caller to this same id. */
function userIdFrom(config: LangGraphRunnableConfig): string {
  const configured = config.configurable?.["user_id"];
  return typeof configured === "string" && configured.length > 0 ? configured : "demo-user";
}

/** The store skein injects into every run. Guarded so a misconfigured host fails loudly, not silently. */
function requireStore(): BaseStore {
  const store = getStore();
  if (!store) throw new Error("No long-term store is available on this run (expected getStore()).");
  return store;
}

export const saveMemoryTool = tool(
  async ({ content }: { content: string }, config: LangGraphRunnableConfig) => {
    // No explicit key: `saveMemory` derives one from the content, so the model saving the same fact
    // across turns updates one row instead of accumulating near-identical copies that drown out recall.
    await saveMemory(requireStore(), userIdFrom(config), content);
    return `Saved memory: "${content}"`;
  },
  {
    name: "save_memory",
    description:
      "Save a durable fact about the user (a preference, a goal, a detail worth remembering) for future conversations.",
    schema: z.object({ content: z.string().describe("The fact to remember, in one sentence") }),
  },
);

/** The latest human turn's text, used to decide what to recall. */
function latestUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.getType() === "human") {
      return typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    }
  }
  return "";
}

const SYSTEM_PROMPT = [
  "You are a thorough research and trip-planning assistant.",
  "Relevant things you remember about the user are provided to you automatically — use them to personalize your answer.",
  "Use `web_search` to gather up-to-date facts, and cite the URLs you used.",
  "If web_search returns no live results (for example, it isn't configured), answer from your own",
  "knowledge and briefly note your information may be out of date — never refuse to answer.",
  "When the user shares a durable preference or detail about themselves, call `save_memory` to remember it.",
  "For trips, use `get_weather` for conditions and `search_flights` to find options between two places;",
  "prefer the user's remembered home airport as the origin when they don't give one.",
  "To book a flight, ALWAYS call `book_flight` with the chosen flight's id — it pauses for the user's",
  "explicit approval. Never claim a flight is booked unless `book_flight` returned a confirmation.",
  "Think step by step, then give a clear, well-structured answer.",
].join(" ");

/**
 * Recall strategy — an **application choice, not a skein feature**. skein (like LangGraph) only makes
 * the store available via `getStore()`; how and when you recall is up to your graph. This example
 * demonstrates the *auto-inject* pattern via `createReactAgent`'s dynamic `prompt`: before each model
 * call it fetches relevant memories for the latest question and folds them into the system message,
 * so personalization doesn't depend on the model choosing to call a recall tool. (Memory goes into
 * the single system message, not a second one — Gemini rejects a system message that isn't first.)
 * Equally valid alternatives (pick per your needs): expose recall as a tool the model calls, use a
 * library like `langmem`, or skip memory entirely.
 */
export async function buildPromptWithMemories(
  state: { messages: BaseMessage[] },
  config: LangGraphRunnableConfig,
): Promise<BaseMessage[]> {
  const store = getStore();
  const query = latestUserText(state.messages);
  let systemText = SYSTEM_PROMPT;
  if (store && query) {
    const memories = await recallMemories(store, userIdFrom(config), query, 5);
    if (memories.length > 0) {
      systemText += `\n\nThings you remember about the user:\n${memories
        .map((memory) => `- ${memory}`)
        .join("\n")}`;
    }
  }
  return [new SystemMessage(systemText), ...state.messages];
}
