import { describe, expect, test } from "bun:test";
import { coerceGraph, validateGraph } from "./model.ts";
import { Graph } from "./schema.ts";

/**
 * coerceGraph exists so the browser can check an imported file without shipping
 * zod for it. That is only safe while the two agree on SHAPE, so this runs both
 * over the same inputs and compares. If someone adds a field to schema.ts and
 * forgets model.ts — or changes a default on one side — one of these fails.
 *
 * They agree on shape, not on scope: coerceGraph deliberately does more, running
 * the structural checks (dangling edges, cycles, duplicate ids) that the server
 * applies as a separate step after zod. So a structurally broken graph is a
 * legitimate disagreement, and the assertion below excludes exactly that case
 * rather than papering over it — the "catches what a shape check cannot" block
 * pins the extra behaviour on its own.
 */
const bothAgree = (input: unknown) => {
  const mine = coerceGraph(input);
  const zod = Graph.safeParse(input);

  if (!zod.success) {
    expect("errors" in mine).toBe(true);
    return;
  }
  const structural = validateGraph(zod.data);
  if (structural.length) {
    expect("errors" in mine).toBe(true);
    return;
  }
  if (!("graph" in mine)) throw new Error(`coerceGraph rejected what zod accepted: ${input}`);
  expect(mine.graph).toEqual(zod.data);
};

const minimalNode = { id: "a", label: "A", kind: "activity", lane: "pvm" };

describe("coerceGraph agrees with the zod schema", () => {
  test("on a fully specified graph", () => {
    bothAgree({
      version: 1,
      nodes: [
        {
          id: "a",
          label: "A",
          kind: "item",
          lane: "raid",
          done: true,
          note: "n",
          wiki: "w",
          verify: true,
          pin: { x: 1, y: 2 },
        },
      ],
      edges: [{ from: "a", to: "a2", type: "boosts", note: "x", verify: true }],
    });
  });

  test("filling every optional field from a bare one", () => {
    bothAgree({ version: 1, nodes: [minimalNode], edges: [] });
  });

  test("on the shipped example, and on the live graph", async () => {
    for (const f of ["../example.json", "../graph.json"]) {
      bothAgree(await Bun.file(new URL(f, import.meta.url)).json());
    }
  });

  test("rejecting a bad kind, lane, or edge type", () => {
    bothAgree({ version: 1, nodes: [{ ...minimalNode, kind: "boss" }], edges: [] });
    bothAgree({ version: 1, nodes: [{ ...minimalNode, lane: "combat" }], edges: [] });
    bothAgree({
      version: 1,
      nodes: [minimalNode],
      edges: [{ from: "a", to: "a", type: "requires" }],
    });
  });

  test("rejecting the wrong version, or no version", () => {
    bothAgree({ version: 2, nodes: [], edges: [] });
    bothAgree({ nodes: [], edges: [] });
  });

  test("rejecting a missing id or label", () => {
    bothAgree({ version: 1, nodes: [{ ...minimalNode, id: "" }], edges: [] });
    bothAgree({ version: 1, nodes: [{ ...minimalNode, label: undefined }], edges: [] });
  });

  test("rejecting rubbish outright", () => {
    for (const junk of [null, 42, "graph", [], {}]) bothAgree(junk);
  });
});

describe("coerceGraph also catches what a shape check cannot", () => {
  test("a dangling edge", () => {
    const r = coerceGraph({
      version: 1,
      nodes: [minimalNode],
      edges: [{ from: "a", to: "nope", type: "soft" }],
    });
    expect("errors" in r && r.errors.join()).toContain("missing node: nope");
  });

  test("a cycle", () => {
    const r = coerceGraph({
      version: 1,
      nodes: [minimalNode, { ...minimalNode, id: "b", label: "B" }],
      edges: [
        { from: "a", to: "b", type: "hard" },
        { from: "b", to: "a", type: "hard" },
      ],
    });
    expect("errors" in r && r.errors.join()).toContain("cycle:");
  });

  test("but lets an annotation close one", () => {
    const r = coerceGraph({
      version: 1,
      nodes: [minimalNode, { ...minimalNode, id: "b", label: "B" }],
      edges: [
        { from: "a", to: "b", type: "hard" },
        { from: "b", to: "a", type: "boosts" },
      ],
    });
    expect("graph" in r).toBe(true);
  });
});
