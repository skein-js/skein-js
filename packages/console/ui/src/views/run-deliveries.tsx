import { RefreshCw, RotateCcw } from "lucide-react";
import { useState } from "react";

import { createSkeinConsoleClient, type DeliverySummary } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDeliveryTarget } from "@/delivery-target";
import { useAsync } from "@/use-async";

import { Async, Panel, ShortId, StatusBadge, Timestamp } from "./parts";

export function RunDeliveries({ threadId, runId }: { threadId: string; runId: string }) {
  const client = createSkeinConsoleClient();
  const deliveries = useAsync(
    async (signal) => (await client.listRunDeliveries(threadId, runId, signal)).deliveries,
    [threadId, runId],
  );
  const [replay, setReplay] = useState<{ deliveryId?: string; error?: Error }>({});

  const replayDelivery = async (delivery: DeliverySummary) => {
    if (
      !window.confirm(
        `Replay delivery ${delivery.delivery_id}?\n\nThis may send the callback more than once. Webhook receivers should deduplicate by delivery id; channel destinations should use their stable run id.`,
      )
    )
      return;
    setReplay({ deliveryId: delivery.delivery_id });
    try {
      // Do not retain or render the mutation response: refresh the sanitized list representation.
      await client.replayRunDelivery(threadId, runId, delivery.delivery_id);
      setReplay({});
      deliveries.reload();
    } catch (error) {
      setReplay({ error: error instanceof Error ? error : new Error(String(error)) });
    }
  };

  return (
    <Panel
      title="Deliveries"
      count={deliveries.data?.length}
      actions={
        <Button variant="ghost" size="sm" onClick={deliveries.reload} disabled={deliveries.loading}>
          <RefreshCw className={deliveries.loading ? "size-3.5 animate-spin" : "size-3.5"} />
          Refresh
        </Button>
      }
    >
      {replay.error ? (
        <div className="border-b border-status-error/30 bg-status-error/5 px-4 py-2 font-mono text-xs text-status-error">
          {replay.error.message}
        </div>
      ) : null}
      <Async state={deliveries} empty="This run did not create an outbound delivery.">
        {(rows) => (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Next attempt</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((delivery) => {
                const canReplay = delivery.status === "dead" && delivery.replayable;
                return (
                  <TableRow key={delivery.delivery_id}>
                    <TableCell>
                      <StatusBadge status={delivery.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {formatDeliveryTarget(delivery.url)}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums">
                      {delivery.attempt}
                    </TableCell>
                    <TableCell>
                      <Timestamp value={delivery.updated_at} />
                    </TableCell>
                    <TableCell>
                      {delivery.status === "pending" || delivery.status === "delivering" ? (
                        <Timestamp value={delivery.next_attempt_at} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      {delivery.last_error ? (
                        <span
                          className="block truncate font-mono text-xs text-status-error"
                          title={delivery.last_error}
                        >
                          {delivery.last_error}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ShortId id={delivery.delivery_id} />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canReplay || replay.deliveryId !== undefined}
                        title={
                          canReplay
                            ? "Make this failed delivery due now"
                            : "Only failed deliveries can be replayed"
                        }
                        onClick={() => void replayDelivery(delivery)}
                      >
                        <RotateCcw className="size-3.5" />
                        Replay
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Async>
    </Panel>
  );
}
