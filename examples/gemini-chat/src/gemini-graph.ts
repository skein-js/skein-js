import { tool } from "@langchain/core/tools";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";

/**
 * A real Gemini-backed ReAct agent whose `get_weather` tool fetches live conditions from Open-Meteo
 * (https://open-meteo.com) — a free, no-API-key weather service. Ask e.g. "what's the weather in
 * Nairobi?" and it geocodes the city, pulls the current forecast, and answers from real data. Streams
 * tokens over SSE, so it's the graph to point a `useStream` UI at.
 *
 * Requires GOOGLE_API_KEY (a Gemini Developer API key from https://aistudio.google.com/apikey) for
 * the model — the weather tool itself needs no key. Model is overridable via GOOGLE_MODEL.
 */

// WMO weather-interpretation codes → short text (the values Open-Meteo returns most often).
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "dense drizzle",
  61: "slight rain",
  63: "rain",
  65: "heavy rain",
  71: "slight snow",
  73: "snow",
  75: "heavy snow",
  80: "rain showers",
  95: "thunderstorm",
};

interface GeocodeResponse {
  results?: { latitude: number; longitude: number; name: string; country?: string }[];
}
interface ForecastResponse {
  current?: { temperature_2m: number; wind_speed_10m: number; weather_code: number };
}

const getWeather = tool(
  async ({ city }: { city: string }): Promise<string> => {
    const geo = (await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
    ).then((response) => response.json())) as GeocodeResponse;
    const place = geo.results?.[0];
    if (!place) return `I couldn't find a place called "${city}".`;

    const forecast = (await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,wind_speed_10m,weather_code`,
    ).then((response) => response.json())) as ForecastResponse;
    const current = forecast.current;
    if (!current) return `I couldn't fetch the current weather for ${place.name}.`;

    const conditions =
      WEATHER_CODES[current.weather_code] ?? `weather code ${current.weather_code}`;
    const where = place.country ? `${place.name}, ${place.country}` : place.name;
    return `Current weather in ${where}: ${conditions}, ${current.temperature_2m}°C, wind ${current.wind_speed_10m} km/h.`;
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city, using the free Open-Meteo API.",
    schema: z.object({ city: z.string().describe("City name, e.g. 'Nairobi' or 'Tokyo'") }),
  },
);

const model = new ChatGoogleGenerativeAI({
  model: process.env.GOOGLE_MODEL ?? "gemini-2.5-flash",
  temperature: 0,
});

export const graph = createReactAgent({ llm: model, tools: [getWeather] });
