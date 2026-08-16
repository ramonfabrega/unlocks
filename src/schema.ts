import { z } from "zod";

/**
 * Node kinds. The split between activity and item is what fixes the outline
 * problem: "CG" is not a prerequisite for Muspah — *bowfa* is, and CG is merely
 * where bowfa comes from. Once items are first-class nodes, a thing that
 * unlocks two things just has two out-edges instead of being duplicated.
 */
export const NodeKind = z.enum(["activity", "item", "milestone"]);
export type NodeKind = z.infer<typeof NodeKind>;

export const Lane = z.enum(["pvm", "raid", "slayer", "skilling", "quest"]);
export type Lane = z.infer<typeof Lane>;

/**
 * Edge types, all directed from → to meaning "from comes before to".
 *
 *  grants — `to` is obtained by doing `from`   (CG grants bowfa)
 *  hard   — `to` is game-locked behind `from`  (92 Slayer gates Araxxor)
 *  soft   — you want `from` before `to`        (bowfa before Muspah)
 *
 * grants and hard both block. soft never blocks — it only downgrades a node
 * from "ready" to "possible", which is exactly the Muspah case: killable now,
 * but you'd rather have the bow first.
 */
export const EdgeType = z.enum(["grants", "hard", "soft"]);
export type EdgeType = z.infer<typeof EdgeType>;

export const Pin = z.object({ x: z.number(), y: z.number() });

export const GraphNode = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: NodeKind,
  lane: Lane,
  /** The only field the game doesn't decide for you. */
  done: z.boolean().default(false),
  note: z.string().default(""),
  wiki: z.string().default(""),
  /** Set when a game fact was seeded from memory and hasn't been checked. */
  verify: z.boolean().default(false),
  /** Manual position override; null means "let the auto-layout place it". */
  pin: Pin.nullable().default(null),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: EdgeType,
  note: z.string().default(""),
  verify: z.boolean().default(false),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const Graph = z.object({
  version: z.literal(1),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});
export type Graph = z.infer<typeof Graph>;

/** Structural problems zod's shape check can't see. Returns human-readable errors. */
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
  for (const e of g.edges) succs.get(e.from)?.push(e.to);

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
