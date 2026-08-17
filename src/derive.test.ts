import { describe, expect, test } from "bun:test";
import { adjacency, ancestors, layout, leverage, statuses } from "./derive.ts";
import { findCycle, Graph, validateGraph } from "./schema.ts";

const real = Graph.parse(await Bun.file(new URL("../graph.json", import.meta.url)).json());

/**
 * graph.json carries live progress that changes every time the account does, so
 * status and leverage are asserted against a cleared board. Structural checks
 * (validity, ancestry, layering) still run against the real file.
 */
const fresh: Graph = { ...real, nodes: real.nodes.map((n) => ({ ...n, done: false })) };

const withDone = (...ids: string[]): Graph => ({
  ...fresh,
  nodes: fresh.nodes.map((n) => (ids.includes(n.id) ? { ...n, done: true } : n)),
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
    // The case that broke the outline: you can kill Muspah today, you'd just
    // rather have the bow first.
    const st = statuses(fresh);
    expect(st.get("muspah")).toBe("possible");
  });

  test("satisfying the soft prerequisite promotes possible -> ready", () => {
    const st = statuses(withDone("song-of-elves", "cg", "full-crystal"));
    expect(st.get("muspah")).toBe("ready");
    expect(st.get("zulrah")).toBe("ready");
  });

  test("a hard prerequisite locks the node outright", () => {
    expect(statuses(fresh).get("araxxor")).toBe("locked");
    // 92 Slayer unlocks it, but full crystal is still a soft want — so it clears
    // "locked" and lands on "possible", not straight to "ready".
    expect(statuses(withDone("slayer-grind", "slayer-92")).get("araxxor")).toBe("possible");
    expect(
      statuses(withDone("slayer-grind", "slayer-92", "song-of-elves", "cg", "full-crystal")).get(
        "araxxor",
      ),
    ).toBe("ready");
  });

  test("grants blocks the item behind its source activity", () => {
    expect(statuses(fresh).get("full-crystal")).toBe("locked");
  });

  test("done wins over everything", () => {
    expect(statuses(withDone("araxxor")).get("araxxor")).toBe("done");
  });
});

describe("leverage", () => {
  test("CG outranks the bosses it feeds", () => {
    const lev = leverage(fresh);
    const cg = lev.get("cg") ?? 0;
    expect(cg).toBeGreaterThan(lev.get("muspah") ?? 0);
    expect(cg).toBeGreaterThan(lev.get("zulrah") ?? 0);
  });

  test("completed nodes stop counting toward leverage", () => {
    const before = leverage(fresh).get("slayer-grind") ?? 0;
    const after = leverage(withDone("slayer-91", "cerberus")).get("slayer-grind") ?? 0;
    expect(after).toBeLessThan(before);
  });

  test("a leaf has none", () => {
    expect(leverage(fresh).get("rancour")).toBe(0);
  });
});

describe("ancestry", () => {
  test("the path to rancour runs through the Slayer grind", () => {
    const anc = ancestors("rancour", adjacency(real));
    expect([...anc].sort()).toEqual([
      "araxxor",
      "cg",
      "full-crystal",
      "slayer-92",
      "slayer-grind",
      "song-of-elves",
    ]);
  });
});

describe("layout", () => {
  test("places every node and respects pins", () => {
    const placed = layout(real);
    expect(placed.size).toBe(real.nodes.length);

    const pinned: Graph = {
      ...real,
      nodes: real.nodes.map((n) => (n.id === "cg" ? { ...n, pin: { x: 999, y: 777 } } : n)),
    };
    const p = layout(pinned).get("cg");
    expect(p).toMatchObject({ x: 999, y: 777, pinned: true });
  });

  test("layers strictly increase across every edge", () => {
    const placed = layout(real);
    for (const e of real.edges) {
      const from = placed.get(e.from);
      const to = placed.get(e.to);
      expect(from?.layer ?? -1).toBeLessThan(to?.layer ?? -1);
    }
  });
});

describe("cycle detection", () => {
  test("catches the Slayer loop", () => {
    // Cerberus is a Slayer task and gives Slayer xp; wiring that back to the
    // level milestone is the mistake the milestone-node design exists to avoid.
    const looped: Graph = {
      ...real,
      edges: [
        ...real.edges,
        { from: "cerberus", to: "slayer-91", type: "grants", note: "", verify: false },
      ],
    };
    expect(findCycle(looped)).not.toBeNull();
    expect(validateGraph(looped).some((e) => e.startsWith("cycle:"))).toBe(true);
  });
});
