import { describe, expect, test } from "bun:test";
import { audit, typeMix } from "./audit.ts";
import { type EdgeType, Graph, type GraphNode, type NodeKind } from "./schema.ts";

/** Edges as you write them by hand: zod fills in note and verify. */
type EdgeInput = { from: string; to: string; type: EdgeType };

const node = (id: string, kind: NodeKind = "activity"): GraphNode => ({
  id,
  label: id,
  kind,
  lane: "pvm",
  done: false,
  note: "",
  wiki: "",
  verify: false,
  pin: null,
});

const graph = (nodes: GraphNode[], edges: EdgeInput[] = []): Graph =>
  Graph.parse({ version: 1, nodes, edges });

const rules = (g: Graph) => audit(g).map((f) => f.rule);

/**
 * The audit's whole value is its precision. A checker that fires on half the
 * graph gets ignored within a week, so each rule is pinned both ways: it catches
 * the mistake, and it stays quiet on the correct modelling it resembles.
 */
describe("audit", () => {
  test("a well-formed grant is quiet", () => {
    const g = graph(
      [node("cg"), node("bowfa", "item")],
      [{ from: "cg", to: "bowfa", type: "grants" }],
    );
    expect(rules(g)).toEqual([]);
  });

  test("catches a grant pointing at an activity", () => {
    const g = graph(
      [node("grind"), node("kraken")],
      [{ from: "grind", to: "kraken", type: "grants" }],
    );
    expect(rules(g)).toContain("grants points at an activity");
  });

  test("a grant may point at a level, since xp is a thing you receive", () => {
    const g = graph(
      [node("grind"), node("slayer-95", "milestone")],
      [{ from: "grind", to: "slayer-95", type: "grants" }],
    );
    expect(rules(g)).not.toContain("grants points at an activity");
  });

  test("catches an item that grants something", () => {
    const g = graph(
      [node("bowfa", "item"), node("seed", "item")],
      [{ from: "bowfa", to: "seed", type: "grants" }],
    );
    expect(rules(g)).toContain("an item grants something");
  });

  test("catches a want pointing at a level", () => {
    // Wanting gear first cannot change when you hit 92 Slayer — training does.
    const g = graph(
      [node("bowfa", "item"), node("slayer-92", "milestone")],
      [{ from: "bowfa", to: "slayer-92", type: "soft" }],
    );
    expect(rules(g)).toContain("a want points at a level");
  });

  test("a level hard-gating a boss is correct and stays quiet", () => {
    const g = graph(
      [node("slayer-92", "milestone"), node("araxxor")],
      [{ from: "slayer-92", to: "araxxor", type: "hard" }],
    );
    expect(rules(g)).toEqual([]);
  });

  test("flags an edge another blocking path already implies", () => {
    const g = graph(
      [node("a"), node("b"), node("c")],
      [
        { from: "a", to: "b", type: "hard" },
        { from: "b", to: "c", type: "hard" },
        { from: "a", to: "c", type: "hard" },
      ],
    );
    expect(rules(g)).toContain("implied by another path");
  });

  test("does not call a lone chain redundant", () => {
    const g = graph(
      [node("a"), node("b"), node("c")],
      [
        { from: "a", to: "b", type: "hard" },
        { from: "b", to: "c", type: "hard" },
      ],
    );
    expect(rules(g)).not.toContain("implied by another path");
  });

  test("catches an item nothing drops", () => {
    const g = graph(
      [node("boss"), node("orphan", "item")],
      [{ from: "boss", to: "orphan", type: "soft" }],
    );
    expect(rules(g)).toContain("item with no source");
  });

  test("catches a node wired to nothing", () => {
    expect(rules(graph([node("construction")]))).toContain("connected to nothing");
  });

  test("an annotation counts as being connected", () => {
    // The point of `boosts` is that it is a real relationship, so a node whose
    // only link is one is deliberate, not unfinished.
    const g = graph(
      [node("ancestral", "item"), node("grind"), node("cox")],
      [
        { from: "cox", to: "ancestral", type: "grants" },
        { from: "ancestral", to: "grind", type: "boosts" },
      ],
    );
    expect(rules(g)).not.toContain("connected to nothing");
  });

  test("counts every type, including the ones you are not using yet", () => {
    const g = graph([node("a"), node("b", "item")], [{ from: "a", to: "b", type: "grants" }]);
    expect(typeMix(g)).toEqual({ grants: 1, hard: 0, soft: 0, boosts: 0 });
  });
});
