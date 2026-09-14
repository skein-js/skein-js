// Effective channel wiring for operators testing a deployment. This is intentionally an inventory,
// not a configuration editor: code remains the source of truth and the console shows what booted.

import { Check, Clipboard, RefreshCw, Search, Send, Waypoints } from "lucide-react";
import { useMemo, useState } from "react";

import { createSkeinConsoleClient, type ChannelSummary } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { routeHref } from "@/router";
import { useAsync } from "@/use-async";

import { Async, Empty, Panel } from "./parts";

export function ChannelsView() {
  const client = createSkeinConsoleClient();
  const inventory = useAsync((signal) => client.listChannels(signal), []);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<string>();
  const rows = useMemo(
    () => filterChannels(inventory.data?.channels ?? [], query),
    [inventory.data, query],
  );

  const copyRoute = async (routeName: string) => {
    await navigator.clipboard.writeText(`/channels/${routeName}`);
    setCopied(routeName);
    window.setTimeout(() => setCopied((value) => (value === routeName ? undefined : value)), 1500);
  };

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Channels</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
            Verify the source routes this server mounted and where each one enters your graphs.
            Delivery attempts are tracked on the run they belong to.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={inventory.reload} disabled={inventory.loading}>
          <RefreshCw className={inventory.loading ? "size-3.5 animate-spin" : "size-3.5"} />
          Refresh
        </Button>
      </div>

      {inventory.data ? <ChannelStats rows={inventory.data.channels} /> : null}

      <Panel
        title="Runtime routes"
        count={inventory.data?.channels.length}
        actions={
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter channels"
              aria-label="Filter channels"
              className="pl-8"
            />
          </div>
        }
      >
        <Async
          state={inventory}
          empty="No channels are configured. Add skein.channels entries to langgraph.json and restart the server."
        >
          {() =>
            rows.length === 0 ? (
              <Empty>No channels match “{query}”.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Route</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Default assistant</TableHead>
                    <TableHead>Allowed assistants</TableHead>
                    <TableHead>Outbound</TableHead>
                    <TableHead className="w-20">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((channel) => (
                    <TableRow key={channel.route_name}>
                      <TableCell>
                        <div className="font-medium">{channel.route_name}</div>
                        <code className="text-[11px] text-muted-foreground">
                          POST /channels/{channel.route_name}
                        </code>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{channel.channel_name}</TableCell>
                      <TableCell>
                        <a
                          href={routeHref(`assistants/${channel.assistant}`)}
                          className="font-mono text-xs underline-offset-4 hover:underline"
                        >
                          {channel.assistant}
                        </a>
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-sm flex-wrap gap-1">
                          {channel.allowed_assistants.length === 0 ? (
                            <span className="text-xs text-muted-foreground">Default only</span>
                          ) : (
                            channel.allowed_assistants.map((assistant) => (
                              <Badge key={assistant} variant="outline">
                                {assistant}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={channel.delivery_supported ? "success" : "muted"}>
                          {channel.delivery_supported ? "Supported" : "Inbound only"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Copy inbound route"
                          aria-label={`Copy ${channel.route_name} inbound route`}
                          onClick={() => void copyRoute(channel.route_name)}
                        >
                          {copied === channel.route_name ? (
                            <Check className="size-3.5 text-status-success" />
                          ) : (
                            <Clipboard className="size-3.5" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </Async>
      </Panel>

      <div className="rounded-lg border border-dashed px-4 py-3 text-[13px] text-muted-foreground">
        Testing an outbound reply? Send an event to a route above, then open the resulting thread
        and run. Its <span className="font-medium text-foreground">Deliveries</span> panel shows
        retry state, failures, and replay controls.{" "}
        <a href={routeHref("threads")} className="underline underline-offset-4">
          Browse threads
        </a>
        .
      </div>
    </>
  );
}

function ChannelStats({ rows }: { rows: ChannelSummary[] }) {
  const outbound = rows.filter((row) => row.delivery_supported).length;
  const assistants = new Set(rows.flatMap((row) => [row.assistant, ...row.allowed_assistants]))
    .size;
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-3">
      <Stat icon={<Waypoints className="size-4" />} label="Mounted routes" value={rows.length} />
      <Stat icon={<Send className="size-4" />} label="Outbound-capable" value={outbound} />
      <Stat icon={<Check className="size-4" />} label="Reachable assistants" value={assistants} />
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2 text-muted-foreground">
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
        {icon}
      </CardHeader>
      <CardContent>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
      </CardContent>
    </Card>
  );
}

export function filterChannels(rows: readonly ChannelSummary[], query: string): ChannelSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) =>
    [row.route_name, row.channel_name, row.assistant, ...row.allowed_assistants].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}
