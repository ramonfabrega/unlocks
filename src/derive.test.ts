import { describe, expect, test } from "bun:test";
import { adjacency, ancestors, edgeKey, layout, leverage, NODE_H, statuses } from "./derive.ts";
import { findCycle, Graph, type GraphNode, type Lane, validateGraph } from "./schema.ts";

const real = Graph.parse(await Bun.file(new URL("../graph.json", import.meta.url)).json());

/**
 * graph.json is live data — the account progresses and edges get re-typed or
 * deleted from the UI. Semantics are therefore pinned against this fixture, and
 * only structural invariants run against the real file.
 *
 *   quest ─hard→ boss1 ─grants→ item1 ─soft→ boss2 ─grants→ item2 ─grants→ far
 *     │                            └────soft→ boss3            (lvl ─hard→ boss2)
 *     └────────────────────soft────────────────────────────────────────────↗
 *
 * The quest→far edge spans five layers, which is what exercises edge routing.
 */
const node = (id: string, lane: Lane = "pvm"): GraphNode => ({
  id,
  label: id,
  kind: "activity",
  lane,
  done: false,
  note: "",
  wiki: "",
  verify: false,
  pin: null,
});

const fixture: Graph = Graph.parse({
  version: 1,
  nodes: [
    node("quest", "quest"),
    node("lvl", "slayer"),
    node("boss1"),
    node("item1"),
    node("boss2", "slayer"),
    node("boss3"),
    node("item2", "slayer"),
    node("far", "raid"),
  ],
  edges: [
    { from: "quest", to: "boss1", type: "hard" },
    { from: "boss1", to: "item1", type: "grants" },
    { from: "item1", to: "boss2", type: "soft" },
    { from: "item1", to: "boss3", type: "soft" },
    { from: "lvl", to: "boss2", type: "hard" },
    { from: "boss2", to: "item2", type: "grants" },
    { from: "item2", to: "far", type: "grants" },
    { from: "quest", to: "far", type: "soft" },
  ],
});

const withDone = (g: Graph, ...ids: string[]): Graph => ({
  ...g,
  nodes: g.nodes.map((n) => (ids.includes(n.id) ? { ...n, done: true } : n)),
});

describe("graph.json", () => {
  test("is a valid acyclic graph", () => {
    expect(validateGraph(real)).toEqual([]);
    expect(findCycle(real)).toBeNull();
  });

  test("every edge endpoint resolves", () => {
    const ids = new Set(real.nodes.map((n) => n.id));
    for (const e of real.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });
});

describe("status", () => {
  test("a soft-only prerequisite makes a node possible, never locked", () => {
    // The case that broke the outline: boss3's only prerequisite is a want, so
    // the game allows it today even though the gear isn't in hand.
    expect(statuses(fixture).get("boss3")).toBe("possible");
  });

  test("satisfying the soft prerequisite promotes possible -> ready", () => {
    expect(statuses(withDone(fixture, "item1")).get("boss3")).toBe("ready");
  });

  test("a hard prerequisite locks the node outright", () => {
    expect(statuses(fixture).get("boss2")).toBe("locked");
    // lvl clears the lock, but item1 is still a want — "possible", not "ready".
    expect(statuses(withDone(fixture, "lvl")).get("boss2")).toBe("possible");
    expect(statuses(withDone(fixture, "lvl", "item1")).get("boss2")).toBe("ready");
  });

  test("grants blocks the item behind its source activity", () => {
    expect(statuses(fixture).get("item1")).toBe("locked");
    expect(statuses(withDone(fixture, "boss1")).get("item1")).toBe("ready");
  });

  test("done wins over everything", () => {
    expect(statuses(withDone(fixture, "boss2")).get("boss2")).toBe("done");
  });
});

describe("leverage", () => {
  test("an upstream node outranks what it feeds", () => {
    const lev = leverage(fixture);
    expect(lev.get("quest") ?? 0).toBeGreaterThan(lev.get("boss3") ?? 0);
  });

  test("completed nodes stop counting toward leverage", () => {
    const before = leverage(fixture).get("boss1") ?? 0;
    const after = leverage(withDone(fixture, "item1", "boss3")).get("boss1") ?? 0;
    expect(after).toBeLessThan(before);
  });

  test("a leaf has none", () => {
    expect(leverage(fixture).get("far")).toBe(0);
  });
});

describe("ancestry", () => {
  test("collects every transitive prerequisite, and nothing else", () => {
    expect([...ancestors("item2", adjacency(fixture))].sort()).toEqual([
      "boss1",
      "boss2",
      "item1",
      "lvl",
      "quest",
    ]);
    expect(ancestors("quest", adjacency(fixture)).size).toBe(0);
  });
});

describe("layout", () => {
  test("places every node and respects pins", () => {
    const { placed } = layout(real);
    expect(placed.size).toBe(real.nodes.length);

    const pinned: Graph = {
      ...fixture,
      nodes: fixture.nodes.map((n) => (n.id === "boss1" ? { ...n, pin: { x: 999, y: 777 } } : n)),
    };
    expect(layout(pinned).placed.get("boss1")).toMatchObject({ x: 999, y: 777, pinned: true });
  });

  test("layers strictly increase across every edge", () => {
    const { placed } = layout(real);
    for (const e of real.edges) {
      expect(placed.get(e.from)?.layer ?? -1).toBeLessThan(placed.get(e.to)?.layer ?? -1);
    }
  });

  test("no two nodes overlap", () => {
    const { placed } = layout(real);
    const boxes = [...placed.values()];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  test("multi-layer edges get one route point per column crossed", () => {
    const { placed, bends } = layout(fixture);
    const from = placed.get("quest");
    const to = placed.get("far");
    expect((to?.layer ?? 0) - (from?.layer ?? 0)).toBe(5);
    expect((bends.get(edgeKey("quest", "far")) ?? []).length).toBe(4);
    // Adjacent-layer edges are drawn straight, with no route points at all.
    expect(bends.get(edgeKey("boss1", "item1"))).toBeUndefined();
  });

  test("route points stay strictly between their endpoints", () => {
    for (const g of [fixture, real]) {
      const { placed, bends } = layout(g);
      for (const e of g.edges) {
        const from = placed.get(e.from);
        const to = placed.get(e.to);
        if (!from || !to) continue;
        for (const p of bends.get(edgeKey(e.from, e.to)) ?? []) {
          expect(p.x).toBeGreaterThan(from.x + from.w);
          expect(p.x).toBeLessThan(to.x);
        }
      }
    }
  });

  test("routed edges in the real graph stay straight, or nearly so", () => {
    const { placed, bends } = layout(real);
    let routed = 0;
    let exact = 0;
    for (const e of real.edges) {
      const from = placed.get(e.from);
      const to = placed.get(e.to);
      const via = bends.get(edgeKey(e.from, e.to)) ?? [];
      if (!from || !to || !via.length) continue;
      routed++;

      const x0 = from.x + from.w;
      const y0 = from.y + from.h / 2;
      const x1 = to.x;
      const y1 = to.y + to.h / 2;
      const worst = Math.max(
        ...via.map((p) => Math.abs(p.y - (y0 + ((y1 - y0) * (p.x - x0)) / (x1 - x0)))),
      );
      // Two chains leaving the same node for different targets cannot both be
      // straight through the same columns, so allow one node height of give —
      // but never a staircase.
      expect(worst).toBeLessThan(NODE_H);
      if (worst < 1) exact++;
    }
    expect(routed).toBeGreaterThan(0);
    // Most of them should be exactly straight, not merely "not terrible".
    expect(exact / routed).toBeGreaterThanOrEqual(0.5);
  });

  test("a routed edge lands on the straight line between its endpoints", () => {
    // The whole reason to route long edges is that they stop staircasing across
    // the drawing, so assert collinearity rather than merely "has bends".
    const { placed, bends } = layout(fixture);
    const from = placed.get("quest");
    const to = placed.get("far");
    const via = bends.get(edgeKey("quest", "far")) ?? [];
    expect(via.length).toBe(4);

    const x0 = (from as NonNullable<typeof from>).x + (from as NonNullable<typeof from>).w;
    const y0 = (from as NonNullable<typeof from>).y + (from as NonNullable<typeof from>).h / 2;
    const x1 = (to as NonNullable<typeof to>).x;
    const y1 = (to as NonNullable<typeof to>).y + (to as NonNullable<typeof to>).h / 2;

    // Not exactly zero: a channel with no slack between two nodes gets clamped
    // rather than allowed to overlap them. A quarter of a node height is the
    // difference between "visually straight" and "staircase".
    for (const p of via) {
      const onLine = y0 + ((y1 - y0) * (p.x - x0)) / (x1 - x0);
      expect(Math.abs(p.y - onLine)).toBeLessThan(NODE_H / 4);
    }
  });
});

describe("cycle detection", () => {
  test("catches a loop back to a milestone", () => {
    // The real-world shape: Cerberus is a Slayer task that also gives Slayer xp.
    const looped: Graph = {
      ...fixture,
      edges: [
        ...fixture.edges,
        { from: "item2", to: "lvl", type: "grants", note: "", verify: false },
      ],
    };
    expect(findCycle(looped)).not.toBeNull();
    expect(validateGraph(looped).some((e) => e.startsWith("cycle:"))).toBe(true);
  });
});
