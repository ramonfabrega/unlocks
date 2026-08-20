import { join } from "node:path";
import { adjacency, annotations, descendants } from "./derive.ts";
import { type EdgeType, Graph, type GraphEdge, isStructural } from "./schema.ts";

/**
 * The graph is filled in from memory while playing, so the question is never
 * "is it valid" — schema.ts answers that — but "did I mean that". These are the
 * mistakes the type system cannot see: an edge whose type contradicts the kinds
 * of node at either end, a constraint that another path already implies, an item
 * that comes from nowhere.
 *
 * Every finding is a QUESTION, not an error. Some will be deliberate. The point
 * is that 62 edges is past the number you can re-read in your head, and this is
 * cheaper than re-reading them.
 */

export interface Finding {
  severity: "check" | "note";
  rule: string;
  where: string;
  why: string;
}

const kindOf = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)?.kind;
const labelOf = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
const edgeName = (g: Graph, e: GraphEdge) =>
  `${labelOf(g, e.from)} --${e.type}--> ${labelOf(g, e.to)}`;

export function audit(g: Graph): Finding[] {
  const out: Finding[] = [];
  const adj = adjacency(g);
  const ann = annotations(g);
  const add = (severity: Finding["severity"], rule: string, where: string, why: string) =>
    out.push({ severity, rule, where, why });

  for (const e of g.edges) {
    if (!isStructural(e)) continue;
    const from = kindOf(g, e.from);
    const to = kindOf(g, e.to);

    // grants means "doing `from` is where `to` comes from". You do activities;
    // what you get is loot or experience.
    if (e.type === "grants" && to === "activity") {
      add(
        "check",
        "grants points at an activity",
        edgeName(g, e),
        "grants means the target is a thing you receive. If doing the first unlocks the second, that is `hard`.",
      );
    }
    if (e.type === "grants" && from === "item") {
      add(
        "check",
        "an item grants something",
        edgeName(g, e),
        "items are what grants produce, not what produces them. Did you mean `soft` (you want it first) or `hard` (the game requires it)?",
      );
    }

    // hard means the game refuses. Games refuse on quests and levels far more
    // often than on possessions.
    if (e.type === "hard" && from === "item") {
      add(
        "note",
        "an item is a hard gate",
        edgeName(g, e),
        "real, but rarer than a preference. If you could technically go without it, `soft` is the honest type.",
      );
    }

    // Levels come from the grind that feeds them, never from gear.
    if (e.type === "soft" && to === "milestone") {
      add(
        "check",
        "a want points at a level",
        edgeName(g, e),
        "a level is reached by training, so wanting something first does not change it. The want probably belongs on whatever the level gates.",
      );
    }
  }

  // A blocking edge that a longer blocking path already implies. Harmless to
  // status, but it costs a layout column and a routed channel each.
  const blockingOnly: Graph = {
    ...g,
    edges: g.edges.filter((e) => e.type === "grants" || e.type === "hard"),
  };
  const badj = adjacency(blockingOnly);
  for (const e of blockingOnly.edges) {
    const withoutThis: Graph = {
      ...blockingOnly,
      edges: blockingOnly.edges.filter((x) => x !== e),
    };
    if (descendants(e.from, adjacency(withoutThis)).has(e.to)) {
      add(
        "note",
        "implied by another path",
        edgeName(g, e),
        "another chain of blocking edges already gets from one to the other, so this edge only stretches the drawing.",
      );
    }
  }
  void badj;

  for (const n of g.nodes) {
    const preds = adj.preds.get(n.id) ?? [];
    const succs = adj.succs.get(n.id) ?? [];
    const boosts = (ann.improves.get(n.id) ?? []).length + (ann.improvedBy.get(n.id) ?? []).length;

    if (!preds.length && !succs.length && !boosts) {
      add(
        "check",
        "connected to nothing",
        n.label,
        "no prerequisites, unlocks nothing, improves nothing — either it is unfinished or it does not belong in a progression graph.",
      );
    }

    // Every item comes from somewhere. One with no source is a note to self that
    // never got its activity.
    if (n.kind === "item" && !preds.some((e) => e.type === "grants")) {
      add(
        "check",
        "item with no source",
        n.label,
        "nothing grants it. Which activity does it drop from?",
      );
    }

    if (n.verify) {
      add("note", "unverified", n.label, "seeded from memory and never checked against the wiki.");
    }
  }

  for (const e of g.edges) {
    if (e.verify) {
      add("note", "unverified", edgeName(g, e), "this relationship was written from memory.");
    }
  }

  const rank: Record<Finding["severity"], number> = { check: 0, note: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.rule.localeCompare(b.rule));
}

/** Counts by type, so "am I actually using all four" has an answer. */
export function typeMix(g: Graph): Record<EdgeType, number> {
  const mix: Record<EdgeType, number> = { grants: 0, hard: 0, soft: 0, boosts: 0 };
  for (const e of g.edges) mix[e.type]++;
  return mix;
}

if (import.meta.main) {
  const file =
    process.argv[2] ?? process.env.UNLOCKS_FILE ?? join(import.meta.dir, "..", "graph.json");
  const g = Graph.parse(await Bun.file(file).json());
  const findings = audit(g);
  const mix = typeMix(g);

  console.log(`\n  ${g.nodes.length} nodes, ${g.edges.length} edges`);
  console.log(
    `  ${Object.entries(mix)
      .map(([t, n]) => `${n} ${t}`)
      .join(" · ")}\n`,
  );

  if (!findings.length) {
    console.log("  nothing to question.\n");
  }

  let lastRule = "";
  for (const f of findings) {
    if (f.rule !== lastRule) {
      console.log(`\n  ${f.severity === "check" ? "?" : "·"} ${f.rule}`);
      console.log(`    ${f.why}\n`);
      lastRule = f.rule;
    }
    console.log(`      ${f.where}`);
  }
  console.log(
    `\n  ${findings.filter((f) => f.severity === "check").length} to check, ` +
      `${findings.filter((f) => f.severity === "note").length} to note.\n`,
  );
}
