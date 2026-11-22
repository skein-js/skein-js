"use client";

import { Check, Plane, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDuration, type FlightApprovalRequest } from "@/lib/tool-results";

/**
 * The human-in-the-loop gate. When `book_flight` calls LangGraph's `interrupt()`, the run pauses and
 * skein surfaces the payload on `thread.interrupt.value`; this card renders it and lets the user
 * approve or reject. The choice is sent back with `thread.submit(undefined, { command: { resume } })`,
 * which resumes the paused run (see docs/streaming.md + the run engine's interrupted -> resume path).
 */
export function ApprovalCard({
  request,
  disabled,
  onDecision,
}: {
  request: FlightApprovalRequest;
  disabled: boolean;
  onDecision: (approved: boolean) => void;
}) {
  const { flight } = request;
  return (
    <div
      className="rounded-lg border-2 border-primary/40 bg-background p-4"
      data-testid="approval-card"
    >
      <div className="text-sm font-medium">Confirm booking</div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        The assistant paused and is waiting for your approval before booking.
      </p>

      <div className="mt-3 flex items-center gap-2.5 rounded-md bg-muted/50 px-3 py-2">
        <Plane className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium tabular-nums">
            {flight.depart} → {flight.arrive}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {flight.airline} · {formatDuration(flight.durationMin)} ·{" "}
            {flight.stops === 0 ? "nonstop" : `${flight.stops} stop`}
          </div>
        </div>
        <span className="text-sm font-semibold tabular-nums">${flight.priceUsd}</span>
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          disabled={disabled}
          onClick={() => onDecision(true)}
          data-testid="approve-button"
        >
          <Check />
          Approve &amp; book
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="flex-1"
          disabled={disabled}
          onClick={() => onDecision(false)}
          data-testid="reject-button"
        >
          <X />
          Reject
        </Button>
      </div>
    </div>
  );
}
