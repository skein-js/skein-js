"use client";

import { Brain, Cloud, Plane, Search, Wrench } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { BookingConfirmation } from "@/components/tool-results/booking-confirmation";
import { FlightResults } from "@/components/tool-results/flight-results";
import { WeatherCard } from "@/components/tool-results/weather-card";
import { Card, CardContent } from "@/components/ui/card";
import { toolLabel, type ToolCall } from "@/lib/messages";
import { parseBooking, parseFlights, parseWeather } from "@/lib/tool-results";

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  web_search: Search,
  save_memory: Brain,
  recall_memory: Brain,
  get_weather: Cloud,
  search_flights: Plane,
  book_flight: Plane,
};

/** The argument to echo in the card header, per tool — a compact "what was this called with". */
function primaryArg(call: ToolCall): string | undefined {
  const args = call.args;
  if (typeof args["query"] === "string") return args["query"];
  if (typeof args["content"] === "string") return args["content"];
  if (typeof args["location"] === "string") return args["location"];

  if (typeof args["from"] === "string" && typeof args["to"] === "string") {
    return `${args["from"]} → ${args["to"]}`;
  }

  if (typeof args["flightId"] === "string") return args["flightId"];
  return undefined;
}

/**
 * Render a structured tool result as a rich card, or null to fall back to the plain-text box. This is
 * the "JSON render" dispatcher: trip-planner tools return JSON, which we parse and render as cards;
 * anything else (web_search, save_memory) keeps the plain-text output.
 */
function structuredResult(name: string, result: string): ReactNode {
  if (name === "get_weather") {
    const weather = parseWeather(result);
    return weather ? <WeatherCard weather={weather} /> : null;
  }

  if (name === "search_flights") {
    const flights = parseFlights(result);
    return flights ? <FlightResults result={flights} /> : null;
  }

  if (name === "book_flight") {
    const booking = parseBooking(result);
    return booking ? <BookingConfirmation booking={booking} /> : null;
  }

  return null;
}

/**
 * One tool call the agent made, with the argument it was called with and — once the matching tool
 * message arrives — its result. Structured (JSON) results render as rich cards; the rest render as
 * the raw text the tool returned.
 */
export function ToolCallCard({ call, result }: { call: ToolCall; result?: string }) {
  const Icon = ICONS[call.name] ?? Wrench;
  const arg = primaryArg(call);
  const rich = result ? structuredResult(call.name, result) : null;

  return (
    <Card className="bg-muted/40" data-testid="tool-call">
      <CardContent className="flex flex-col gap-1.5 p-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Icon className="size-3.5 text-muted-foreground" />
          <span>{toolLabel(call.name)}</span>
          {arg && <span className="truncate text-muted-foreground">“{arg}”</span>}
        </div>
        {rich}
        {result && !rich && (
          <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-background/60 p-2 text-xs leading-relaxed text-muted-foreground">
            {result}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
