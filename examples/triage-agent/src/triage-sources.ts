// Where work comes from, and the pure functions that shape it.
//
// Kept apart from the graph so it can be unit-tested without a model, a server, or a network: the
// interesting logic here is the dedup key (which is what makes a re-sweep idempotent rather than
// duplicative) and the normalization that lets a second source be added without touching the graph.

import { createHash } from "node:crypto";

import { z } from "zod";

import fixturePayload from "./fixtures/issues.json" with { type: "json" };

/**
 * One thing to triage, normalized away from whatever API it came from.
 *
 * Declared as a Zod schema rather than a bare interface because this is a *boundary*: items arrive
 * from GitHub, from a cron, and from whatever someone types into the console playground, and a graph
 * that trusts them fails deep inside a node with a message about the wrong thing entirely (a real
 * one: `Cannot read properties of undefined (reading 'title')`, three nodes from the actual mistake).
 */
export const triageItemSchema = z.object({
  /** Stable within a source, e.g. a GitHub issue number. */
  sourceId: z.string().min(1),
  title: z.string(),
  body: z.string().default(""),
  url: z.string().default(""),
  author: z.string().default("unknown"),
  labels: z.array(z.string()).default([]),
});

export type TriageItem = z.infer<typeof triageItemSchema>;

/** Thrown when a run is started with an input this graph cannot work with. */
export class TriageInputError extends Error {
  override readonly name = "TriageInputError";
}

/**
 * Validate the `item` a run was started with, or explain what was expected.
 *
 * The message names the field *and* what a correct input looks like, because the two ways to get here
 * are a hand-written playground input and a source whose shape drifted — and both are fixed by seeing
 * the shape.
 */
export function requireTriageItem(item: unknown): TriageItem {
  const parsed = triageItemSchema.safeParse(item);
  if (parsed.success) return parsed.data;

  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new TriageInputError(
    `This graph triages one item and was started without a usable one — ${problems}. ` +
      `Expected input like ` +
      `{"item":{"sourceId":"123","title":"Login is broken","body":"…","url":"https://…","author":"someone","labels":[]}}. ` +
      `If you meant to chat, this graph has no messages channel: pick a chat graph instead.`,
  );
}

/** The subset of GitHub's issue JSON this example reads. */
interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { login: string } | null;
  labels: Array<string | { name?: string }>;
  pull_request?: unknown;
}

/**
 * The idempotency key for an item's run.
 *
 * This is the whole reason a re-sweep is safe. The cron fires every few minutes and sees the same
 * open issues each time; sending this as `Idempotency-Key` means the second sweep *replays* the
 * original run's response instead of triaging the issue again — and burning a model call to reach the
 * same answer. Scoped by source so two sources can share an id without colliding.
 */
export function dedupeKey(source: string, item: TriageItem): string {
  return `${source}:${item.sourceId}`;
}

/**
 * A stable thread id for an item, derived from its dedupe key.
 *
 * The thread has to be *named*, not just created with `ifExists: "do_nothing"` — that flag only means
 * anything when a `threadId` is supplied, so without one the server mints a fresh UUID on every sweep.
 * That is subtle and it bit this example: each sweep silently started a new thread, which meant the
 * `Idempotency-Key` (scoped to its thread) never matched and nothing ever replayed.
 *
 * A SHA-256 of the key, formatted as a v5-shaped UUID: deterministic, collision-free in practice, and
 * it keeps every re-sweep of an item landing on the same thread with its full history.
 */
export function threadIdFor(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    // Version 5 (name-based) and the RFC 4122 variant bits, so this is a well-formed UUID.
    `5${digest.slice(13, 16)}`,
    ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join("-");
}

/**
 * Normalize GitHub's issue payload. Pull requests are dropped: the issues endpoint returns them too,
 * and a PR is not an issue to triage.
 */
export function normalizeGitHubIssues(payload: unknown): TriageItem[] {
  if (!Array.isArray(payload)) return [];
  return (payload as GitHubIssue[])
    .filter((issue) => issue.pull_request === undefined)
    .map((issue) => ({
      sourceId: String(issue.number),
      title: issue.title ?? "",
      // Long issue bodies are the common case and most of the tail is templates and stack traces.
      // Truncating here keeps the prompt bounded without the graph having to think about it.
      body: (issue.body ?? "").slice(0, 4000),
      url: issue.html_url ?? "",
      author: issue.user?.login ?? "unknown",
      labels: (issue.labels ?? [])
        .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
        .filter((label) => label !== ""),
    }));
}

/** Where a sweep gets its work. `fixture` is the default so the example runs with no network. */
export type TriageSource = "fixture" | "github";

export function resolveSource(): TriageSource {
  return process.env["TRIAGE_SOURCE"] === "github" ? "github" : "fixture";
}

/**
 * Bundled sample issues — the default source.
 *
 * An example that needs a network round-trip and a live repository before it shows you anything is an
 * example most people abandon at step one. These are shaped exactly like GitHub's payload and go
 * through the same normalization, so switching `TRIAGE_SOURCE=github` changes where the items come
 * from and nothing else.
 */
export function fixtureIssues(limit = 5): TriageItem[] {
  return normalizeGitHubIssues(fixturePayload).slice(0, limit);
}

/** Items from whichever source is configured. */
export async function fetchItems(
  options: { repo?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<TriageItem[]> {
  if (resolveSource() === "fixture") return fixtureIssues(options.limit ?? 5);
  return fetchOpenIssues(
    options.repo ?? process.env["TRIAGE_REPO"] ?? "skein-js/skein-js",
    options,
  );
}

/**
 * Fetch open issues for a public repo. Unauthenticated on purpose — this is an example, and GitHub's
 * anonymous rate limit is plenty for a five-minute sweep. Set `GITHUB_TOKEN` to raise it.
 */
export async function fetchOpenIssues(
  repo: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<TriageItem[]> {
  const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=${options.limit ?? 5}`;
  const token = process.env["GITHUB_TOKEN"];
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} ${response.statusText} for ${repo}`);
  }
  return normalizeGitHubIssues(await response.json());
}

/** A triage verdict, as the model is asked to produce it. */
export interface Verdict {
  category: "bug" | "feature" | "question" | "docs" | "spam";
  severity: "low" | "medium" | "high";
  reply: string;
  reasoning: string;
}

const CATEGORIES = new Set(["bug", "feature", "question", "docs", "spam"]);
const SEVERITIES = new Set(["low", "medium", "high"]);

/**
 * Parse a model's verdict defensively.
 *
 * Models return JSON in a code fence about as often as they return it bare, and an unparsable answer
 * must not crash a scheduled run at 3am — it becomes a low-confidence "question" that a human will see
 * in the approval queue anyway.
 */
export function parseVerdict(raw: string): Verdict {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  try {
    const parsed = JSON.parse(candidate) as Partial<Verdict>;
    return {
      category: CATEGORIES.has(parsed.category ?? "")
        ? (parsed.category as Verdict["category"])
        : "question",
      severity: SEVERITIES.has(parsed.severity ?? "")
        ? (parsed.severity as Verdict["severity"])
        : "low",
      reply: typeof parsed.reply === "string" ? parsed.reply : "",
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch {
    return {
      category: "question",
      severity: "low",
      reply: "",
      reasoning: `Could not parse the model's answer: ${candidate.slice(0, 200)}`,
    };
  }
}
