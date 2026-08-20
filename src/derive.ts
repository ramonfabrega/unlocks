import {
  type Graph,
  type GraphEdge,
  type GraphNode,
  isStructural,
  type NodeKind,
} from "./model.ts";

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

/**
 * Structural edges only. Annotation edges (`boosts`) are excluded here rather
 * than at each call site, which is what makes them safe: every consumer of
 * adjacency — status, leverage, ancestry, topological order, layout — is
 * annotation-blind by construction, so no one has to remember to filter.
 * Reach for `annotations()` when you specifically want them.
 */
export function adjacency(g: Graph): Adjacency {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const preds = new Map<string, GraphEdge[]>();
  const succs = new Map<string, GraphEdge[]>();
  for (const n of g.nodes) {
    preds.set(n.id, []);
    succs.set(n.id, []);
  }
  for (const e of g.edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || !isStructural(e)) continue;
    preds.get(e.to)?.push(e);
    succs.get(e.from)?.push(e);
  }
  return { byId, preds, succs };
}

export interface Annotations {
  /** `id` makes these better. */
  improves: Map<string, GraphEdge[]>;
  /** These make `id` better. */
  improvedBy: Map<string, GraphEdge[]>;
}

/** The half of the graph that carries no ordering claim. May contain cycles. */
export function annotations(g: Graph): Annotations {
  const ids = new Set(g.nodes.map((n) => n.id));
  const improves = new Map<string, GraphEdge[]>();
  const improvedBy = new Map<string, GraphEdge[]>();
  for (const n of g.nodes) {
    improves.set(n.id, []);
    improvedBy.set(n.id, []);
  }
  for (const e of g.edges) {
    if (isStructural(e) || !ids.has(e.from) || !ids.has(e.to)) continue;
    improves.get(e.from)?.push(e);
    improvedBy.get(e.to)?.push(e);
  }
  return { improves, improvedBy };
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
    const blocked = incoming.some((e) => BLOCKING.has(e.type) && !adj.byId.get(e.from)?.done);
    if (blocked) {
      out.set(n.id, "locked");
      continue;
    }
    const wantsMissing = incoming.some((e) => e.type === "soft" && !adj.byId.get(e.from)?.done);
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
  return Math.min(
    MAX_W,
    Math.max(MIN_W, Math.ceil(label.length * CHAR_W) + PAD_X + tagWidth(kind)),
  );
}

/** Only ever shortens labels that hit the MAX_W cap. */
export function fitLabel(label: string, width: number, kind: NodeKind): string {
  const max = Math.max(4, Math.floor((width - PAD_X - tagWidth(kind)) / CHAR_W));
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

export interface LayoutResult {
  placed: Map<string, Placed>;
  /** Route points for edges crossing more than one layer, keyed by edgeKey. */
  bends: Map<string, Array<{ x: number; y: number }>>;
}

/** Edges are keyed with a NUL so ids containing "-" or ">" can't collide. */
export const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

/** A routed edge reserves a thin channel in every column it passes through. */
const DUMMY_H = 6;
const DUMMY_GAP = 12;

/**
 * Longest-path layering puts every node as far LEFT as its prerequisites allow,
 * which strands any node whose successors are far away: Desert Treasure II sat
 * in column 0 with its nearest real successor eleven columns to the right, and
 * every one of those columns then had to reserve a routing channel for it.
 *
 * Slide each node within the slack its neighbours leave it, minimising total
 * edge span. Moving a node one column right costs one span per predecessor and
 * saves one per successor, so the gradient is just (#preds - #succs) and greedy
 * descent on it converges in a single pass. On the seed graph: total span
 * 135 → 103, routed channels 73 → 41, longest edge 13 → 11 columns.
 *
 * Pushing every node as far right as it will go is the tempting version and it
 * is worse — it lengthens the edges of anything left behind on the left.
 *
 * The layer COUNT is untouched: that is the graph's longest path (17 columns
 * here) and no layering can compress it. This only removes slack.
 */
function tighten(g: Graph, adj: Adjacency, order: string[], layer: Map<string, number>): void {
  const maxLayer = Math.max(0, ...layer.values());

  for (let pass = 0; pass < 8; pass++) {
    let moved = 0;
    for (const id of order) {
      const incoming = adj.preds.get(id) ?? [];
      const outgoing = adj.succs.get(id) ?? [];
      const earliest = incoming.length
        ? Math.max(...incoming.map((e) => (layer.get(e.from) ?? 0) + 1))
        : 0;
      const latest = outgoing.length
        ? Math.min(...outgoing.map((e) => (layer.get(e.to) ?? maxLayer) - 1))
        : maxLayer;
      if (latest <= earliest) {
        if (layer.get(id) !== earliest) {
          layer.set(id, earliest);
          moved++;
        }
        continue;
      }
      const pull =
        incoming.length > outgoing.length
          ? earliest
          : incoming.length < outgoing.length
            ? latest
            : (layer.get(id) ?? earliest);
      const next = Math.min(latest, Math.max(earliest, pull));
      if (next !== layer.get(id)) {
        layer.set(id, next);
        moved++;
      }
    }
    if (!moved) break;
  }

  // Tightening can empty a column; close the gaps so `columns` stays dense.
  const used = [...new Set(layer.values())].sort((a, b) => a - b);
  const packed = new Map(used.map((v, i) => [v, i]));
  for (const n of g.nodes) layer.set(n.id, packed.get(layer.get(n.id) ?? 0) ?? 0);
}

/**
 * Layered (Sugiyama) left-to-right layout, in four passes:
 *
 *  1. longest-path layering                → which column each node lives in
 *  2. dummy chains for multi-layer edges   → long edges get their own channels
 *  3. barycenter sweeps                    → ordering within a column
 *  4. median alignment                     → y coordinates, edges straightened
 *
 * Step 2 is what stops an edge like "DT2 → Duke" slicing diagonally through
 * every column in between, which is most of what makes a layered graph
 * unreadable. Deliberately automatic: hand-placing a DAG feels good for ten
 * minutes and then you dread editing it. Drag a node and it pins; everything
 * else keeps arranging itself around the pin.
 */
export function layout(
  g: Graph,
  opts: { groupLanes: boolean } = { groupLanes: false },
): LayoutResult {
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
  tighten(g, adj, order, layer);

  const columns: string[][] = [];
  const addSlot = (l: number, id: string) => {
    const col = columns[l] ?? [];
    col.push(id);
    columns[l] = col;
  };
  for (const n of g.nodes) addSlot(layer.get(n.id) ?? 0, n.id);

  // --- 2. expand long edges into per-layer dummy slots -----------------------
  const dummies = new Set<string>();
  const dummyLayer = new Map<string, number>();
  const dummyLane = new Map<string, string>();
  /** Keyed by edgeKey; carries its endpoints so nothing has to re-parse the key. */
  const routeOf = new Map<string, { from: string; to: string; route: string[] }>();
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const s = succs.get(a);
    if (s) s.push(b);
    else succs.set(a, [b]);
    const p = preds.get(b);
    if (p) p.push(a);
    else preds.set(b, [a]);
  };

  for (const e of g.edges) {
    // Annotation edges get no column and no channel: they routinely point
    // backwards (ancestral improves the Slayer grind you were doing first) and
    // reserving space for them would bend the drawing around a non-claim.
    if (!isStructural(e)) continue;
    const l1 = layer.get(e.from);
    const l2 = layer.get(e.to);
    if (l1 === undefined || l2 === undefined) continue;
    if (l2 - l1 <= 1) {
      link(e.from, e.to);
      continue;
    }
    const key = edgeKey(e.from, e.to);
    const route: string[] = [];
    let prev = e.from;
    for (let l = l1 + 1; l < l2; l++) {
      const id = `~${key}~${l}`;
      dummies.add(id);
      dummyLayer.set(id, l);
      dummyLane.set(id, adj.byId.get(e.from)?.lane ?? "");
      addSlot(l, id);
      route.push(id);
      link(prev, id);
      prev = id;
    }
    link(prev, e.to);
    routeOf.set(key, { from: e.from, to: e.to, route });
  }

  const isDummy = (id: string) => dummies.has(id);
  const heightOf = (id: string) => (isDummy(id) ? DUMMY_H : NODE_H);
  const gapOf = (a: string, b: string) => (isDummy(a) || isDummy(b) ? DUMMY_GAP : ROW_GAP);

  // --- 3. ordering within each column ---------------------------------------
  const laneRank = (id: string) => {
    const lane = dummyLane.get(id) ?? adj.byId.get(id)?.lane ?? "";
    const i = LANE_ORDER.indexOf(lane);
    return i === -1 ? LANE_ORDER.length : i;
  };
  for (const col of columns) {
    col?.sort((a, b) => laneRank(a) - laneRank(b) || a.localeCompare(b));
  }

  const pos = new Map<string, number>();
  const reindex = () => {
    for (const col of columns) {
      if (!col) continue;
      for (const [i, id] of col.entries()) pos.set(id, i);
    }
  };
  reindex();

  const barycenter = (id: string, side: Map<string, string[]>): number | null => {
    const known = (side.get(id) ?? [])
      .map((n) => pos.get(n))
      .filter((v): v is number => v !== undefined);
    if (!known.length) return null;
    return known.reduce((a, b) => a + b, 0) / known.length;
  };

  for (let sweep = 0; sweep < 12; sweep++) {
    const forward = sweep % 2 === 0;
    const side = forward ? preds : succs;
    const range = forward ? [...columns.keys()] : [...columns.keys()].reverse();
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

  // Columns are as wide as their widest real box; dummies are just channels.
  const widths = columns.map((col) =>
    Math.max(
      ...(col ?? [])
        .filter((id) => !isDummy(id))
        .map((id) => {
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
    cursor += (widths[i] ?? MIN_W) + COL_GAP;
  }

  // --- 4. y coordinates ------------------------------------------------------
  const y = new Map<string, number>();
  for (const col of columns) {
    if (!col) continue;
    let top = 0;
    let prev: string | null = null;
    for (const id of col) {
      if (prev) top += gapOf(prev, id);
      y.set(id, top);
      top += heightOf(id);
      prev = id;
    }
  }

  const centre = (id: string) => (y.get(id) ?? 0) + heightOf(id) / 2;

  // Pull every slot toward the average centre of its neighbours, then push the
  // column apart just enough to stop overlaps. This is what makes a routed edge
  // come out as a straight line rather than a staircase.
  for (let pass = 0; pass < 10; pass++) {
    const forward = pass % 2 === 0;
    const side = forward ? preds : succs;
    const range = forward ? [...columns.keys()] : [...columns.keys()].reverse();
    for (const li of range) {
      const col = columns[li];
      if (!col?.length) continue;

      const want = col.map((id) => {
        const nb = side.get(id) ?? [];
        return nb.length ? nb.reduce((a, n) => a + centre(n), 0) / nb.length : centre(id);
      });

      const tops: number[] = [];
      for (let i = 0; i < col.length; i++) {
        const id = col[i] as string;
        let top = (want[i] as number) - heightOf(id) / 2;
        if (i > 0) {
          const p = col[i - 1] as string;
          top = Math.max(top, (tops[i - 1] as number) + heightOf(p) + gapOf(p, id));
        }
        tops.push(top);
      }

      // Re-centre, or separation pressure marches the whole column downwards.
      let got = 0;
      for (let i = 0; i < col.length; i++) {
        got += (tops[i] as number) + heightOf(col[i] as string) / 2;
      }
      const shift = want.reduce((a, b) => a + b, 0) / want.length - got / col.length;
      for (let i = 0; i < col.length; i++) y.set(col[i] as string, (tops[i] as number) + shift);
    }
  }

  /**
   * Pin one slot at `top` and shove the rest of its column aside to make room,
   * keeping the established order. Overlap-free by construction: a neighbour is
   * only ever pushed further away from the anchor, never toward it.
   *
   * Slots in `locked` were placed by a longer chain earlier in this pass. `top`
   * is first clamped into whatever room they leave, so a short chain bends
   * around a long one instead of kicking it off its line — without that, the
   * last chain to be processed wins and every earlier one is left staircased.
   * The clamp is advisory: the push loops below still run unconditionally, so
   * an over-constrained column stays overlap-free either way.
   */
  const anchor = (col: string[], at: number, top: number, locked: ReadonlySet<string>): void => {
    const anchored = col[at];
    if (!anchored) return;

    let minTop = Number.NEGATIVE_INFINITY;
    let acc = 0;
    for (let i = at - 1; i >= 0; i--) {
      const cur = col[i] as string;
      acc += heightOf(cur) + gapOf(cur, col[i + 1] as string);
      if (locked.has(cur)) minTop = Math.max(minTop, (y.get(cur) ?? 0) + acc);
    }
    let maxTop = Number.POSITIVE_INFINITY;
    acc = 0;
    for (let i = at + 1; i < col.length; i++) {
      const cur = col[i] as string;
      acc += heightOf(col[i - 1] as string) + gapOf(col[i - 1] as string, cur);
      if (locked.has(cur)) maxTop = Math.min(maxTop, (y.get(cur) ?? 0) - acc);
    }
    if (minTop <= maxTop) top = Math.min(maxTop, Math.max(minTop, top));

    y.set(anchored, top);
    for (let i = at - 1; i >= 0; i--) {
      const cur = col[i] as string;
      const below = col[i + 1] as string;
      const maxTop = (y.get(below) ?? 0) - gapOf(cur, below) - heightOf(cur);
      if ((y.get(cur) ?? 0) > maxTop) y.set(cur, maxTop);
    }
    for (let i = at + 1; i < col.length; i++) {
      const cur = col[i] as string;
      const above = col[i - 1] as string;
      const minTop = (y.get(above) ?? 0) + heightOf(above) + gapOf(above, cur);
      if ((y.get(cur) ?? 0) < minTop) y.set(cur, minTop);
    }
  };

  // Median alignment gets a chain close, but real nodes sharing its columns
  // still nudge it into a slope. Anchor each routed chain onto the straight line
  // between its endpoints and push the columns out of its way — clamping it to
  // existing slack instead leaves bends stranded wherever a column is crowded.
  //
  // Longest chain first: it crosses the most columns, so it is the one that
  // reads as a diagonal slash across the whole drawing when it bends, and it has
  // the least room to recover. Each chain locks its slots for the rest of the
  // pass so the next one has to work around it.
  const chains = [...routeOf.values()].sort((a, b) => b.route.length - a.route.length);
  const ANCHOR_PASSES = 6;
  for (let pass = 0; pass < ANCHOR_PASSES; pass++) {
    // Ease in: early passes only nudge, so chains crossing the same columns
    // settle into a shared compromise instead of the last one written winning
    // outright. The final passes place exactly.
    const damp = Math.min(1, 0.25 + (pass / ANCHOR_PASSES) * 1.5);
    const locked = new Set<string>();
    for (const { from, to, route } of chains) {
      const fromNode = adj.byId.get(from);
      // Interpolate against the exact geometry the renderer will use: the line
      // runs from the source's right edge to the target's left edge, and each
      // bend sits at the horizontal centre of its column.
      const x0 =
        (xs[layer.get(from) ?? 0] ?? 0) +
        nodeWidth(fromNode?.label ?? from, fromNode?.kind ?? "activity");
      const x1 = xs[layer.get(to) ?? 0] ?? 0;
      const spanX = x1 - x0 || 1;
      const fy = centre(from);
      const ty = centre(to);

      for (const d of route) {
        const l = dummyLayer.get(d) ?? 0;
        const col = columns[l];
        if (!col) continue;
        const t = ((xs[l] ?? 0) + (widths[l] ?? MIN_W) / 2 - x0) / spanX;
        const target = fy + (ty - fy) * t - DUMMY_H / 2;
        const cur = y.get(d) ?? target;
        anchor(col, pos.get(d) ?? 0, cur + (target - cur) * damp, locked);
      }
      for (const d of route) locked.add(d);
    }
  }

  let minY = Number.POSITIVE_INFINITY;
  for (const v of y.values()) minY = Math.min(minY, v);
  if (Number.isFinite(minY)) for (const [k, v] of y) y.set(k, v - minY);

  const placed = new Map<string, Placed>();
  columns.forEach((col, li) => {
    if (!col) return;
    for (const id of col) {
      if (isDummy(id)) continue;
      const node = adj.byId.get(id);
      placed.set(id, {
        id,
        x: node?.pin?.x ?? xs[li] ?? 0,
        y: node?.pin?.y ?? y.get(id) ?? 0,
        w: nodeWidth(node?.label ?? id, node?.kind ?? "activity"),
        h: NODE_H,
        layer: li,
        pinned: !!node?.pin,
      });
    }
  });

  const bends = new Map<string, Array<{ x: number; y: number }>>();
  for (const [key, { from, to, route }] of routeOf) {
    // A pinned endpoint has left the layer grid, so its channel no longer lines
    // up — route those straight instead of through stale bends.
    if (adj.byId.get(from)?.pin || adj.byId.get(to)?.pin) continue;
    bends.set(
      key,
      route.map((id) => {
        const l = dummyLayer.get(id) ?? 0;
        return {
          x: (xs[l] ?? 0) + (widths[l] ?? MIN_W) / 2,
          y: (y.get(id) ?? 0) + DUMMY_H / 2,
        };
      }),
    );
  }

  return { placed, bends };
}
