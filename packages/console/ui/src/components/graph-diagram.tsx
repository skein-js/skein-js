// The graph, drawn.
//
// This is the thing a console for a *graph* runtime should obviously have and the thing that makes a
// run legible: which nodes exist, how they connect, and — while a run is in flight — which one is
// executing right now. Inline SVG, no charting dependency, themed from the same CSS variables as
// everything else.

import { layoutGraph, type GraphEdge, type GraphNode } from "@/graph-layout";
import { cn } from "@/lib/utils";

const NODE_WIDTH = 128;
const NODE_HEIGHT = 32;
const COLUMN_GAP = 24;
const ROW_GAP = 34;
const PADDING = 12;

interface Point {
  x: number;
  y: number;
}

export function GraphDiagram({
  nodes,
  edges,
  /** Node currently executing, highlighted. */
  activeNode,
  /** Nodes that have already run in this pass, drawn as visited. */
  visited,
  className,
}: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  activeNode?: string | undefined;
  visited?: ReadonlySet<string>;
  className?: string;
}) {
  const layout = layoutGraph(nodes, edges);
  if (layout.nodes.length === 0) return null;

  const width = layout.columns * NODE_WIDTH + (layout.columns - 1) * COLUMN_GAP + PADDING * 2;
  const height = layout.rows * NODE_HEIGHT + (layout.rows - 1) * ROW_GAP + PADDING * 2;

  /** Centre of a node, in diagram coordinates. Rows are centred against the widest row. */
  const centreOf = (rank: number, column: number, rowSize: number): Point => {
    const rowWidth = rowSize * NODE_WIDTH + (rowSize - 1) * COLUMN_GAP;
    const left = (width - rowWidth) / 2;
    return {
      x: left + column * (NODE_WIDTH + COLUMN_GAP) + NODE_WIDTH / 2,
      y: PADDING + rank * (NODE_HEIGHT + ROW_GAP) + NODE_HEIGHT / 2,
    };
  };

  const positions = new Map<string, Point & { rank: number }>();
  for (const node of layout.nodes) {
    positions.set(node.id, {
      ...centreOf(node.rank, node.column, node.rowSize),
      rank: node.rank,
    });
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("w-full", className)}
      style={{ maxHeight: height }}
      role="img"
      aria-label="Graph structure"
    >
      <defs>
        <marker
          id="skein-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0 0 L8 4 L0 8 z" fill="hsl(var(--muted-foreground))" opacity="0.5" />
        </marker>
      </defs>

      {layout.edges.map((edge) => {
        const from = positions.get(edge.source);
        const to = positions.get(edge.target);
        if (!from || !to) return null;
        return (
          <path
            key={`${edge.source}->${edge.target}`}
            d={edgePath(from, to)}
            fill="none"
            stroke="hsl(var(--muted-foreground))"
            strokeOpacity={0.35}
            strokeWidth={1}
            // A conditional edge is a *decision*, and dashing it is the one piece of graph semantics
            // worth spending ink on: it tells you the path is not guaranteed.
            strokeDasharray={edge.conditional ? "3 3" : undefined}
            markerEnd="url(#skein-arrow)"
          />
        );
      })}

      {layout.nodes.map((node) => {
        const point = positions.get(node.id);
        if (!point) return null;
        const sentinel = node.id === "__start__" || node.id === "__end__";
        const active = node.id === activeNode;
        const done = visited?.has(node.id) ?? false;
        return (
          <g key={node.id}>
            <rect
              x={point.x - NODE_WIDTH / 2}
              y={point.y - NODE_HEIGHT / 2}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={sentinel ? NODE_HEIGHT / 2 : 6}
              fill={
                active
                  ? "hsl(var(--status-running) / 0.12)"
                  : done
                    ? "hsl(var(--status-success) / 0.08)"
                    : "hsl(var(--card))"
              }
              stroke={
                active
                  ? "hsl(var(--status-running))"
                  : done
                    ? "hsl(var(--status-success) / 0.5)"
                    : "hsl(var(--border))"
              }
              strokeWidth={active ? 1.5 : 1}
            />
            {active ? (
              // A quiet pulse on the running node. It is the only motion in the console, which is
              // what makes it read as "this is happening now" rather than as decoration.
              <rect
                x={point.x - NODE_WIDTH / 2}
                y={point.y - NODE_HEIGHT / 2}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={sentinel ? NODE_HEIGHT / 2 : 6}
                fill="none"
                stroke="hsl(var(--status-running))"
                strokeWidth={1.5}
                opacity={0.6}
              >
                <animate
                  attributeName="opacity"
                  values="0.6;0;0.6"
                  dur="1.6s"
                  repeatCount="indefinite"
                />
              </rect>
            ) : null}
            <text
              x={point.x}
              y={point.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={sentinel ? 10 : 11.5}
              fontFamily={
                sentinel
                  ? "system-ui, sans-serif"
                  : "ui-monospace, SFMono-Regular, Menlo, monospace"
              }
              letterSpacing={sentinel ? "0.08em" : undefined}
              fill={
                active
                  ? "hsl(var(--status-running))"
                  : sentinel
                    ? "hsl(var(--muted-foreground))"
                    : "hsl(var(--foreground))"
              }
            >
              {truncate(node.label)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * A vertical edge is a straight line; anything that also moves sideways gets an S-curve.
 *
 * Straight diagonals between offset rows cross each other and become unreadable the moment a graph
 * branches; the curve separates them and reads as flow.
 */
function edgePath(from: Point & { rank: number }, to: Point & { rank: number }): string {
  const startY = from.y + NODE_HEIGHT / 2;
  const endY = to.y - NODE_HEIGHT / 2;
  if (Math.abs(from.x - to.x) < 1) return `M${from.x} ${startY} L${to.x} ${endY}`;
  const midY = (startY + endY) / 2;
  return `M${from.x} ${startY} C${from.x} ${midY} ${to.x} ${midY} ${to.x} ${endY}`;
}

/** Node names can be long; the full name is available in the assistant view. */
function truncate(label: string): string {
  return label.length > 16 ? `${label.slice(0, 15)}…` : label;
}
