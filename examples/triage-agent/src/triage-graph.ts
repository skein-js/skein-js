// The triage graph: work out what an item is, decide whether a human needs to see it, and record it.
//
// One item per thread, on purpose. It makes every item independently resumable, independently
// forkable, and independently approvable — and it is what turns the console's thread list into a work
// queue you can actually operate.
//
// The shape is deliberately not a straight line:
//
//   START → prepare → gather → classify → critique → route ─┬→ approve → record → END
//                                                           └→ record ───────────→ END
//
// The branch is the interesting part. Obvious spam and low-severity chatter record themselves;
// anything a human would actually want to see about stops and waits. That is the difference between
// an agent that automates triage and one that just adds a queue of approvals to your day — and it
// gives the console's graph diagram a decision to draw.

import { Annotation, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { createClassifier } from "./classifier.js";
import { requireTriageItem, type TriageItem, type Verdict } from "./triage-sources.js";

const TriageState = Annotation.Root({
  item: Annotation<TriageItem>({ reducer: (_, next) => next }),
  /** Conventions recalled from the store, so the agent triages the way this project already does. */
  conventions: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  /** Titles of previously triaged items that look related — context for the classifier. */
  related: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  verdict: Annotation<Verdict | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),
  /** How the verdict was reached, so a rules-based run is never mistaken for a model one. */
  decidedBy: Annotation<string | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),
  /** Why this item did or did not need a human. */
  routedBecause: Annotation<string | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),
  /** What the human decided. `false` means the draft was rejected and nothing is recorded. */
  approved: Annotation<boolean | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),
  outcome: Annotation<string | undefined>({ reducer: (_, next) => next, default: () => undefined }),
});

type State = typeof TriageState.State;

/** What the agent has learned about triaging this project. */
const CONVENTIONS_NAMESPACE = ["triage", "conventions"];
/** Decisions it has recorded — the "action", which never leaves this server. */
const DECISIONS_NAMESPACE = ["triage", "decisions"];

/**
 * The store is a premise of this graph, not an optional extra — so say so instead of degrading.
 *
 * Both callers used to guard with `if (store)` and carry on. `record` was the harmful one: it skipped
 * the write and still returned `recorded as ...`, so a decision could be reported and lost in the same
 * breath. `gather` merely classified with no context, which is quieter but no more correct.
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

/**
 * Validate the input, before anything expensive happens.
 *
 * Its own node rather than a check inside the next one, so a bad input fails on a step called
 * `prepare` in the console's diagram. It used to survive to `classify` and die there on
 * `state.item.title`, pointing at the wrong line entirely.
 */
function prepare(state: State): Partial<State> {
  return { item: requireTriageItem(state.item) };
}

/**
 * Read context out of the store: learned conventions, and anything already triaged that looks
 * related. The store is injected by skein — reachable as `config.store` here, or `getStore()` where
 * there is no config argument — so this is the same code against in-memory storage under `skein dev`
 * and Postgres + pgvector in production.
 */
async function gather(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
  const store = requireStore(config);

  const [conventions, decisions] = await Promise.all([
    store.search(CONVENTIONS_NAMESPACE, { limit: 10 }),
    // A semantic query when the store is index-backed, a plain listing when it is not — the store
    // answers both, so the graph does not have to know which it got.
    store.search(DECISIONS_NAMESPACE, { limit: 5, query: state.item.title }),
  ]);

  return {
    conventions: conventions
      .map((entry) => (typeof entry.value["text"] === "string" ? entry.value["text"] : ""))
      .filter((text) => text !== ""),
    related: decisions
      .map((entry) => (typeof entry.value["title"] === "string" ? entry.value["title"] : ""))
      .filter((title) => title !== "" && title !== state.item.title),
  };
}

async function classify(state: State): Promise<Partial<State>> {
  const classifier = createClassifier();
  const verdict = await classifier.classify(state.item, {
    conventions: state.conventions,
    related: state.related,
  });
  return { verdict, decidedBy: classifier.label };
}

/**
 * A cheap self-check on the verdict.
 *
 * Not a second model call — just the rules that catch a classifier contradicting itself. Spam with a
 * drafted reply, and a "high severity question", are the two shapes that reliably mean the verdict
 * was guessed rather than reasoned, and both are cheaper to fix here than to explain to a human.
 */
function critique(state: State): Partial<State> {
  const verdict = state.verdict;
  if (!verdict) return {};
  const corrected: Verdict = { ...verdict };
  if (corrected.category === "spam") {
    corrected.reply = "";
    corrected.severity = "low";
  }
  if (corrected.category === "question" && corrected.severity === "high") {
    corrected.severity = "medium";
  }
  return { verdict: corrected };
}

/**
 * Does a human need to see this?
 *
 * Spam and low-severity non-bugs record themselves; everything else stops. A bug is never
 * auto-recorded regardless of severity — the cost of wrongly ignoring one is much higher than the
 * cost of one extra approval.
 */
export function routeForApproval(state: State): "approve" | "record" {
  const verdict = state.verdict;
  if (!verdict) return "approve";
  if (verdict.category === "spam") return "record";
  if (verdict.severity === "low" && verdict.category !== "bug") return "record";
  return "approve";
}

/** The same decision, as state — so the console shows *why* a thread is waiting, or why it never did. */
function explainRoute(state: State): Partial<State> {
  const verdict = state.verdict;
  if (!verdict) return { routedBecause: "no verdict — asking a human" };
  if (verdict.category === "spam") {
    // Recorded, not rejected. `approved: false` reads like "a human said no", and `record` skips the
    // store write for it — so spam never settled: the next sweep found no decision, re-dispatched it,
    // and the outcome line contradicted itself ("not recorded — recorded without asking"). Filing the
    // decision is exactly how a queue stops showing you the same spam every five minutes.
    return { routedBecause: "spam — filed without asking", approved: true };
  }
  if (verdict.severity === "low" && verdict.category !== "bug") {
    return {
      routedBecause: `low-severity ${verdict.category} — recorded without asking`,
      approved: true,
    };
  }
  return { routedBecause: `${verdict.severity} ${verdict.category} — needs a human` };
}

/**
 * Park until a human answers. The run stops here, the process can restart, and the thread waits — for
 * a second or a week — until someone resumes it from the console.
 */
function askForApproval(state: State): Partial<State> {
  const answer = interrupt({
    question: `Post this ${state.verdict?.category ?? "unknown"} reply?`,
    item: { title: state.item.title, url: state.item.url, author: state.item.author },
    verdict: state.verdict,
    decidedBy: state.decidedBy,
  });
  // `true`/`false` from the console's Approve/Reject; a string is an edited reply.
  if (typeof answer === "string") {
    return { approved: true, verdict: { ...(state.verdict as Verdict), reply: answer } };
  }
  return { approved: answer === true };
}

/**
 * Record the decision. Deliberately a store write and not a GitHub comment: an example that posts to
 * someone's repository the first time you run it is not a good example.
 */
async function record(state: State, config: LangGraphRunnableConfig): Promise<Partial<State>> {
  if (state.approved !== true) {
    return { outcome: `not recorded — ${state.routedBecause ?? "rejected"}` };
  }
  const store = requireStore(config);
  await store.put(DECISIONS_NAMESPACE, state.item.sourceId, {
    url: state.item.url,
    title: state.item.title,
    author: state.item.author,
    category: state.verdict?.category,
    severity: state.verdict?.severity,
    reply: state.verdict?.reply,
    decidedBy: state.decidedBy,
    routedBecause: state.routedBecause,
    decidedAt: new Date().toISOString(),
  });
  return {
    outcome: `recorded as ${state.verdict?.category}/${state.verdict?.severity} (${state.decidedBy})`,
  };
}

export const graph = new StateGraph(TriageState)
  .addNode("prepare", prepare)
  .addNode("gather", gather)
  .addNode("classify", classify)
  .addNode("critique", critique)
  .addNode("route", explainRoute)
  .addNode("approve", askForApproval)
  .addNode("record", record)
  .addEdge(START, "prepare")
  .addEdge("prepare", "gather")
  .addEdge("gather", "classify")
  .addEdge("classify", "critique")
  .addEdge("critique", "route")
  .addConditionalEdges("route", routeForApproval, { approve: "approve", record: "record" })
  .addEdge("approve", "record")
  .addEdge("record", END)
  .compile();

/** Exported for unit tests — the routing and critique rules are the graph's actual judgement. */
export { critique as applyCritique };
