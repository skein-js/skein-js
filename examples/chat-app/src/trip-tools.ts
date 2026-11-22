// The trip-planner tools — deterministic, key-free mock data that showcases two things the chat UI
// renders richly: (1) structured JSON tool results (weather + flight cards, not raw text) and
// (2) a human-in-the-loop approval gate. `book_flight` calls LangGraph's `interrupt()` to pause the
// run and wait for the user to approve in the UI; skein injects a checkpointer, so interrupt/resume
// works out of the box (see docs/streaming.md + the run engine's paused -> interrupted handling).
//
// The pure builders (`weatherFor`, `flightsFor`, `lookupFlight`) live here without the tool wrappers
// so the unit suite can assert their shapes without a model. All data is generated deterministically
// from the input, so a demo (and its tests) produce the same result every time — no API key, no
// network. The tools label these as simulated flight options and bookings.

import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";

// --- weather ------------------------------------------------------------------------------------

/** A five-day forecast plus the current conditions, trimmed to what a weather card needs. */
export interface WeatherResult {
  location: string;
  current: { tempC: number; condition: Condition };
  forecast: Array<{ day: string; highC: number; lowC: number; condition: Condition }>;
}

/** The conditions the UI has an icon for — keep the set small and closed so rendering is total. */
export type Condition = "sunny" | "cloudy" | "rainy" | "snowy" | "windy";

const CONDITIONS: Condition[] = ["sunny", "cloudy", "rainy", "snowy", "windy"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A stable non-negative hash of a string, so the same location always yields the same forecast. */
function seedFrom(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/** Deterministic weather for a location: same input -> same forecast, no network. */
export function weatherFor(location: string): WeatherResult {
  const seed = seedFrom(location.toLowerCase());
  const baseTemp = 6 + (seed % 22); // 6–27°C, stable per location

  const forecast = WEEKDAYS.slice(0, 5).map((day, index) => {
    const highC = baseTemp + ((seed >> index) % 6);
    return {
      day,
      highC,
      lowC: highC - (4 + ((seed >> (index + 3)) % 4)),
      condition: CONDITIONS[(seed + index) % CONDITIONS.length]!,
    };
  });
  return {
    location,
    current: { tempC: baseTemp, condition: CONDITIONS[seed % CONDITIONS.length]! },
    forecast,
  };
}

export const getWeatherTool = tool(
  async ({ location }: { location: string }) => JSON.stringify(weatherFor(location)),
  {
    name: "get_weather",
    description:
      "Get the current conditions and a 5-day forecast for a city. Returns structured JSON the UI renders as a weather card.",
    schema: z.object({
      location: z.string().describe("City name, e.g. 'Tokyo' or 'San Francisco'"),
    }),
  },
);

// --- flight search ------------------------------------------------------------------------------

/** One flight option, shaped for a flight card and for `book_flight` to look up by id. */
export interface Flight {
  id: string;
  airline: string;
  depart: string; // "HH:MM"
  arrive: string; // "HH:MM"
  durationMin: number;
  stops: number;
  priceUsd: number;
}

export interface FlightSearchResult {
  from: string;
  to: string;
  flights: Flight[];
}

const AIRLINES = ["Skein Air", "Loom Airways", "Weft Jet", "Warp Atlantic"];

/** Normalize a place to a 3-letter code so flight ids are compact and stable ("San Francisco" -> "SAN"). */
function code(place: string): string {
  const letters = place.toUpperCase().replace(/[^A-Z]/g, "");
  return (letters + "XXX").slice(0, 3);
}

function minutesToClock(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Deterministic flight options between two places, cheapest first. Same inputs -> same flights.
 * The seed derives from the 3-letter route codes (not the raw strings) so `lookupFlight`, which only
 * has the codes encoded in an id, regenerates the identical option list.
 */
export function flightsFor(from: string, to: string): FlightSearchResult {
  const route = `${code(from)}${code(to)}`;
  const seed = seedFrom(route);

  const flights = Array.from({ length: 4 }, (_unused, index): Flight => {
    const departMinutes = 6 * 60 + index * 3 * 60 + (seed % 45); // spread across the day
    const durationMin = 120 + ((seed >> index) % 9) * 30; // 2h–6h
    const stops = index === 3 ? 1 : 0; // one connecting option
    return {
      id: `${route}-${100 + index}`,
      airline: AIRLINES[(seed + index) % AIRLINES.length]!,
      depart: minutesToClock(departMinutes),
      arrive: minutesToClock(departMinutes + durationMin),
      durationMin,
      stops,
      priceUsd: 149 + ((seed >> (index + 1)) % 20) * 25 + index * 40,
    };
  });
  flights.sort((a, b) => a.priceUsd - b.priceUsd);
  return { from, to, flights };
}

export const searchFlightsTool = tool(
  async ({ from, to }: { from: string; to: string; date?: string }) =>
    JSON.stringify(flightsFor(from, to)),
  {
    name: "search_flights",
    description:
      "Return sample flights between two cities or airports for the demo's flight cards.",
    schema: z.object({
      from: z.string().describe("Origin city or airport"),
      to: z.string().describe("Destination city or airport"),
      date: z.string().optional().describe("Departure date (optional; ignored by the mock)"),
    }),
  },
);

// --- booking (human-in-the-loop) ----------------------------------------------------------------

/** The result of a booking attempt — `booked` carries a confirmation code; `cancelled` does not. */
export interface BookingResult {
  status: "booked" | "cancelled";
  flightId: string;
  flight?: Flight;
  confirmation?: string;
}

/** The payload surfaced to the UI while the run is paused for approval (thread.interrupt.value). */
export interface BookingApprovalRequest {
  type: "approval";
  action: "book_flight";
  flight: Flight;
}

/** What the UI passes in the resume command. */
export interface BookingDecision {
  approved: boolean;
}

/**
 * Reconstruct a flight by its id. Because `flightsFor` is deterministic, the id encodes its route
 * ("SANTOK-101"), so we can regenerate the same option list and find the match — no shared state
 * between the search call and the book call is needed.
 */
export function lookupFlight(flightId: string): Flight | undefined {
  const match = /^([A-Z]{3})([A-Z]{3})-\d+$/.exec(flightId);
  if (!match) return undefined;
  const [, from, to] = match;
  return flightsFor(from!, to!).flights.find((flight) => flight.id === flightId);
}

export const bookFlightTool = tool(
  async ({ flightId }: { flightId: string }) => {
    const flight = lookupFlight(flightId);

    if (!flight) {
      return JSON.stringify({ status: "cancelled", flightId } satisfies BookingResult);
    }

    // Pause the run and hand the flight to the UI for explicit approval. On resume, `interrupt()`
    // returns whatever the client passed as the command's `resume` value.
    const decision = interrupt<BookingApprovalRequest, BookingDecision>({
      type: "approval",
      action: "book_flight",
      flight,
    });

    if (!decision?.approved) {
      return JSON.stringify({ status: "cancelled", flightId, flight } satisfies BookingResult);
    }

    const confirmation = `SKN-${flight.id.replace(/[^A-Z0-9]/g, "")}`;
    return JSON.stringify({
      status: "booked",
      flightId,
      flight,
      confirmation,
    } satisfies BookingResult);
  },
  {
    name: "book_flight",
    description:
      "Simulate booking a sample flight from `search_flights`. Pauses for approval. Does not book a real flight.",
    schema: z.object({ flightId: z.string().describe("The `id` of the flight to book") }),
  },
);
