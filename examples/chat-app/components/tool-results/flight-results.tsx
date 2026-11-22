"use client";

import { ArrowRight, Plane } from "lucide-react";

import { formatDuration, type FlightSearchResult } from "@/lib/tool-results";

/**
 * A `search_flights` result rendered as one card per option (cheapest first, as the tool sorts them).
 * The cheapest option is tagged so the model's "book the cheapest" flow has an obvious target. Booking
 * happens through `book_flight` (which pauses for approval) — these cards are read-only.
 */
export function FlightResults({ result }: { result: FlightSearchResult }) {
  return (
    <div className="flex flex-col gap-2" data-testid="flight-results">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <span>{result.from}</span>
        <ArrowRight className="size-3" />
        <span>{result.to}</span>
      </div>

      {result.flights.map((flight, index) => (
        <div
          key={flight.id}
          className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2"
          data-testid="flight-option"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <Plane className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <span className="tabular-nums">{flight.depart}</span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span className="tabular-nums">{flight.arrive}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {flight.airline} · {formatDuration(flight.durationMin)} ·{" "}
                {flight.stops === 0 ? "nonstop" : `${flight.stops} stop`}
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-sm font-semibold tabular-nums">${flight.priceUsd}</span>
            {index === 0 && (
              <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                Cheapest
              </span>
            )}
          </div>
        </div>
      ))}

      <p className="text-[11px] text-muted-foreground">
        Ask me to book one and I&apos;ll confirm first.
      </p>
    </div>
  );
}
