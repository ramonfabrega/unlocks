/**
 * The domain, with no dependencies.
 *
 * zod lives in schema.ts because parsing is a boundary concern — it belongs
 * wherever untrusted bytes arrive, which is the server's PUT handler, the file
 * read, and an imported file. It does not belong in the browser, and it was
 * getting there: the client imported one predicate from schema.ts as a value,
 * which dragged the whole parser in behind it and made the bundle 0.31 MB for
 * about 30 KB of application. Everything the client actually needs — the shapes,
 * the vocabulary, and the pure structural checks — is here instead.
 */

/**
 * Node kinds. The split between activity and item is what fixes the outline
 * problem: "CG" is not a prerequisite for Muspah — *bowfa* is, and CG is merely
 * where bowfa comes from. Once items are first-class nodes, a thing that
 * unlocks two things just has two out-edges instead of being duplicated.
 */
export type NodeKind = "activity" | "item" | "milestone";
export const NODE_KINDS: readonly NodeKind[] = ["activity", "item", "milestone"];

export type Lane = "pvm" | "raid" | "slayer" | "skilling" | "quest";
export const LANES: readonly Lane[] = ["pvm", "raid", "slayer", "skilling", "quest"];

/**
 * Edge types, all directed from → to meaning "from comes before to".
 *
 *  grants — `to` is obtained by doing `from`   (CG grants bowfa)
 *  hard   — `to` is game-locked behind `from`  (92 Slayer gates Araxxor)
 *  soft   — you want `from` before `to`        (bowfa before Muspah)
 *  boosts — `from` makes `to` better           (ancestral makes Slayer nicer)
 *
 * grants and hard both block. soft never blocks — it only downgrades a node
 * from "ready" to "possible", which is exactly the Muspah case: killable now,
 * but you'd rather have the bow first.
 *
 * boosts is not part of the DAG at all. It exists because three types forced
 * every true observation to be filed as a plan: "ancestral is good for Slayer"
 * had to become "I want ancestral before Slayer", which is false — you slay from
 * day one — and which put Slayer behind a raid. The result was self-censorship:
 * real relationships went unrecorded because recording them lied about the
 * order of play. So a boosts edge carries no ordering claim. It never blocks,
 * never downgrades a status, never earns leverage, never takes a layout column,
 * and is exempt from the acyclic rule — ancestral boosting Slayer while Slayer
 * boosts the gear that buys it is a fact about the game, not a contradiction.
 * It is a note stuck to two nodes, and it is safe to write down.
 */
export type EdgeType = "grants" | "hard" | "soft" | "boosts";
export const EDGE_TYPES: readonly EdgeType[] = ["grants", "hard", "soft", "boosts"];

/** The edge types that make up the DAG proper. Everything else is annotation. */
export const STRUCTURAL: ReadonlySet<EdgeType> = new Set<EdgeType>(["grants", "hard", "soft"]);

export const isStructural = (e: { type: EdgeType }): boolean => STRUCTURAL.has(e.type);

export interface Pin {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  lane: Lane;
  /** The only field the game doesn't decide for you. */
  done: boolean;
  note: string;
  wiki: string;
  /** Set when a game fact was seeded from memory and hasn't been checked. */
  verify: boolean;
  /** Manual position override; null means "let the auto-layout place it". */
  pin: Pin | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  note: string;
  verify: boolean;
}

export interface Graph {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Structural problems a shape check can't see. Returns human-readable errors. */
export function validateGraph(g: Graph): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    ids.add(n.id);
  }

  const seen = new Set<string>();
  for (const e of g.edges) {
    if (!ids.has(e.from)) errors.push(`edge references missing node: ${e.from}`);
    if (!ids.has(e.to)) errors.push(`edge references missing node: ${e.to}`);
    if (e.from === e.to) errors.push(`self-edge on ${e.from}`);
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) errors.push(`duplicate edge: ${key}`);
    seen.add(key);
  }

  const cycle = findCycle(g);
  if (cycle) errors.push(`cycle: ${cycle.join(" -> ")}`);

  return errors;
}

/**
 * Slayer is the reason this check exists: Cerberus is a Slayer task and gives
 * Slayer xp, so "91 Slayer -> Cerberus -> Slayer xp" wants to close a loop.
 * The fix in the data model is that levels are milestones fed by the grind,
 * never by the bosses gated behind them. This catches it if you slip.
 */
export function findCycle(g: Graph): string[] | null {
  const succs = new Map<string, string[]>();
  for (const n of g.nodes) succs.set(n.id, []);
  // Annotation edges are deliberately allowed to close loops — see EdgeType.
  for (const e of g.edges) if (isStructural(e)) succs.get(e.from)?.push(e.to);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(g.nodes.map((n) => [n.id, WHITE]));
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, GREY);
    stack.push(id);
    for (const next of succs.get(id) ?? []) {
      const c = color.get(next);
      if (c === GREY) return [...stack.slice(stack.indexOf(next)), next];
      if (c === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const n of g.nodes) {
    if (color.get(n.id) === WHITE) {
      const found = visit(n.id);
      if (found) return found;
    }
  }
  return null;
}
