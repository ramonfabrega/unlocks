import { expect, describe as suite, test } from "bun:test";
import { commitMessage, describe } from "./log.ts";
import { type EdgeType, Graph, type GraphNode, type Lane } from "./schema.ts";

/** Edges as you write them by hand: zod fills in note and verify. */
type EdgeInput = { from: string; to: string; type: EdgeType };

const node = (id: string, done = false, lane: Lane = "pvm"): GraphNode => ({
  id,
  label: id.toUpperCase(),
  kind: "activity",
  lane,
  done,
  note: "",
  wiki: "",
  verify: false,
  pin: null,
});

const graph = (nodes: GraphNode[], edges: EdgeInput[] = []): Graph =>
  Graph.parse({ version: 1, nodes, edges });

const base = graph([node("cg"), node("bowfa"), node("muspah")]);

/**
 * These messages are the point of keeping graph.json in git — `git log` is meant
 * to read back as an account history years later. It was also the only part of
 * the tool with no tests, which is how "update graph" ended up in the log
 * fourteen times.
 */
suite("progression log", () => {
  test("ticking nodes names them", () => {
    const after = graph([node("cg", true), node("bowfa", true), node("muspah")]);
    expect(describe(base, after)).toEqual(["done: CG, BOWFA"]);
  });

  test("un-ticking is reported separately, never as a done", () => {
    const before = graph([node("cg", true), node("bowfa"), node("muspah")]);
    const after = graph([node("cg"), node("bowfa", true), node("muspah")]);
    expect(describe(before, after)).toEqual(["done: BOWFA", "un-done: CG"]);
  });

  test("added and removed nodes are counted and named", () => {
    const after = graph([node("cg"), node("bowfa"), node("zulrah")]);
    expect(describe(base, after)).toEqual(["+1 node: ZULRAH", "-1 node: MUSPAH"]);
  });

  test("a new edge reads as a sentence", () => {
    const after = graph(base.nodes, [{ from: "cg", to: "bowfa", type: "grants" }]);
    expect(describe(base, after)).toEqual(["edges: CG grants BOWFA"]);
  });

  test("a retyped edge shows both types", () => {
    const before = graph(base.nodes, [{ from: "cg", to: "bowfa", type: "soft" }]);
    const after = graph(base.nodes, [{ from: "cg", to: "bowfa", type: "hard" }]);
    expect(describe(before, after)).toEqual(["edges: CG soft->hard BOWFA"]);
  });

  test("annotation edges are logged like any other", () => {
    const after = graph(base.nodes, [{ from: "bowfa", to: "muspah", type: "boosts" }]);
    expect(describe(base, after)).toEqual(["edges: BOWFA boosts MUSPAH"]);
  });

  test("deletions are counted, since their names are already gone", () => {
    const before = graph(base.nodes, [
      { from: "cg", to: "bowfa", type: "grants" },
      { from: "bowfa", to: "muspah", type: "soft" },
    ]);
    expect(describe(before, graph(base.nodes))).toEqual(["removed 2 edges"]);
  });

  test("a node deleted with its edges reports both", () => {
    const before = graph(base.nodes, [{ from: "cg", to: "bowfa", type: "grants" }]);
    const after = graph([node("cg"), node("muspah")]);
    expect(describe(before, after)).toEqual(["-1 node: BOWFA", "removed 1 edge"]);
  });

  test("no change says nothing at all", () => {
    expect(describe(base, base)).toEqual([]);
  });

  /**
   * The subject line has to carry the most interesting thing, because that is
   * all `git log --oneline` shows. Ticking something off outranks bookkeeping.
   */
  test("what you finished leads the subject line", () => {
    const after = graph(
      [node("cg", true), node("bowfa"), node("muspah"), node("zulrah")],
      [{ from: "cg", to: "bowfa", type: "grants" }],
    );
    const lines = describe(base, after);
    expect(lines[0]).toBe("done: CG");
    expect(commitMessage(lines)).toBe("done: CG\n\n+1 node: ZULRAH\nedges: CG grants BOWFA");
  });

  test("an empty diff still produces a valid message", () => {
    expect(commitMessage([])).toBe("update graph");
  });

  test("a single line has no body", () => {
    expect(commitMessage(["done: CG"])).toBe("done: CG");
  });
});
