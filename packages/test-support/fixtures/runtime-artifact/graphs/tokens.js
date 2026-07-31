// The runtime matrix's workload: a deterministic, model-free graph that streams a fixed number of
// fixed-size chunks. Plain JS, not TypeScript, because this directory stands in for a `skein build`
// artifact — the production image runs compiled JS and never carries a toolchain.
//
// Model-free on purpose: the matrix asks "does this runtime serve the protocol correctly", and a real
// provider's latency, token counts, and failure modes would drown that signal in variance.

import { AIMessageChunk } from "@langchain/core/messages";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";

const frames = Number(process.env["MATRIX_FRAMES"] ?? 50);
const frameBytes = Number(process.env["MATRIX_FRAME_BYTES"] ?? 1024);
const framesPerSecond = Number(process.env["MATRIX_FPS"] ?? 0);
const delayMs = framesPerSecond > 0 ? 1000 / framesPerSecond : 0;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// One shared filler string: chunks differ only by their prefix, so the graph's own allocation stays
// out of any retention the matrix measures.
const filler = "x".repeat(Math.max(0, frameBytes));

export const graph = new StateGraph(MessagesAnnotation)
  .addNode("stream", async (_state, config) => {
    for (let index = 0; index < frames; index += 1) {
      config?.writer?.(new AIMessageChunk({ content: `${index}:${filler}` }));
      if (delayMs > 0) await sleep(delayMs);
    }
    return { messages: [new AIMessageChunk({ content: "done" })] };
  })
  .addEdge(START, "stream")
  .addEdge("stream", END)
  .compile();
