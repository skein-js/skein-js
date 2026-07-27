// The benchmark's workload: a graph that streams a fixed number of fixed-size message chunks at a
// fixed rate. Deliberately model-free — a real provider's latency and token counts vary run to run,
// which would drown the memory deltas we are measuring. Everything here is a knob so a scenario can
// dial frame count, frame size, and production rate independently.

import { AIMessageChunk } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import { MessagesAnnotation } from "@langchain/langgraph";

/** Shape of the synthetic token stream a scenario asks for. */
export interface TokenStreamGraphOptions {
  /** Chunks emitted per run. */
  frames: number;
  /** Characters of filler per chunk — stands in for a token's payload. */
  frameBytes: number;
  /**
   * Chunks emitted per second, or `0` for "as fast as the event loop allows". A finite rate models a
   * real model's pacing; `0` is the stress case that makes an unbounded buffer grow fastest.
   */
  framesPerSecond: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Build a compiled graph whose single node streams {@link TokenStreamGraphOptions.frames} chunks.
 *
 * Chunk content is derived from the index rather than random so two runs of the same scenario
 * allocate identically — a prerequisite for comparing heap numbers across commits.
 */
export function createTokenStreamGraph(options: TokenStreamGraphOptions) {
  const { frames, frameBytes, framesPerSecond } = options;
  const delayMs = framesPerSecond > 0 ? 1000 / framesPerSecond : 0;
  // One shared filler string: the chunk payloads differ by their prefix, and interning the bulk keeps
  // the graph's own allocation out of the measurement we care about (the server's retention).
  const filler = "x".repeat(Math.max(0, frameBytes));

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("stream", async (_state, config) => {
      const writer = config?.writer;
      for (let index = 0; index < frames; index += 1) {
        const chunk = new AIMessageChunk({ content: `${index}:${filler}` });
        // `custom` mode goes straight through the engine's chunk path without the model plumbing a
        // real LLM would need, which is exactly the frame-per-token shape we want to measure.
        writer?.(chunk);
        if (delayMs > 0) await sleep(delayMs);
      }
      return { messages: [new AIMessageChunk({ content: "done" })] };
    })
    .addEdge(START, "stream")
    .addEdge("stream", END);

  return graph.compile();
}
