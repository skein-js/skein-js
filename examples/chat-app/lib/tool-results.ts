// The client-side view of the structured JSON the trip-planner tools return. The tools
// (`src/trip-tools.ts`) `JSON.stringify` these shapes; `toolResultsByCall` (lib/messages.ts) hands the
// string to a ToolCallCard, which parses it here and renders a rich card instead of raw text.
//
// The interfaces mirror the backend by structure (not import): the backend module pulls in
// `@langchain/langgraph`, which shouldn't reach the client bundle, so we re-declare the wire shape and
// validate what we parse. Anything that fails these guards falls back to the plain-text result box.

export type WeatherCondition = "sunny" | "cloudy" | "rainy" | "snowy" | "windy";

export interface WeatherResult {
  location: string;
  current: { tempC: number; condition: WeatherCondition };
  forecast: Array<{ day: string; highC: number; lowC: number; condition: WeatherCondition }>;
}

export interface Flight {
  id: string;
  airline: string;
  depart: string;
  arrive: string;
  durationMin: number;
  stops: number;
  priceUsd: number;
}

export interface FlightSearchResult {
  from: string;
  to: string;
  flights: Flight[];
}

export interface BookingResult {
  status: "booked" | "cancelled";
  flightId: string;
  flight?: Flight;
  confirmation?: string;
}

/** The payload the paused `book_flight` run surfaces on `thread.interrupt.value` for approval. */
export interface FlightApprovalRequest {
  type: "approval";
  action: "book_flight";
  flight: Flight;
}

/** Tool names whose results are structured JSON (so a ToolCallCard should try a rich renderer). */
export const STRUCTURED_TOOL_NAMES = new Set(["get_weather", "search_flights", "book_flight"]);

/** Parse a tool-result string as JSON, returning null on any error (never throws). */
export function safeParse(json: string | undefined): unknown {
  if (!json) return null;

  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse a `get_weather` result, or null if it isn't a well-formed weather payload. */
export function parseWeather(json: string | undefined): WeatherResult | null {
  const value = safeParse(json);

  if (
    !isObject(value) ||
    typeof value["location"] !== "string" ||
    !Array.isArray(value["forecast"])
  ) {
    return null;
  }

  return value as unknown as WeatherResult;
}

/** Parse a `search_flights` result, or null if it isn't a well-formed flight-search payload. */
export function parseFlights(json: string | undefined): FlightSearchResult | null {
  const value = safeParse(json);
  if (!isObject(value) || !Array.isArray(value["flights"])) return null;
  return value as unknown as FlightSearchResult;
}

/** Parse a `book_flight` result, or null if it isn't a well-formed booking payload. */
export function parseBooking(json: string | undefined): BookingResult | null {
  const value = safeParse(json);

  if (!isObject(value) || (value["status"] !== "booked" && value["status"] !== "cancelled")) {
    return null;
  }

  return value as unknown as BookingResult;
}

/** Narrow an interrupt value to a flight-approval request, or null if it isn't one. */
export function parseApproval(value: unknown): FlightApprovalRequest | null {
  if (!isObject(value) || value["type"] !== "approval" || value["action"] !== "book_flight") {
    return null;
  }

  if (!isObject(value["flight"])) return null;
  return value as unknown as FlightApprovalRequest;
}

/** Minutes -> "2h 30m", for flight durations. */
export function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
