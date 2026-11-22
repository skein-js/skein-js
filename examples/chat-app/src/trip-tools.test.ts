// Hermetic unit tests for the trip-planner tools' pure builders — no model, no API key, no network.
// The mock data is deterministic, so we can assert exact structure and the search -> book id round-trip
// that `book_flight` relies on. Live tool orchestration (and the interrupt) is covered under a key.

import { describe, expect, it } from "vitest";

import { flightsFor, lookupFlight, weatherFor } from "./trip-tools.js";

describe("weatherFor", () => {
  it("returns current conditions plus a 5-day forecast", () => {
    const weather = weatherFor("Tokyo");
    expect(weather.location).toBe("Tokyo");
    expect(weather.forecast).toHaveLength(5);

    for (const day of weather.forecast) {
      expect(day.highC).toBeGreaterThanOrEqual(day.lowC);
      expect(["sunny", "cloudy", "rainy", "snowy", "windy"]).toContain(day.condition);
    }
  });

  it("is deterministic — same location, same forecast", () => {
    expect(weatherFor("Paris")).toEqual(weatherFor("Paris"));
  });
});

describe("flightsFor", () => {
  it("returns options sorted cheapest-first with encoded ids", () => {
    const { flights } = flightsFor("San Francisco", "Tokyo");
    expect(flights.length).toBeGreaterThanOrEqual(3);
    const prices = flights.map((flight) => flight.priceUsd);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    // The id encodes the route so `book_flight` can look a flight back up without shared state.
    expect(flights[0]?.id).toMatch(/^[A-Z]{3}[A-Z]{3}-\d+$/);
  });

  it("is deterministic — same route, same flights", () => {
    expect(flightsFor("SFO", "NRT")).toEqual(flightsFor("SFO", "NRT"));
  });
});

describe("lookupFlight", () => {
  it("round-trips an id from search back to the same flight", () => {
    const first = flightsFor("San Francisco", "Tokyo").flights[0]!;
    expect(lookupFlight(first.id)).toEqual(first);
  });

  it("returns undefined for an unparseable id", () => {
    expect(lookupFlight("not-a-flight")).toBeUndefined();
  });
});
