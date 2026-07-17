import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

/**
 * A real Claude-backed ReAct agent with one tool. Streams tokens over SSE, so it's the
 * graph to use when playing with `useStream` (see examples/react-usestream).
 *
 * Requires ANTHROPIC_API_KEY. Model is overridable via ANTHROPIC_MODEL.
 */
const getWeather = tool(async ({ city }: { city: string }) => `It's always sunny in ${city}.`, {
  name: "get_weather",
  description: "Get the current weather for a city.",
  schema: z.object({ city: z.string().describe("City to look up") }),
});

const model = new ChatAnthropic({
  model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  temperature: 0,
});

export const graph = createReactAgent({ llm: model, tools: [getWeather] });
