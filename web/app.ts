import {
  adjacency,
  ancestors,
  annotations,
  descendants,
  edgeKey,
  fitLabel,
  layout,
  leverage,
  type Placed,
  type Status,
  statuses,
} from "../src/derive.ts";
import {
  type EdgeType,
  type Graph,
  type GraphEdge,
  type GraphNode,
  isStructural,
  type Lane,
  type NodeKind,
} from "../src/schema.ts";

const LANES: Lane[] = ["quest", "pvm", "raid", "slayer", "skilling"];
const KINDS: NodeKind[] = ["activity", "item", "milestone"];
const EDGE_TYPES: EdgeType[] = ["grants", "hard", "soft", "boosts"];
const KIND_TAG: Record<NodeKind, string> = { activity: "", item: "item", milestone: "lvl" };

// ---------------------------------------------------------------------- state

let graph: Graph = { version: 1, nodes: [], edges: [] };
let selected: string | null = null;
const hidden = new Set<Lane>();
let query = "";
let groupLanes = false;
let hideDone = false;
/** Hops around the SELECTED node to draw; null shows the whole map. See visibleGraph. */
let depth: number | null = 2;
/** When set, everything unrelated to this node is dimmed. */
let focus: string | null = null;
const view = { x: 60, y: 40, k: 0.9 };

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const svg = $<SVGSVGElement>("#canvas");
const gViewport = $<SVGGElement>("#viewport");
const gNodes = $<SVGGElement>("#nodes");
const gEdges = $<SVGGElement>("#edges");
const dragEdgePath = $<SVGPathElement>("#drag-edge");
const rightPanel = $("#right");

/** Two indicators once the mobile topbar exists — keep them in lockstep. */
const saveStates = [...document.querySelectorAll<HTMLElement>(".save-state")];
function setStatus(text: string, cls = ""): void {
  for (const el of saveStates) {
    el.textContent = text;
    el.className = `save save-state ${cls}`.trim();
  }
}

const isMobile = () => window.matchMedia("(max-width: 900px)").matches;
const closeDrawer = () => document.body.classList.remove("drawer-open");

// ---------------------------------------------------------------------- history

/**
 * Whole-graph snapshots. The graph is a few tens of kilobytes of JSON and edits
 * are hand-speed, so there is nothing to gain from a command log and quite a lot
 * to lose — every mutation would have to describe and invert itself, and the one
 * that forgot would corrupt the stack silently.
 *
 * This is also what makes `delete node` safe to leave un-confirmed. A dialog on
 * every delete taxes the common case to guard the rare one; ctrl+Z costs nothing
 * until you need it.
 */
const past: string[] = [];
const future: string[] = [];
const HISTORY_MAX = 80;

const snapshot = (): string => JSON.stringify(graph);

function record(before: string): void {
  if (before === snapshot()) return; // nothing actually changed
  past.push(before);
  if (past.length > HISTORY_MAX) past.shift();
  future.length = 0;
}

/** Snapshot, mutate, record, persist, redraw — the shape of every edit. */
function edit(mutate: () => void): void {
  const before = snapshot();
  mutate();
  record(before);
  save();
  render();
}

function step(from: string[], to: string[], what: string): void {
  const target = from.pop();
  if (target === undefined) {
    setStatus(`nothing to ${what}`);
    return;
  }
  to.push(snapshot());
  graph = JSON.parse(target) as Graph;
  // Selection and focus can point at something that no longer exists; the
  // editor and the dimming both cope with a dangling id, so leave them be
  // rather than clearing what is usually still valid. The graph visibly
  // changing back is the feedback — no status message needed.
  save();
  render();
}

const undo = () => step(past, future, "undo");
const redo = () => step(future, past, "redo");

// ---------------------------------------------------------------------- io

async function load(): Promise<void> {
  const res = await fetch("/api/graph");
  graph = await res.json();

  const restored = loadSession();
  // A link beats a remembered camera: following #zulrah should land on Zulrah,
  // not wherever this browser happened to be last night.
  const linked = hashTarget();
  if (linked) selected = linked;
  // A remembered selection can name a node deleted since; drop it rather than
  // opening an empty panel.
  if (selected && !nodeById(selected)) selected = null;
  if (focus && !nodeById(focus)) focus = null;

  // The toggles are read from the DOM, so a restored session has to be pushed
  // back into it or the checkbox and the drawing disagree.
  $<HTMLInputElement>("#group-lanes").checked = groupLanes;
  $<HTMLInputElement>("#hide-done").checked = hideDone;

  if (!restored || (depth !== null && selected)) fitToContent();
  render();
  if (linked) focusCamera(linked);
  syncHash();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
/** Set when an edit lands mid-request; the in-flight save re-runs on completion. */
let resaveWanted = false;

function save(): void {
  setStatus("saving…", "dirty");
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    // Re-entering save() here used to reset the whole 450ms debounce, so a long
    // request turned into a spin that only stopped when it landed. Flag it and
    // let the finally block fire once instead.
    if (inFlight) {
      resaveWanted = true;
      return;
    }
    inFlight = true;
    try {
      const res = await fetch("/api/graph", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(graph),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setStatus(`rejected: ${body.error ?? res.status}`, "error");
        return;
      }
      setStatus("saved");
    } catch (err) {
      setStatus("offline — server down?", "error");
      console.error(err);
    } finally {
      inFlight = false;
      if (resaveWanted) {
        resaveWanted = false;
        save();
      }
    }
  }, 450);
}

// ---------------------------------------------------------------------- session

/**
 * Everything here is about where you were looking, never about the graph — the
 * graph lives on the server and in git. Losing it costs nothing; not having it
 * meant every reload dumped you back at the far left of a 4000px drawing with
 * your filters cleared.
 */
const SESSION_KEY = "unlocks:session";

let sessionTimer: ReturnType<typeof setTimeout> | null = null;
function saveSession(): void {
  // Panning fires this per frame, so coalesce.
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    try {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ view, hidden: [...hidden], hideDone, groupLanes, depth, selected, focus }),
      );
    } catch {
      // Private browsing, quota, a disabled store — none of it is worth an error.
    }
  }, 250);
}

/** Returns whether a camera was restored, so load() knows to skip the auto-fit. */
function loadSession(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SESSION_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const s = JSON.parse(raw);
    if (Array.isArray(s.hidden)) for (const l of s.hidden) hidden.add(l as Lane);
    hideDone = !!s.hideDone;
    groupLanes = !!s.groupLanes;
    if (s.depth === null || typeof s.depth === "number") depth = s.depth;
    selected = typeof s.selected === "string" ? s.selected : null;
    focus = typeof s.focus === "string" ? s.focus : null;
    if (s.view && Number.isFinite(s.view.k)) {
      view.x = s.view.x;
      view.y = s.view.y;
      view.k = s.view.k;
      return true;
    }
  } catch {
    // A stale or hand-mangled entry just means a fresh session.
  }
  return false;
}

/**
 * The URL is the shareable half of the same idea: #node-id opens the graph with
 * that node selected and centred, which is how you point someone at one.
 */
function syncHash(): void {
  const want = selected ? `#${selected}` : "";
  if (location.hash === want) return;
  history.replaceState(null, "", want || location.pathname + location.search);
}

const hashTarget = (): string | null => {
  const id = decodeURIComponent(location.hash.slice(1));
  return id && nodeById(id) ? id : null;
};

// ---------------------------------------------------------------------- helpers

const nodeById = (id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);
const labelOf = (id: string): string => nodeById(id)?.label ?? id;

function slug(label: string): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "node";
  if (!nodeById(base)) return base;
  let i = 2;
  while (nodeById(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Ids are permanent — edges reference them and the commit log is read against
 * them — but `+ node` has to mint one before you have typed a name, so it used
 * to slug the placeholder. A quarter of the graph ended up called `new-node-11`.
 *
 * A fresh node gets a marked id instead, and takes its real one the first time
 * you name it. After that the id is fixed, exactly as before: renaming Zulrah
 * does not renumber it.
 */
/** slug() collapses runs of punctuation, so it can never mint a double dash. */
const PROVISIONAL = "new--";
const provisionalId = (): string => PROVISIONAL + Date.now().toString(36);

function adoptLabelAsId(n: GraphNode): void {
  if (!n.id.startsWith(PROVISIONAL)) return;
  // Only safe while nothing points at the old id. Linking before naming is rare
  // but it must not silently break the edge.
  if (graph.edges.some((e) => e.from === n.id || e.to === n.id)) return;
  const id = slug(n.label);
  if (selected === n.id) selected = id;
  if (focus === n.id) focus = id;
  n.id = id;
}

/** A -> B closes a loop exactly when A is already downstream of B. */
function wouldCycle(from: string, to: string): boolean {
  if (from === to) return true;
  return descendants(to, adjacency(graph)).has(from);
}

const matchesQuery = (n: GraphNode): boolean =>
  !query || n.label.toLowerCase().includes(query) || n.id.includes(query);

const isVisible = (n: GraphNode): boolean => !hidden.has(n.lane) && !(hideDone && n.done);

/**
 * The lens.
 *
 * The whole graph is 4000px wide and 640px tall — a shape no screen matches, so
 * the map view is a poster you pan across rather than something you read. But
 * almost every actual question is local: what does this need, what does it open
 * up, what else is near it. Those answers involve five to fifteen nodes and fit
 * on a phone.
 *
 * So `depth` bounds how many hops from the SELECTED node the picture reaches,
 * and null means the old whole-map behaviour. Layout runs on the result, so the
 * drawing genuinely recompacts rather than hiding parts of a big one.
 *
 * Measured on the seed graph — selecting one node and growing outwards:
 *
 *            1 hop   2 hops   3 hops
 *   cg           3        7       16
 *   zulrah       4       11       23
 *   slayer       10      19       30
 *
 * Two hops is the readable range, which is why it is the default.
 *
 * It keys off the selection and nothing else. Seeding from the frontier instead
 * — "show me everything I could start, plus context" — sounds better and is not:
 * 14 seeds reach 39 nodes at one hop and 47 at two, which is the whole map again
 * with extra steps. With nothing selected you get the map, and the sidebar
 * answers "what can I do" better than fourteen disconnected boxes would.
 */
function withinDepth(seeds: string[], radius: number): Set<string> {
  const near = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const l = near.get(a);
    if (l) l.push(b);
    else near.set(a, [b]);
  };
  // Undirected, and annotations count: "what improves this" is exactly the kind
  // of neighbour you opened the node to find.
  for (const e of graph.edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }

  const seen = new Set(seeds);
  let layer = seeds;
  for (let d = 0; d < radius && layer.length; d++) {
    const next: string[] = [];
    for (const id of layer) {
      for (const nb of near.get(id) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
      }
    }
    layer = next;
  }
  return seen;
}

/**
 * The graph minus whatever is filtered out. Layout runs on THIS so hiding
 * compacts the picture instead of leaving holes — but status and leverage are
 * always computed from the full graph, or hiding a done prerequisite would make
 * everything downstream of it look locked again.
 */
function visibleGraph(): Graph {
  const keep = new Set(graph.nodes.filter(isVisible).map((n) => n.id));
  if (depth !== null && selected && keep.has(selected)) {
    const lens = withinDepth([selected], depth);
    for (const id of [...keep]) if (!lens.has(id)) keep.delete(id);
  }
  return {
    version: graph.version,
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}

/** Every hit-test and camera move must use the same layout the user is seeing. */
const currentLayout = () => layout(visibleGraph(), { groupLanes });

// ---------------------------------------------------------------------- render

function render(): void {
  const adj = adjacency(graph);
  const status = statuses(graph, adj);
  const lev = leverage(graph, adj);
  const vg = visibleGraph();
  const { placed, bends } = layout(vg, { groupLanes });

  // Both directions: what you must get through to reach it, AND what it opens
  // up. Ancestors alone answered "what do I need", which is only half of why you
  // point at a node — the other half is "so what if I do it".
  const litNodes = focus
    ? new Set([focus, ...ancestors(focus, adj), ...descendants(focus, adj)])
    : null;

  renderEdges(vg, placed, bends, litNodes);
  renderNodes(vg, placed, status, litNodes);
  renderFrontier(status, lev, adj);
  renderLaneChips();
  renderDepth();
  renderStats(status);
  renderEditor(adj, annotations(graph), status, lev);
  applyView();
  syncHash();
}

type Pt = { x: number; y: number };

/**
 * Smooth cubic through the routed channel points. Straight runs are emitted as
 * lines — a bezier between two points at the same height still renders a faint
 * wobble, and a long routed edge is mostly straight runs.
 */
function routePath(points: Pt[]): string {
  const first = points[0];
  if (!first) return "";
  let d = `M${first.x},${first.y}`;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1] as Pt;
    const p1 = points[i] as Pt;
    if (Math.abs(p1.y - p0.y) < 1) {
      d += ` L${p1.x},${p1.y}`;
      continue;
    }
    const dx = Math.max(24, (p1.x - p0.x) * 0.5);
    d += ` C${p0.x + dx},${p0.y} ${p1.x - dx},${p1.y} ${p1.x},${p1.y}`;
  }
  return d;
}

function renderEdges(
  vg: Graph,
  placed: Map<string, Placed>,
  bends: Map<string, Pt[]>,
  lit: Set<string> | null,
): void {
  const parts: string[] = [];
  for (const e of vg.edges) {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b) continue;

    // Annotation edges are drawn only for the node you are looking at. Painting
    // all of them all the time is what would turn the map back into hairball —
    // and they are precisely the edges that point backwards.
    if (!isStructural(e)) {
      if (selected !== e.from && selected !== e.to) continue;
      parts.push(`<path class="edge boosts" d="${annotationPath(a, b)}"></path>`);
      continue;
    }

    const via = bends.get(edgeKey(e.from, e.to)) ?? [];
    const d = routePath([{ x: a.x + a.w, y: a.y + a.h / 2 }, ...via, { x: b.x, y: b.y + b.h / 2 }]);

    const onPath = lit ? lit.has(e.from) && lit.has(e.to) : false;
    const cls = lit ? (onPath ? `edge ${e.type} lit` : `edge ${e.type} dim`) : `edge ${e.type}`;
    parts.push(`<path class="${cls}" d="${d}"></path>`);
  }
  gEdges.innerHTML = parts.join("");
}

/**
 * Annotation edges get no routing channel, so they take the direct line and bow
 * out of it — enough curve to read as a separate kind of statement, and to stay
 * visible when it runs backwards underneath the columns it crosses.
 */
function annotationPath(a: Placed, b: Placed): string {
  const backwards = b.x < a.x;
  const x0 = backwards ? a.x : a.x + a.w;
  const x1 = backwards ? b.x + b.w : b.x;
  const y0 = a.y + a.h / 2;
  const y1 = b.y + b.h / 2;
  const bow = Math.max(30, Math.abs(x1 - x0) * 0.18);
  return `M${x0},${y0} C${x0 + (backwards ? -bow : bow)},${y0 - bow} ${x1 + (backwards ? bow : -bow)},${y1 - bow} ${x1},${y1}`;
}

function renderNodes(
  vg: Graph,
  placed: Map<string, Placed>,
  status: Map<string, Status>,
  lit: Set<string> | null,
): void {
  const parts: string[] = [];
  for (const n of vg.nodes) {
    const p = placed.get(n.id);
    if (!p) continue;

    const st = status.get(n.id) ?? "locked";
    const dim = (lit && !lit.has(n.id)) || (query && !matchesQuery(n));
    const cls = [
      "node",
      `s-${st}`,
      `lane-${n.lane}`,
      selected === n.id ? "sel" : "",
      p.pinned ? "pinned" : "",
      dim ? "dim" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const cy = p.y + p.h / 2;
    const tag = KIND_TAG[n.kind];
    parts.push(
      `<g class="${cls}" data-id="${n.id}">` +
        `<rect class="box" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"></rect>` +
        `<rect class="stripe" x="${p.x + 3}" y="${p.y + 7}" width="3" height="${p.h - 14}"></rect>` +
        `<text class="label" x="${p.x + 14}" y="${cy}">${esc(fitLabel(n.label, p.w, n.kind))}</text>` +
        (tag ? `<text class="kind" x="${p.x + p.w - 10}" y="${cy}">${tag}</text>` : "") +
        (n.verify ? `<text class="flag" x="${p.x + p.w - 8}" y="${p.y + 8}">?</text>` : "") +
        // A pinned node sits outside the auto-layout, so say so on the node
        // itself — otherwise "why is this one in a weird place" has no answer.
        (p.pinned
          ? `<circle class="pinmark" cx="${p.x + 8}" cy="${p.y + 7}" r="2.5"></circle>`
          : "") +
        // Invisible hit target first, so grabbing the link handle doesn't
        // demand 5px precision (a miss pans the canvas instead).
        `<circle class="handle hit" cx="${p.x + p.w}" cy="${cy}" r="13"></circle>` +
        `<circle class="handle knob" cx="${p.x + p.w}" cy="${cy}" r="5"></circle>` +
        `<title>${esc(n.label)}${n.note ? `\n${esc(n.note)}` : ""}</title>` +
        `</g>`,
    );
  }
  gNodes.innerHTML = parts.join("");
}

function renderFrontier(
  status: Map<string, Status>,
  lev: Map<string, number>,
  adj: ReturnType<typeof adjacency>,
): void {
  const open = graph.nodes
    .filter((n) => {
      const st = status.get(n.id);
      return (st === "ready" || st === "possible") && !hidden.has(n.lane) && matchesQuery(n);
    })
    .sort((a, b) => {
      const rank = (id: string) => (status.get(id) === "ready" ? 0 : 1);
      return rank(a.id) - rank(b.id) || (lev.get(b.id) ?? 0) - (lev.get(a.id) ?? 0);
    });

  $("#frontier").innerHTML = open.length
    ? open.map((n) => row(n, status.get(n.id) ?? "ready", lev.get(n.id) ?? 0)).join("")
    : `<li class="empty">nothing available — check your filters</li>`;
  $("#frontier-count").textContent = String(open.length);

  // "One unlock away": locked, but every missing hard prerequisite is itself doable now.
  const soon = graph.nodes
    .filter((n) => {
      if (status.get(n.id) !== "locked" || hidden.has(n.lane) || !matchesQuery(n)) return false;
      const missing = (adj.preds.get(n.id) ?? []).filter(
        (e) => (e.type === "grants" || e.type === "hard") && !nodeById(e.from)?.done,
      );
      return (
        missing.length > 0 &&
        missing.every((e) => {
          const st = status.get(e.from);
          return st === "ready" || st === "possible";
        })
      );
    })
    .sort((a, b) => (lev.get(b.id) ?? 0) - (lev.get(a.id) ?? 0));

  $("#soon").innerHTML = soon.length
    ? soon.map((n) => row(n, "locked", lev.get(n.id) ?? 0)).join("")
    : `<li class="empty">—</li>`;
  $("#soon-count").textContent = String(soon.length);
}

const row = (n: GraphNode, st: Status, lv: number): string =>
  `<li data-id="${n.id}"><span class="dot ${st}"></span>${esc(n.label)}` +
  `<span class="lv">${lv || ""}</span></li>`;

function renderLaneChips(): void {
  $("#lanes").innerHTML = LANES.map(
    (l) =>
      `<span class="chip ${hidden.has(l) ? "" : "on"}" data-lane="${l}" ` +
      `style="color:var(--lane-${l})">${l}</span>`,
  ).join("");
}

function renderStats(status: Map<string, Status>): void {
  const counts = { done: 0, ready: 0, possible: 0, locked: 0 };
  for (const n of graph.nodes) counts[status.get(n.id) ?? "locked"]++;
  const unverified = graph.nodes.filter((n) => n.verify).length;
  const shown = graph.nodes.filter(isVisible).length;
  $("#stats").textContent =
    `${graph.nodes.length} nodes · ${counts.done} done · ${counts.locked} locked` +
    (unverified ? ` · ${unverified} to verify` : "") +
    (shown < graph.nodes.length ? ` · ${graph.nodes.length - shown} hidden` : "");
}

// ---------------------------------------------------------------------- editor

function renderEditor(
  adj: ReturnType<typeof adjacency>,
  ann: ReturnType<typeof annotations>,
  status: Map<string, Status>,
  lev: Map<string, number>,
): void {
  const n = selected ? nodeById(selected) : undefined;
  if (!n) {
    rightPanel.className = "panel hidden";
    rightPanel.innerHTML = "";
    return;
  }
  rightPanel.className = "panel";

  const st = status.get(n.id) ?? "locked";
  const preds = adj.preds.get(n.id) ?? [];
  const succs = adj.succs.get(n.id) ?? [];
  const improves = ann.improves.get(n.id) ?? [];
  const improvedBy = ann.improvedBy.get(n.id) ?? [];

  const depRow = (e: GraphEdge, dir: "in" | "out") => {
    const other = dir === "in" ? e.from : e.to;
    return (
      `<div class="dep" data-from="${e.from}" data-to="${e.to}">` +
      `<span class="dot ${status.get(other) ?? "locked"}"></span>` +
      `<span class="name" data-goto="${other}">${esc(labelOf(other))}</span>` +
      `<select class="etype">${EDGE_TYPES.map(
        (t) => `<option value="${t}"${t === e.type ? " selected" : ""}>${t}</option>`,
      ).join("")}</select>` +
      `<button class="x" type="button">×</button></div>`
    );
  };

  rightPanel.innerHTML =
    `<header class="brand"><h1>${esc(n.label)}</h1>` +
    `<span class="save"><span class="dot ${st}"></span> ${st}</span>` +
    `<button id="e-close" class="sheet-close" type="button" aria-label="Close">×</button></header>` +
    (n.verify
      ? `<div class="warn">Unverified game fact — I seeded this from memory. ` +
        `Check it, then clear the flag.${n.note ? `<br><br>${esc(n.note)}` : ""}</div>`
      : "") +
    `<div class="row">` +
    `<button id="e-done" type="button" class="${n.done ? "" : "primary"}">` +
    `${n.done ? "mark not done" : "mark done"}</button>` +
    `<button id="e-focus" type="button">${focus === n.id ? "clear trace" : "trace"}</button>` +
    `</div>` +
    `<div class="field"><label>label</label><input id="e-label" type="text" value="${esc(n.label)}" /></div>` +
    `<div class="row">` +
    `<div class="field"><label>kind</label><select id="e-kind">${KINDS.map(
      (k) => `<option value="${k}"${k === n.kind ? " selected" : ""}>${k}</option>`,
    ).join("")}</select></div>` +
    `<div class="field"><label>lane</label><select id="e-lane">${LANES.map(
      (l) => `<option value="${l}"${l === n.lane ? " selected" : ""}>${l}</option>`,
    ).join("")}</select></div>` +
    `</div>` +
    `<div class="field"><label>note</label><textarea id="e-note">${esc(n.note)}</textarea></div>` +
    `<div class="field"><label>wiki</label><input id="e-wiki" type="text" value="${esc(n.wiki)}" /></div>` +
    `<div class="block"><h2>needs <span class="count">${preds.length}</span></h2>` +
    (preds.length ? preds.map((e) => depRow(e, "in")).join("") : `<p class="hint">nothing</p>`) +
    `</div>` +
    `<div class="block"><h2>unlocks <span class="count">${succs.length}</span></h2>` +
    (succs.length ? succs.map((e) => depRow(e, "out")).join("") : `<p class="hint">nothing</p>`) +
    `<p class="hint">${lev.get(n.id) ?? 0} node(s) sit behind this in total.</p></div>` +
    (improves.length
      ? `<div class="block"><h2>improves <span class="count">${improves.length}</span></h2>` +
        improves.map((e) => depRow(e, "out")).join("") +
        `</div>`
      : "") +
    (improvedBy.length
      ? `<div class="block"><h2>improved by <span class="count">${improvedBy.length}</span></h2>` +
        improvedBy.map((e) => depRow(e, "in")).join("") +
        `</div>`
      : "") +
    `<footer class="foot">` +
    (n.verify ? `<button id="e-verified" type="button">mark verified</button>` : "") +
    (n.pin ? `<button id="e-unpin" type="button">unpin</button>` : "") +
    (n.wiki ? `<button id="e-wikiopen" type="button">wiki ↗</button>` : "") +
    `<button id="e-delete" type="button" class="danger">delete node</button></footer>`;

  wireEditor(n);
}

function wireEditor(n: GraphNode): void {
  const onEdit = (sel: string, ev: "input" | "change", fn: (v: string) => void) => {
    const el = rightPanel.querySelector<HTMLInputElement | HTMLSelectElement>(sel);
    el?.addEventListener(ev, () => edit(() => fn(el.value)));
  };

  onEdit("#e-label", "change", (v) => {
    n.label = v.trim() || n.label;
    adoptLabelAsId(n);
  });
  onEdit("#e-kind", "change", (v) => {
    n.kind = v as NodeKind;
  });
  onEdit("#e-lane", "change", (v) => {
    n.lane = v as Lane;
  });
  onEdit("#e-note", "change", (v) => {
    n.note = v;
  });
  onEdit("#e-wiki", "change", (v) => {
    n.wiki = v.trim();
  });

  const click = (sel: string, fn: () => void) =>
    rightPanel.querySelector(sel)?.addEventListener("click", fn);

  click("#e-close", () => {
    selected = null;
    render();
  });
  click("#e-done", () =>
    edit(() => {
      n.done = !n.done;
    }),
  );
  click("#e-focus", () => {
    focus = focus === n.id ? null : n.id;
    render();
  });
  click("#e-verified", () =>
    edit(() => {
      n.verify = false;
    }),
  );
  click("#e-unpin", () =>
    edit(() => {
      n.pin = null;
    }),
  );
  click("#e-wikiopen", () => window.open(n.wiki, "_blank", "noopener"));
  // No confirm dialog on purpose: ctrl+Z brings it back, edges and all.
  click("#e-delete", () =>
    edit(() => {
      graph.nodes = graph.nodes.filter((x) => x.id !== n.id);
      graph.edges = graph.edges.filter((e) => e.from !== n.id && e.to !== n.id);
      if (focus === n.id) focus = null;
      selected = null;
    }),
  );

  for (const dep of rightPanel.querySelectorAll<HTMLElement>(".dep")) {
    const from = dep.dataset.from ?? "";
    const to = dep.dataset.to ?? "";
    const edge = graph.edges.find((e) => e.from === from && e.to === to);
    dep.querySelector(".name")?.addEventListener("click", () => {
      selected = dep.querySelector<HTMLElement>(".name")?.dataset.goto ?? null;
      render();
    });
    dep.querySelector<HTMLSelectElement>(".etype")?.addEventListener("change", (ev) => {
      const select = ev.target as HTMLSelectElement;
      const next = select.value as EdgeType;
      if (!edge) return;
      // Promoting an annotation to a real dependency can close a loop that was
      // legal while it carried no ordering claim. Catch it here rather than
      // letting the save bounce off the server with a cycle error.
      if (isStructural({ type: next }) && !isStructural(edge) && wouldCycle(edge.from, edge.to)) {
        select.value = edge.type;
        setStatus(`${labelOf(edge.to)} already leads to ${labelOf(edge.from)}`, "error");
        return;
      }
      edit(() => {
        edge.type = next;
      });
    });
    dep.querySelector(".x")?.addEventListener("click", () => {
      edit(() => {
        graph.edges = graph.edges.filter((e) => !(e.from === from && e.to === to));
      });
    });
  }
}

// ---------------------------------------------------------------------- view

function applyView(): void {
  gViewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
  saveSession();
}

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const r = svg.getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
}

function fitToContent(): void {
  const { placed } = currentLayout();
  if (!placed.size) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  const r = svg.getBoundingClientRect();
  const pad = 48;
  const w = maxX - minX;
  const h = maxY - minY;
  const [floor, cap] = isMobile() ? [0.3, 0.6] : [0.55, 1];

  // Whether the whole drawing can be shown at a legible zoom decides the whole
  // behaviour. A lens can, so centre it and show all of it. The full map cannot
  // — a 17-layer DAG squeezed into one screen is unreadable — so fit the height
  // only, pin to the roots on the left, and let the user pan rightward through
  // the progression.
  const both = Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h);
  const wholeThingFits = both >= floor;

  view.k = Math.min(cap, Math.max(floor, wholeThingFits ? both : (r.height - pad * 2) / h));
  view.x = wholeThingFits ? (r.width - w * view.k) / 2 - minX * view.k : pad - minX * view.k;
  view.y = (r.height - h * view.k) / 2 - minY * view.k;
}

/**
 * Where to put the camera after the selection changes. In lens mode the drawing
 * is a different drawing now, so re-fit it; on the whole map it is the same
 * picture and only the viewpoint needs to move.
 */
function focusCamera(id: string): void {
  if (depth !== null && selected) {
    fitToContent();
    applyView();
  } else {
    centerOn(id);
  }
}

function centerOn(id: string): void {
  const p = currentLayout().placed.get(id);
  if (!p) return;
  const r = svg.getBoundingClientRect();
  // On mobile the detail sheet covers the bottom of the canvas, so centring in
  // the full rect parks the node underneath it. Centre in what's visible.
  const sheet =
    isMobile() && !rightPanel.classList.contains("hidden")
      ? rightPanel.getBoundingClientRect().height
      : 0;
  const visibleH = Math.max(140, r.height - sheet);
  view.x = r.width / 2 - (p.x + p.w / 2) * view.k;
  view.y = visibleH / 2 - (p.y + p.h / 2) * view.k;
  applyView();
}

// ---------------------------------------------------------------------- canvas input

type Drag =
  | { mode: "pan"; sx: number; sy: number; ox: number; oy: number }
  | {
      mode: "node";
      id: string;
      dx: number;
      dy: number;
      moved: boolean;
      sx: number;
      sy: number;
      /** Touch drags pan the canvas instead of pinning — see below. */
      pins: boolean;
      ox: number;
      oy: number;
      /** Graph as it stood before the drag, so the whole gesture is one undo. */
      before: string;
    }
  | { mode: "link"; id: string; x1: number; y1: number };

let drag: Drag | null = null;
/** Live pointers keyed by pointerId — two of them is a pinch, not a drag. */
const pointers = new Map<number, { x: number; y: number }>();
let pinch: { dist: number; mx: number; my: number } | null = null;
/**
 * A finger never holds perfectly still. Without a slop radius every tap on a
 * node would register as a drag. Touch needs a bigger one than a mouse.
 */
const slopFor = (type: string) => (type === "mouse" ? 6 : 14);

const clampK = (k: number) => Math.min(2.5, Math.max(0.12, k));

function beginPinch(): void {
  const [a, b] = [...pointers.values()];
  if (!a || !b) return;
  drag = null;
  svg.classList.remove("panning");
  dragEdgePath.classList.remove("on");
  pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

svg.addEventListener("pointerdown", (ev) => {
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pointers.size === 2) {
    beginPinch();
    return;
  }
  if (pointers.size > 2) return;

  const target = ev.target as Element;
  const nodeEl = target.closest<SVGGElement>(".node");
  // Throws NotFoundError if the pointer is already gone; never worth failing the
  // whole gesture over.
  try {
    svg.setPointerCapture(ev.pointerId);
  } catch {}

  if (nodeEl && target.classList.contains("handle")) {
    const id = nodeEl.dataset.id as string;
    const p = currentLayout().placed.get(id);
    if (!p) return;
    drag = { mode: "link", id, x1: p.x + p.w, y1: p.y + p.h / 2 };
    dragEdgePath.classList.add("on");
    ev.preventDefault();
    return;
  }

  if (nodeEl) {
    const id = nodeEl.dataset.id as string;
    const p = currentLayout().placed.get(id);
    const w = toWorld(ev.clientX, ev.clientY);
    if (!p) return;
    drag = {
      mode: "node",
      id,
      dx: w.x - p.x,
      dy: w.y - p.y,
      moved: false,
      sx: ev.clientX,
      sy: ev.clientY,
      // On touch there is no hover and gestures are coarse, so dragging a node
      // pans instead of pinning it. Accidental pins were the single worst
      // failure mode on the phone — four of them silently wrecked the layout.
      pins: ev.pointerType === "mouse",
      ox: view.x,
      oy: view.y,
      before: snapshot(),
    };
    ev.preventDefault();
    return;
  }

  drag = { mode: "pan", sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
  svg.classList.add("panning");
});

svg.addEventListener("pointermove", (ev) => {
  if (!pointers.has(ev.pointerId)) return;
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const r = svg.getBoundingClientRect();
    const px = pinch.mx - r.left;
    const py = pinch.my - r.top;
    const next = clampK(view.k * (dist / (pinch.dist || dist)));
    // Zoom about the previous midpoint, then follow the midpoint as it travels,
    // so a two-finger drag pans and pinches in one gesture.
    view.x = px - ((px - view.x) / view.k) * next + (mx - pinch.mx);
    view.y = py - ((py - view.y) / view.k) * next + (my - pinch.my);
    view.k = next;
    pinch = { dist, mx, my };
    applyView();
    return;
  }

  if (!drag) return;
  if (drag.mode === "pan") {
    view.x = drag.ox + (ev.clientX - drag.sx);
    view.y = drag.oy + (ev.clientY - drag.sy);
    applyView();
    return;
  }
  const w = toWorld(ev.clientX, ev.clientY);
  if (drag.mode === "link") {
    const dx = Math.max(38, Math.abs(w.x - drag.x1) * 0.45);
    dragEdgePath.setAttribute(
      "d",
      `M${drag.x1},${drag.y1} C${drag.x1 + dx},${drag.y1} ${w.x - dx},${w.y} ${w.x},${w.y}`,
    );
    return;
  }
  const slop = slopFor(ev.pointerType);
  if (!drag.moved && Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy) < slop) return;
  drag.moved = true;

  if (!drag.pins) {
    // Touch: drag the canvas under the finger rather than tearing the node out
    // of the layout.
    view.x = drag.ox + (ev.clientX - drag.sx);
    view.y = drag.oy + (ev.clientY - drag.sy);
    applyView();
    return;
  }

  // Mouse: dragging pins the node; the rest keeps auto-arranging around it.
  const n = nodeById(drag.id);
  if (!n) return;
  n.pin = { x: Math.round(w.x - drag.dx), y: Math.round(w.y - drag.dy) };
  render();
});

function endPointer(ev: PointerEvent): void {
  pointers.delete(ev.pointerId);
  try {
    if (svg.hasPointerCapture(ev.pointerId)) svg.releasePointerCapture(ev.pointerId);
  } catch {}

  if (pinch) {
    // Swallow input until every finger is up, so lifting one of two fingers
    // doesn't snap into a pan from wherever the survivor happens to be.
    if (pointers.size === 0) pinch = null;
    return;
  }
  if (!drag) return;
  const d = drag;
  drag = null;
  svg.classList.remove("panning");
  dragEdgePath.classList.remove("on");

  if (d.mode === "pan") return;

  if (d.mode === "link") {
    // Pointer capture means ev.target is the <svg>, not what's under the finger.
    const targetEl = document
      .elementFromPoint(ev.clientX, ev.clientY)
      ?.closest<SVGGElement>(".node");
    const to = targetEl?.dataset.id;
    if (!to || to === d.id) return;
    if (graph.edges.some((e) => e.from === d.id && e.to === to)) return;
    if (wouldCycle(d.id, to)) {
      setStatus(`${labelOf(to)} already leads to ${labelOf(d.id)}`, "error");
      return;
    }
    edit(() => {
      // Default to "soft" — most of what you track is preference, not a game lock.
      graph.edges.push({ from: d.id, to, type: "soft", note: "", verify: false });
      selected = to;
    });
    return;
  }

  if (!d.moved) {
    selected = selected === d.id ? null : d.id;
    render();
    // In lens mode the picture is rebuilt around whatever you just tapped, so
    // the camera has to follow or you end up looking at empty canvas. Also on
    // deselect, which expands back to the whole map.
    if (depth !== null) {
      fitToContent();
      applyView();
    }
  } else if (d.pins) {
    // The whole drag is one undo step, not one per pointermove.
    record(d.before);
    save(); // a touch drag only moved the camera — nothing to persist
  }
}

svg.addEventListener("pointerup", endPointer);
svg.addEventListener("pointercancel", endPointer);

svg.addEventListener("dblclick", (ev) => {
  const nodeEl = (ev.target as Element).closest<SVGGElement>(".node");
  if (!nodeEl) return;
  const n = nodeById(nodeEl.dataset.id as string);
  if (!n) return;
  edit(() => {
    n.done = !n.done;
  });
});

svg.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    const next = Math.min(2.5, Math.max(0.12, view.k * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
    view.x = mx - ((mx - view.x) / view.k) * next;
    view.y = my - ((my - view.y) / view.k) * next;
    view.k = next;
    applyView();
  },
  { passive: false },
);

// ---------------------------------------------------------------------- panel input

$("#search").addEventListener("input", (ev) => {
  query = (ev.target as HTMLInputElement).value.trim().toLowerCase();
  render();
});

/**
 * Searching used to dim the misses and stop there, which on a 4000px drawing
 * usually meant the one node you were looking for was off-screen — you got told
 * it exists and then had to go find it by hand. Enter walks the matches.
 */
$("#search").addEventListener("keydown", (ev) => {
  const key = (ev as KeyboardEvent).key;
  if (key === "Escape") {
    ($("#search") as HTMLInputElement).value = "";
    query = "";
    render();
    return;
  }
  if (key !== "Enter" || !query) return;
  ev.preventDefault();

  const hits = graph.nodes.filter((n) => isVisible(n) && matchesQuery(n));
  if (!hits.length) {
    setStatus(`no match for “${query}”`, "error");
    return;
  }
  // Shift+Enter goes back, so a query with several hits is walkable both ways.
  const at = hits.findIndex((n) => n.id === selected);
  const step = (ev as KeyboardEvent).shiftKey ? -1 : 1;
  const next = hits[(at + step + hits.length * 2) % hits.length] as GraphNode;
  selected = next.id;
  closeDrawer();
  render();
  focusCamera(next.id);
  if (hits.length > 1) setStatus(`${(hits.indexOf(next) + 1).toString()} of ${hits.length}`);
});

for (const list of ["#frontier", "#soon"]) {
  $(list).addEventListener("click", (ev) => {
    const li = (ev.target as Element).closest<HTMLElement>("li[data-id]");
    if (!li?.dataset.id) return;
    selected = li.dataset.id;
    // On a phone the drawer covers the canvas, so picking something is also a
    // request to go look at it.
    closeDrawer();
    render();
    focusCamera(selected);
  });
}

$("#menu").addEventListener("click", () => document.body.classList.toggle("drawer-open"));
$("#scrim").addEventListener("click", closeDrawer);
$("#fit").addEventListener("click", () => {
  closeDrawer();
  fitToContent();
  applyView();
});

$("#lanes").addEventListener("click", (ev) => {
  const lane = (ev.target as HTMLElement).dataset.lane as Lane | undefined;
  if (!lane) return;
  if (hidden.has(lane)) hidden.delete(lane);
  else hidden.add(lane);
  render();
});

$("#add-node").addEventListener("click", () => {
  const node: GraphNode = {
    id: provisionalId(),
    label: "New node",
    kind: "activity",
    lane: "pvm",
    done: false,
    note: "",
    wiki: "",
    verify: false,
    // Deliberately unpinned. Dropping it at the viewport centre pinned it out of
    // the auto-layout on creation — the exact failure mode pinning is warned
    // about everywhere else — so it lands in the layout like everything else and
    // the camera goes to it instead.
    pin: null,
  };
  edit(() => {
    graph.nodes.push(node);
    selected = node.id;
  });
  focusCamera(node.id);
  rightPanel.querySelector<HTMLInputElement>("#e-label")?.select();
});

$("#relayout").addEventListener("click", () => {
  edit(() => {
    for (const n of graph.nodes) n.pin = null;
  });
  fitToContent();
  applyView();
});

$<HTMLInputElement>("#group-lanes").addEventListener("change", (ev) => {
  groupLanes = (ev.target as HTMLInputElement).checked;
  render();
});

$<HTMLInputElement>("#hide-done").addEventListener("change", (ev) => {
  hideDone = (ev.target as HTMLInputElement).checked;
  render();
});

$("#depth").addEventListener("click", (ev) => {
  const raw = (ev.target as HTMLElement).dataset.depth;
  if (raw === undefined) return;
  depth = raw === "" ? null : Number(raw);
  closeDrawer();
  render();
  // The drawing is a different size now, so the old camera means nothing.
  fitToContent();
  applyView();
});

function renderDepth(): void {
  for (const b of $("#depth").querySelectorAll<HTMLElement>("button")) {
    const value = b.dataset.depth === "" ? null : Number(b.dataset.depth);
    b.classList.toggle("on", value === depth);
  }
}

window.addEventListener("keydown", (ev) => {
  // Undo is bound before the text-field bail-out so that ctrl+Z in the label
  // box still undoes the graph rather than only the input's own edit history —
  // which would otherwise silently diverge from what you can see.
  const accel = ev.metaKey || ev.ctrlKey;
  if (accel && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
    return;
  }
  if (accel && ev.key.toLowerCase() === "y") {
    ev.preventDefault();
    redo();
    return;
  }

  const tag = (ev.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  if (ev.key === "Escape") {
    selected = null;
    focus = null;
    render();
  }
  if (ev.key === " " && selected) {
    ev.preventDefault();
    const n = nodeById(selected);
    if (n)
      edit(() => {
        n.done = !n.done;
      });
  }
  if (ev.key === "f" && selected) {
    focus = focus === selected ? null : selected;
    render();
  }
  if (ev.key === "/") {
    ev.preventDefault();
    $<HTMLInputElement>("#search").focus();
  }
});

/** Flush the server's debounced commit rather than losing it to a closed tab. */
window.addEventListener("beforeunload", () => {
  navigator.sendBeacon("/api/commit");
});

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

await load();
