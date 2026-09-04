// The sweep: what the cron actually fires.
//
//   START → fetch → filter → route ─┬→ dispatch → report → END
//                                   └→ report ──────────→ END
//
// It creates one background run per *new* item and returns. That shape is the point — the sweep stays
// fast and boring, and the expensive per-item work becomes N independently durable runs the console
// can show, cancel, fork and approve one at a time.
//
// Two things make it more than a fan-out loop:
//
//   • `filter` reads the store and drops items already decided, so a sweep genuinely does less work
//     each time rather than re-dispatching the same backlog every five minutes forever.
//   • every create carries an `Idempotency-Key`, and the sweep *checks whether it got the original run
//     back*. That turns "LangGraph Platform has no equivalent of this" from a claim in a README into a
//     number in the sweep's own output: `replayed 6`.

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { Client } from "@langchain/langgraph-sdk";

import {
  dedupeKey,
  fetchItems,
  resolveSource,
  threadIdFor,
  type TriageItem,
} from "./triage-sources.js";

/** One dispatch outcome, kept structured so `report` can count rather than parse strings. */
interface Dispatch {
  key: string;
  threadId: string;
  runId: string;
  /** True when the idempotency key returned the run a previous sweep created. */
  replayed: boolean;
}

const SweepState = Annotation.Root({
  /** `owner/name`, used only when `TRIAGE_SOURCE=github`. */
  repo: Annotation<string>({
    reducer: (_, next) => next,
    default: () => process.env["TRIAGE_REPO"] ?? "skein-js/skein-js",
  }),
  limit: Annotation<number>({ reducer: (_, next) => next, default: () => 5 }),
  /** Re-dispatch items that already have a recorded decision. Off by default — see `filter`. */
  force: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),

  fetched: Annotation<TriageItem[]>({ reducer: (_, next) => next, default: () => [] }),
  fresh: Annotation<TriageItem[]>({ reducer: (_, next) => next, default: () => [] }),
  /** Items skipped because they were already triaged, with the decision that settled them. */
  skipped: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  dispatched: Annotation<Dispatch[]>({ reducer: (_, next) => next, default: () => [] }),
  failed: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  summary: Annotation<string | undefined>({ reducer: (_, next) => next, default: () => undefined }),
});

type State = typeof SweepState.State;

/** The graph each item is dispatched to. */
const TRIAGE_ASSISTANT = "triage";
const DECISIONS_NAMESPACE = ["triage", "decisions"];
/** A sweep's own history, so the console's store browser shows what the schedule has been doing. */
const SWEEPS_NAMESPACE = ["triage", "sweeps"];
/** Which run each idempotency key first produced — how a replay is recognized on the next sweep. */
const DISPATCH_NAMESPACE = ["triage", "dispatches"];

function apiUrl(): string {
  return process.env["SKEIN_API_URL"] ?? `http://127.0.0.1:${process.env["PORT"] ?? "2024"}`;
}

/**
 * The server this sweep dispatches into — itself.
 *
 * A graph reaching back through its own HTTP API looks odd for a second, and is exactly right here:
 * run creation is the thing being demonstrated (idempotency keys, webhooks, multitask), and those are
 * HTTP-level features with no in-process equivalent.
 */
function selfClient(headers: Record<string, string> = {}): Client {
  return new Client({
    apiUrl: apiUrl(),
    ...(process.env["SKEIN_API_KEY"] ? { apiKey: process.env["SKEIN_API_KEY"] } : {}),
    // The **only** way to send a per-request header through this SDK.
    //
    // `runs.create` builds its request body from a fixed field list and has no `headers` option, so a
    // `headers` key passed in the payload is silently dropped — the request goes out without it and
    // creates a brand-new run every sweep. This example did exactly that until the replay counter in
    // `report` said `0 replayed` and gave it away. A client per key is cheap; a silently missing
    // idempotency key is not.
    defaultHeaders: headers,
  });
}

/**
 * The store is a premise of this graph, not an optional extra — so say so instead of degrading.
 *
 * All three callers used to guard with `if (store)` and carry on, and the sweep is where that was
 * worst: with the reads skipped every occurrence re-dispatched the whole backlog, and with the writes
 * skipped `report` still announced `3 dispatched` over a store holding nothing. That summary is the
 * evidence that opened this bug.
 */
function requireStore(
  config: LangGraphRunnableConfig,
): NonNullable<LangGraphRunnableConfig["store"]> {
  const store = config.store;
  if (!store) {
    throw new Error(
      "no long-term store on the run config — the triage example needs one. Under `skein dev` it " +
        "is wired automatically; check that the server was started by the skein CLI.",
    );
  }
  return store;
}

async function fetchWork(state: State): Promise<Partial<State>> {
  return { fetched: await fetchItems({ repo: state.repo, limit: state.limit }) };
}

/**
 * Drop what has already been decided.
 *
 * The idempotency key alone would stop a re-sweep from *re-running* an item, but the sweep would still
 * create a thread and a run row for each one every five minutes forever. Reading the decisions back
 * means a settled backlog costs one store read, and the queue visibly quiets down as work gets done —
 * which is what a triage queue should do.
 */
async function filterDecided(
  state: State,
  config: LangGraphRunnableConfig,
): Promise<Partial<State>> {
  const store = requireStore(config);
  // `--force` still re-runs settled items deliberately; that is a request, not a missing store.
  if (state.force) return { fresh: state.fetched, skipped: [] };

  const fresh: TriageItem[] = [];
  const skipped: string[] = [];
  for (const item of state.fetched) {
    const decided = await store.get(DECISIONS_NAMESPACE, item.sourceId);
    if (decided) {
      const value = decided.value as { category?: string; severity?: string };
      skipped.push(
        `${item.sourceId} — already ${value.category ?? "decided"}/${value.severity ?? "?"}`,
      );
    } else {
      fresh.push(item);
    }
  }
  return { fresh, skipped };
}

/** Nothing new is the common case for a healthy queue, and it should cost nothing. */
export function routeSweep(state: State): "dispatch" | "report" {
  return state.fresh.length > 0 ? "dispatch" : "report";
}

async function dispatch(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
  const client = selfClient();
  const store = requireStore(config);

  // Confirm the target actually serves the graph we are about to dispatch into, before dispatching
  // anything. `SKEIN_API_URL` defaults to port 2024, so a server started on another port sends its
  // whole sweep to *a different server* — which succeeds, looks fine, and puts the work somewhere
  // nobody is looking.
  try {
    await client.assistants.get(TRIAGE_ASSISTANT);
  } catch (error) {
    throw new Error(
      `The sweep cannot see a "${TRIAGE_ASSISTANT}" graph at ${apiUrl()} ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        `Set SKEIN_API_URL to this server's own address — it defaults to port 2024.`,
    );
  }

  const dispatched: Dispatch[] = [];
  const failed: string[] = [];

  for (const item of state.fresh) {
    const key = dedupeKey(resolveSource(), item);
    try {
      // A thread per item, *named* after the item. The explicit id is what makes this work at all:
      // `ifExists` only applies when a `threadId` is supplied, so without one every sweep mints a new
      // thread — and the idempotency key, which is scoped to its thread, never matches.
      const thread = await client.threads.create({
        threadId: threadIdFor(key),
        // Everything the console needs to render this row as a work item rather than a UUID.
        metadata: {
          source: resolveSource(),
          sourceId: item.sourceId,
          title: item.title,
          author: item.author,
          url: item.url,
          key,
        },
        ifExists: "do_nothing",
      });

      const previousRunId = (await store.get(DISPATCH_NAMESPACE, key))?.value["runId"] as
        string | undefined;

      // A client carrying this item's idempotency key. A second sweep of the same item replays the
      // original response instead of starting a second run.
      const idempotent = selfClient({ "Idempotency-Key": key });
      const run = await idempotent.runs.create(thread.thread_id, TRIAGE_ASSISTANT, {
        input: { item },
        // Best-effort completion notice; absent unless configured, so the example needs no listener.
        ...(process.env["TRIAGE_WEBHOOK"] ? { webhook: process.env["TRIAGE_WEBHOOK"] } : {}),
        // If this item is somehow already running, leave it alone rather than interrupting work.
        multitaskStrategy: "reject",
      } as Parameters<typeof idempotent.runs.create>[2]);

      // Getting the *same* run id back is the idempotency key doing its job, and the only way to
      // observe that from outside is to have remembered what the first sweep produced.
      const replayed = previousRunId === run.run_id;
      if (!replayed) {
        await store.put(DISPATCH_NAMESPACE, key, { runId: run.run_id, threadId: thread.thread_id });
      }
      dispatched.push({ key, threadId: thread.thread_id, runId: run.run_id, replayed });
    } catch (error) {
      // One bad item must not fail the sweep: the next occurrence would then never dispatch the good
      // ones either. Record it and carry on.
      failed.push(`${key} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { dispatched, failed };
}

/**
 * Write the sweep down, and say what it did in one line.
 *
 * The store record is what makes a schedule auditable: the console's store browser under
 * `triage/sweeps` becomes a history of what the cron has actually been doing, which is otherwise
 * invisible between occurrences.
 */
async function report(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
  const started = state.dispatched.filter((entry) => !entry.replayed).length;
  const replayed = state.dispatched.length - started;
  const summary =
    `swept ${state.fetched.length} from ${resolveSource()} — ` +
    `${started} dispatched, ${replayed} replayed, ${state.skipped.length} already decided` +
    (state.failed.length > 0 ? `, ${state.failed.length} failed` : "");

  // Keyed by time so sweeps accumulate into a readable history rather than overwriting each other.
  await requireStore(config).put(SWEEPS_NAMESPACE, new Date().toISOString(), {
    source: resolveSource(),
    fetched: state.fetched.length,
    started,
    replayed,
    skipped: state.skipped.length,
    failed: state.failed,
    summary,
  });
  return { summary };
}

export const graph = new StateGraph(SweepState)
  .addNode("fetch", fetchWork)
  .addNode("filter", filterDecided)
  .addNode("dispatch", dispatch)
  .addNode("report", report)
  .addEdge(START, "fetch")
  .addEdge("fetch", "filter")
  .addConditionalEdges("filter", routeSweep, { dispatch: "dispatch", report: "report" })
  .addEdge("dispatch", "report")
  .addEdge("report", END)
  .compile();
