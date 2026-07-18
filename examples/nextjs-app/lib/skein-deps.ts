// Build the Agent Protocol runtime from graphs defined in this app — no `langgraph.json`. `embedInMemoryGraphs`
// turns a graph map into a `ProtocolDeps` backed by in-process drivers (store, queue, bus, checkpointer);
// this is the injected-`deps` seam every skein adapter accepts, and it works under both `next dev` and
// `next build`/`next start` (unlike the `{ config }` path, which would dynamically `import()` a `.ts`
// graph at runtime — no TS loader in a Next server).
//
// `echo` is a pure, zero-setup graph, so it is imported statically. `agent` constructs a
// `ChatGoogleGenerativeAI` at module load (which throws without GOOGLE_API_KEY), so it is a factory that
// imports lazily — only when the `agent` graph is actually requested — keeping a keyless build and the
// echo path model-free.
//
// For serverless/edge deploys where no single process stays warm, swap the in-memory drivers for the
// Redis queue + Postgres store via `embedInMemoryGraphs({ ... }, { store, queue, checkpointer })` (see
// @skein-js/runtime's `buildRuntime`).

import { embedInMemoryGraphs } from "@skein-js/server-kit";

import { graph as echo } from "../graphs/echo-graph";

export const deps = embedInMemoryGraphs({
  echo,
  agent: async () => (await import("../graphs/agent-graph")).graph,
});
