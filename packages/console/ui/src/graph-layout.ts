// Laying a LangGraph graph out for drawing.
//
// A full graph-layout engine (dagre, elk) is 40–100 kB of dependency for a shape that is almost always
// a short chain with a couple of branches. A longest-path layering does the job in ~40 lines: rank
// every node by how far it is from `__start__`, then spread each rank across a row. Cycles (a loop
// back to an earlier node, which agent graphs do constantly) are handled by only ever moving a node
// *down*, never up, so a back-edge cannot send the layout into an infinite descent.

export interface GraphNode {
  id: string;
  type?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  conditional?: boolean;
}

export interface LaidOutNode extends GraphNode {
  /** Distance from START, in rows. */
  rank: number;
  /** Position within the row, 0-based. */
  column: number;
  /** How many nodes share this rank, so a renderer can centre the row. */
  rowSize: number;
  /** The label to draw: START/END for the sentinels, the id otherwise. */
  label: string;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: GraphEdge[];
  /** Number of rows, for sizing the canvas. */
  rows: number;
  /** Widest row, for sizing the canvas. */
  columns: number;
}

const START = "__start__";
const END = "__end__";

/** LangGraph's sentinels read better as words than as dunder ids. */
function labelFor(id: string): string {
  if (id === START) return "START";
  if (id === END) return "END";
  return id;
}

/**
 * Rank nodes by longest path from START, then place them in rows.
 *
 * Longest path rather than shortest: with shortest-path ranking a node that is reachable both
 * directly and via a three-node detour lands next to START and its incoming edge crosses the whole
 * diagram. Longest path puts it after everything that can reach it, which is what makes an agent
 * graph read top-to-bottom.
 */
export function layoutGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): GraphLayout {
  const rank = new Map<string, number>();
  for (const node of nodes) rank.set(node.id, 0);

  // Rank over the graph with its cycles cut. Relaxing over the raw edge set does not converge on a
  // loop — `tools → model` keeps pushing `model` below `tools`, which pushes `tools` below `model`,
  // and both walk downward until the iteration bound stops them at an absurd depth.
  const backEdges = findBackEdges(nodes, edges);
  const acyclic = edges.filter((edge) => !backEdges.has(edgeKey(edge)));

  const bound = nodes.length + 1;
  for (let pass = 0; pass < bound; pass += 1) {
    let moved = false;
    for (const edge of acyclic) {
      const source = rank.get(edge.source);
      const target = rank.get(edge.target);
      if (source === undefined || target === undefined) continue;
      if (target < source + 1) {
        rank.set(edge.target, source + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // END always sits last, even when nothing points at it.
  const maxRank = Math.max(0, ...rank.values());
  if (rank.has(END)) rank.set(END, maxRank);

  const byRank = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const nodeRank = rank.get(node.id) ?? 0;
    const row = byRank.get(nodeRank) ?? [];
    row.push(node);
    byRank.set(nodeRank, row);
  }

  const laidOut: LaidOutNode[] = [];
  for (const [nodeRank, row] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    row.forEach((node, column) => {
      laidOut.push({
        ...node,
        rank: nodeRank,
        column,
        rowSize: row.length,
        label: labelFor(node.id),
      });
    });
  }

  return {
    nodes: laidOut,
    edges: [...edges],
    rows: byRank.size,
    columns: Math.max(1, ...[...byRank.values()].map((row) => row.length)),
  };
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.source}\u0000${edge.target}`;
}

/**
 * Edges that close a cycle, found by depth-first search.
 *
 * An edge is a back-edge when its target is still on the current DFS stack — i.e. following it
 * returns to a node we are in the middle of exploring. Removing exactly those leaves a DAG that keeps
 * every forward edge, so a `model → tools → model` loop still draws both nodes in execution order and
 * only the return arrow is dropped from the ranking.
 *
 * Iterative rather than recursive: a deep graph should not be able to blow the stack in a UI.
 */
function findBackEdges(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): ReadonlySet<string> {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }

  const back = new Set<string>();
  const finished = new Set<string>();
  const onStack = new Set<string>();

  // START first, so the search follows execution order and the back-edges it finds are the ones a
  // reader would also call "returns".
  const roots = [...nodes.map((node) => node.id)].sort((a, b) =>
    a === START ? -1 : b === START ? 1 : 0,
  );

  for (const root of roots) {
    if (finished.has(root)) continue;
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    onStack.add(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const candidates = outgoing.get(frame.id) ?? [];
      if (frame.next >= candidates.length) {
        onStack.delete(frame.id);
        finished.add(frame.id);
        stack.pop();
        continue;
      }
      const edge = candidates[frame.next];
      frame.next += 1;
      if (edge === undefined) continue;
      if (onStack.has(edge.target)) {
        back.add(edgeKey(edge));
        continue;
      }
      if (finished.has(edge.target)) continue;
      onStack.add(edge.target);
      stack.push({ id: edge.target, next: 0 });
    }
  }
  return back;
}
