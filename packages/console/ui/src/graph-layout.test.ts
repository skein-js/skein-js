import { describe, expect, it } from "vitest";

import { layoutGraph } from "./graph-layout";

const rankOf = (layout: ReturnType<typeof layoutGraph>, id: string) =>
  layout.nodes.find((node) => node.id === id)?.rank;

describe("layoutGraph", () => {
  it("ranks a simple chain in order", () => {
    const layout = layoutGraph(
      [{ id: "__start__" }, { id: "a" }, { id: "b" }, { id: "__end__" }],
      [
        { source: "__start__", target: "a" },
        { source: "a", target: "b" },
        { source: "b", target: "__end__" },
      ],
    );
    expect(rankOf(layout, "__start__")).toBe(0);
    expect(rankOf(layout, "a")).toBe(1);
    expect(rankOf(layout, "b")).toBe(2);
    expect(rankOf(layout, "__end__")).toBe(3);
    expect(layout.rows).toBe(4);
  });

  it("ranks by longest path, so an edge never skips backwards over a detour", () => {
    // start → a → b → c, plus start → c directly. Shortest-path ranking would put `c` at rank 1,
    // next to `a`, and its edge from `b` would run back up the diagram.
    const layout = layoutGraph(
      [{ id: "__start__" }, { id: "a" }, { id: "b" }, { id: "c" }],
      [
        { source: "__start__", target: "a" },
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "__start__", target: "c" },
      ],
    );
    expect(rankOf(layout, "c")).toBe(3);
  });

  it("terminates on a cycle and keeps the loop target above its source", () => {
    // Agent graphs loop constantly (tools → model → tools). A back-edge must not ratchet the layout.
    const layout = layoutGraph(
      [{ id: "__start__" }, { id: "model" }, { id: "tools" }],
      [
        { source: "__start__", target: "model" },
        { source: "model", target: "tools", conditional: true },
        { source: "tools", target: "model" },
      ],
    );
    expect(rankOf(layout, "model")).toBe(1);
    expect(rankOf(layout, "tools")).toBe(2);
  });

  it("places parallel branches side by side in one row", () => {
    const layout = layoutGraph(
      [{ id: "__start__" }, { id: "left" }, { id: "right" }],
      [
        { source: "__start__", target: "left" },
        { source: "__start__", target: "right" },
      ],
    );
    expect(rankOf(layout, "left")).toBe(1);
    expect(rankOf(layout, "right")).toBe(1);
    expect(layout.columns).toBe(2);
    expect(layout.nodes.filter((node) => node.rank === 1).map((node) => node.column)).toEqual([
      0, 1,
    ]);
  });

  it("keeps END last even when nothing points at it", () => {
    const layout = layoutGraph(
      [{ id: "__start__" }, { id: "a" }, { id: "b" }, { id: "__end__" }],
      [
        { source: "__start__", target: "a" },
        { source: "a", target: "b" },
      ],
    );
    expect(rankOf(layout, "__end__")).toBe(2);
  });

  it("renames the sentinels", () => {
    const layout = layoutGraph([{ id: "__start__" }, { id: "__end__" }, { id: "work" }], []);
    expect(layout.nodes.map((node) => node.label).sort()).toEqual(["END", "START", "work"]);
  });

  it("survives an edge naming a node that does not exist", () => {
    const layout = layoutGraph([{ id: "a" }], [{ source: "a", target: "ghost" }]);
    expect(layout.nodes).toHaveLength(1);
  });
});
