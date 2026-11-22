"use client";

import { CheckCircle2, XCircle } from "lucide-react";

import { formatDuration, type BookingResult } from "@/lib/tool-results";

/**
 * A `book_flight` result — the outcome after the user approved (or rejected) the human-in-the-loop
 * gate. `booked` shows the confirmation code; `cancelled` shows that nothing was booked.
 */
export function BookingConfirmation({ booking }: { booking: BookingResult }) {
  const booked = booking.status === "booked";
  return (
    <div
      className={
        booked
          ? "rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3"
          : "rounded-md border bg-muted/40 p-3"
      }
      data-testid="booking-confirmation"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        {booked ? (
          <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <XCircle className="size-4 text-muted-foreground" />
        )}
        <span>{booked ? "Flight booked" : "Booking cancelled"}</span>
      </div>

      {booking.flight && (
        <div className="mt-1.5 text-xs text-muted-foreground">
          {booking.flight.airline} · {booking.flight.depart}→{booking.flight.arrive} ·{" "}
          {formatDuration(booking.flight.durationMin)} · ${booking.flight.priceUsd}
        </div>
      )}
      {booked && booking.confirmation && (
        <div className="mt-1.5 text-xs">
          Confirmation:{" "}
          <span className="rounded bg-background/70 px-1.5 py-0.5 font-mono">
            {booking.confirmation}
          </span>
        </div>
      )}
    </div>
  );
}
