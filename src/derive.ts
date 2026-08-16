import type { Graph, GraphEdge, GraphNode, NodeKind } from "./schema.ts";

/**
 * Nothing here is stored. Status, leverage and position are all recomputed from
 * (nodes, edges, done-flags) on every render — the only hand-maintained state in
 * the whole tool is which nodes you've ticked off.
 */

export type Status =
  /** ticked off */
  | "done"
  /** every prerequisite met, including the ones you merely *wanted* */
  | "ready"
  /** the game will let you, but you're missing gear you said you wanted first */
  | "possible"
  /** hard-locked behind something undone */
  | "locked";

export const BLOCKING: ReadonlySet<string> = new Set(["grants", "hard"]);

export interface Adjacency {
  byId: Map<string, GraphNode>;
  preds: Map<string, GraphEdge[]>;
  succs: Map<string, GraphEdge[]>;
}

export function adjacency(g: Graph): Adjacency {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const preds = new Map<string, GraphEdge[]>();
  const succs = new Map<string, GraphEdge[]>();
  for (const n of g.nodes) {
    preds.set(n.id, []);
    succs.set(n.id, []);
  }
  for (const e of g.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    preds.get(e.to)?.push(e);
    succs.get(e.from)?.push(e);
  }
  return { byId, preds, succs };
}

/** Kahn's algorithm. Any node caught in a cycle is appended at the end. */
export function topoOrder(g: Graph, adj: Adjacency = adjacency(g)): string[] {
  const indeg = new Map<string, number>();
  for (const n of g.nodes) indeg.set(n.id, adj.preds.get(n.id)?.length ?? 0);

  const queue = g.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    out.push(id);
    for (const e of adj.succs.get(id) ?? []) {
      const left = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }
  if (out.length < g.nodes.length) {
    const seen = new Set(out);
    for (const n of g.nodes) if (!seen.has(n.id)) out.push(n.id);
  }
  return out;
}

export function statuses(g: Graph, adj: Adjacency = adjacency(g)): Map<string, Status> {
  const out = new Map<string, Status>();
  for (const n of g.nodes) {
    if (n.done) {
      out.set(n.id, "done");
      continue;
    }
    const incoming = adj.preds.get(n.id) ?? [];
    const blocked = incoming.some(
      (e) => BLOCKING.has(e.type) && !adj.byId.get(e.from)?.done,
    );
    if (blocked) {
      out.set(n.id, "locked");
      continue;
    }
    const wantsMissing = incoming.some(
      (e) => e.type === "soft" && !adj.byId.get(e.from)?.done,
    );
    out.set(n.id, wantsMissing ? "possible" : "ready");
  }
  return out;
}

/**
 * How much of the graph is still sitting behind this node. This is the number
 * the outline could never tell you — it's why CG "feels" like the right thing to
 * chase even though nothing is hard-locked behind it.
 */
export function leverage(g: Graph, adj: Adjacency = adjacency(g)): Map<string, number> {
  const order = topoOrder(g, adj);
  const reach = new Map<string, Set<string>>();
  for (const id of [...order].reverse()) {
    const set = new Set<string>();
    for (const e of adj.succs.get(id) ?? []) {
      if (!adj.byId.get(e.to)?.done) set.add(e.to);
      for (const deep of reach.get(e.to) ?? []) set.add(deep);
    }
    reach.set(id, set);
  }
  return new Map([...reach].map(([id, set]) => [id, set.size]));
}

/** Everything you must get through to reach `id`, transitively. */
export function ancestors(id: string, adj: Adjacency): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const e of adj.preds.get(cur) ?? []) {
      if (out.has(e.from)) continue;
      out.add(e.from);
      stack.push(e.from);
    }
  }
  return out;
}

/** Everything that opens up once `id` is done, transitively. */
export function descendants(id: string, adj: Adjacency): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const e of adj.succs.get(cur) ?? []) {
      if (out.has(e.to)) continue;
      out.add(e.to);
      stack.push(e.to);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  pinned: boolean;
}

export const NODE_H = 40;
export const ROW_GAP = 18;
export const COL_GAP = 88;
export const LANE_ORDER: readonly string[] = ["quest", "pvm", "raid", "slayer", "skilling"];

/**
 * nodeWidth and fitLabel share these constants on purpose — when they drift the
 * box is sized for a label the renderer then truncates, and every node loses a
 * character for no reason.
 */
const CHAR_W = 7;
const PAD_X = 30;
const TAG_W = 26;
const MAX_W = 260;
const MIN_W = 140;

const tagWidth = (kind: NodeKind): number => (kind === "activity" ? 0 : TAG_W);

export function nodeWidth(label: string, kind: NodeKind): number {
  return Math.min(MAX_W, Math.max(MIN_W, Math.ceil(label.length * CHAR_W) + PAD_X + tagWidth(kind)));
}

/** Only ever shortens labels that hit the MAX_W cap. */
export function fitLabel(label: string, width: number, kind: NodeKind): string {
  const max = Math.max(4, Math.floor((width - PAD_X - tagWidth(kind)) / CHAR_W));
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/**
 * Layered (Sugiyama-lite) left-to-right layout: longest-path layering, then a
 * few barycenter sweeps to stop edges crossing. Deliberately automatic — hand
 * placing a DAG feels good for ten minutes and then you dread editing it. Drag
 * a node and it pins; everything else keeps arranging itself around the pin.
 */
export function layout(g: Graph, opts: { groupLanes: boolean } = { groupLanes: false }): Map<string, Placed> {
  const adj = adjacency(g);
  const order = topoOrder(g, adj);

  const layer = new Map<string, number>();
  for (const id of order) {
    const incoming = adj.preds.get(id) ?? [];
    layer.set(
      id,
      incoming.length ? Math.max(...incoming.map((e) => (layer.get(e.from) ?? 0) + 1)) : 0,
    );
  }

  const columns: string[][] = [];
  for (const n of g.nodes) {
    const l = layer.get(n.id) ?? 0;
    (columns[l] ??= []).push(n.id);
  }

  // Seed each column by lane then label so the first paint is stable, then let
  // barycenter sweeps pull connected nodes level with each other.
  const laneRank = (id: string) => {
    const lane = adj.byId.get(id)?.lane ?? "";
    const i = LANE_ORDER.indexOf(lane);
    return i === -1 ? LANE_ORDER.length : i;
  };
  for (const col of columns) {
    col.sort((a, b) => laneRank(a) - laneRank(b) || a.localeCompare(b));
  }

  const pos = new Map<string, number>();
  const reindex = () => {
    for (const col of columns) col.forEach((id, i) => pos.set(id, i));
  };
  reindex();

  const barycenter = (id: string, side: "preds" | "succs"): number | null => {
    const edges = adj[side].get(id) ?? [];
    const neighbours = edges.map((e) => pos.get(side === "preds" ? e.from : e.to));
    const known = neighbours.filter((v): v is number => v !== undefined);
    if (!known.length) return null;
    return known.reduce((a, b) => a + b, 0) / known.length;
  };

  for (let sweep = 0; sweep < 12; sweep++) {
    const side = sweep % 2 === 0 ? "preds" : "succs";
    const range = side === "preds" ? columns.keys() : [...columns.keys()].reverse();
    for (const li of range) {
      const col = columns[li];
      if (!col) continue;
      const keyed = col.map((id, i) => ({
        id,
        key: barycenter(id, side) ?? pos.get(id) ?? i,
        lane: laneRank(id),
        tie: i,
      }));
      keyed.sort((a, b) =>
        opts.groupLanes
          ? a.lane - b.lane || a.key - b.key || a.tie - b.tie
          : a.key - b.key || a.tie - b.tie,
      );
      columns[li] = keyed.map((k) => k.id);
      reindex();
    }
  }

  // Columns are as wide as their widest box, so long labels never overlap.
  const widths = columns.map((col) =>
    Math.max(
      ...(col ?? []).map((id) => {
        const n = adj.byId.get(id);
        return nodeWidth(n?.label ?? id, n?.kind ?? "activity");
      }),
      MIN_W,
    ),
  );
  const xs: number[] = [];
  let cursor = 0;
  for (let i = 0; i < columns.length; i++) {
    xs[i] = cursor;
    cursor += (widths[i] ?? 140) + COL_GAP;
  }

  const tallest = Math.max(...columns.map((c) => c?.length ?? 0), 1);
  const placed = new Map<string, Placed>();
  columns.forEach((col, li) => {
    if (!col) return;
    const span = col.length * (NODE_H + ROW_GAP);
    const top = ((tallest * (NODE_H + ROW_GAP)) - span) / 2;
    col.forEach((id, i) => {
      const node = adj.byId.get(id);
      const w = nodeWidth(node?.label ?? id, node?.kind ?? "activity");
      placed.set(id, {
        id,
        x: node?.pin?.x ?? xs[li] ?? 0,
        y: node?.pin?.y ?? top + i * (NODE_H + ROW_GAP),
        w,
        h: NODE_H,
        layer: li,
        pinned: !!node?.pin,
      });
    });
  });
  return placed;
}
