import {
  adjacency,
  ancestors,
  descendants,
  fitLabel,
  layout,
  leverage,
  NODE_H,
  statuses,
  type Placed,
  type Status,
} from "../src/derive.ts";
import type { EdgeType, Graph, GraphEdge, GraphNode, Lane, NodeKind } from "../src/schema.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const LANES: Lane[] = ["quest", "pvm", "raid", "slayer", "skilling"];
const KINDS: NodeKind[] = ["activity", "item", "milestone"];
const EDGE_TYPES: EdgeType[] = ["grants", "hard", "soft"];
const KIND_TAG: Record<NodeKind, string> = { activity: "", item: "item", milestone: "lvl" };

// ---------------------------------------------------------------------- state

let graph: Graph = { version: 1, nodes: [], edges: [] };
let selected: string | null = null;
const hidden = new Set<Lane>();
let query = "";
let groupLanes = false;
/** When set, everything outside this node's ancestry is dimmed. */
let focus: string | null = null;
const view = { x: 60, y: 40, k: 0.9 };

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const svg = $<SVGSVGElement>("#canvas");
const gViewport = $<SVGGElement>("#viewport");
const gNodes = $<SVGGElement>("#nodes");
const gEdges = $<SVGGElement>("#edges");
const dragEdgePath = $<SVGPathElement>("#drag-edge");
const saveState = $("#save-state");
const rightPanel = $("#right");

// ---------------------------------------------------------------------- io

async function load(): Promise<void> {
  const res = await fetch("/api/graph");
  graph = await res.json();
  fitToContent();
  render();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

function save(): void {
  saveState.textContent = "saving…";
  saveState.className = "save dirty";
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (inFlight) {
      save();
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
        saveState.textContent = `rejected: ${body.error ?? res.status}`;
        saveState.className = "save error";
        return;
      }
      saveState.textContent = "saved";
      saveState.className = "save";
    } catch (err) {
      saveState.textContent = "offline — server down?";
      saveState.className = "save error";
      console.error(err);
    } finally {
      inFlight = false;
    }
  }, 450);
}

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

/** A -> B closes a loop exactly when A is already downstream of B. */
function wouldCycle(from: string, to: string): boolean {
  if (from === to) return true;
  return descendants(to, adjacency(graph)).has(from);
}

const matchesQuery = (n: GraphNode): boolean =>
  !query || n.label.toLowerCase().includes(query) || n.id.includes(query);

// ---------------------------------------------------------------------- render

function render(): void {
  const adj = adjacency(graph);
  const status = statuses(graph, adj);
  const lev = leverage(graph, adj);
  const placed = layout(graph, { groupLanes });

  const litNodes = focus ? new Set([focus, ...ancestors(focus, adj)]) : null;

  renderEdges(placed, litNodes);
  renderNodes(placed, status, litNodes);
  renderFrontier(status, lev, adj);
  renderLaneChips();
  renderStats(status);
  renderEditor(adj, status, lev);
  applyView();
}

function renderEdges(placed: Map<string, Placed>, lit: Set<string> | null): void {
  const parts: string[] = [];
  for (const e of graph.edges) {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b) continue;
    const visible =
      !hidden.has(nodeById(e.from)?.lane as Lane) && !hidden.has(nodeById(e.to)?.lane as Lane);
    if (!visible) continue;

    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const dx = Math.max(38, Math.abs(x2 - x1) * 0.45);
    const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;

    const onPath = lit ? lit.has(e.from) && lit.has(e.to) : false;
    const cls = lit ? (onPath ? `edge ${e.type} lit` : `edge ${e.type} dim`) : `edge ${e.type}`;
    parts.push(`<path class="${cls}" d="${d}"></path>`);
  }
  gEdges.innerHTML = parts.join("");
}

function renderNodes(
  placed: Map<string, Placed>,
  status: Map<string, Status>,
  lit: Set<string> | null,
): void {
  const parts: string[] = [];
  for (const n of graph.nodes) {
    const p = placed.get(n.id);
    if (!p || hidden.has(n.lane)) continue;

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
        `<circle class="handle" cx="${p.x + p.w}" cy="${cy}" r="5"></circle>` +
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
  $("#stats").textContent =
    `${graph.nodes.length} nodes · ${counts.done} done · ${counts.locked} locked` +
    (unverified ? ` · ${unverified} to verify` : "");
}

// ---------------------------------------------------------------------- editor

function renderEditor(
  adj: ReturnType<typeof adjacency>,
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
    `<span class="save"><span class="dot ${st}"></span> ${st}</span></header>` +
    (n.verify
      ? `<div class="warn">Unverified game fact — I seeded this from memory. ` +
        `Check it, then clear the flag.${n.note ? `<br><br>${esc(n.note)}` : ""}</div>`
      : "") +
    `<div class="row">` +
    `<button id="e-done" type="button" class="${n.done ? "" : "primary"}">` +
    `${n.done ? "mark not done" : "mark done"}</button>` +
    `<button id="e-focus" type="button">${focus === n.id ? "clear path" : "show path"}</button>` +
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
    el?.addEventListener(ev, () => {
      fn(el.value);
      save();
      render();
    });
  };

  onEdit("#e-label", "change", (v) => {
    n.label = v.trim() || n.label;
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

  click("#e-done", () => {
    n.done = !n.done;
    save();
    render();
  });
  click("#e-focus", () => {
    focus = focus === n.id ? null : n.id;
    render();
  });
  click("#e-verified", () => {
    n.verify = false;
    save();
    render();
  });
  click("#e-unpin", () => {
    n.pin = null;
    save();
    render();
  });
  click("#e-wikiopen", () => window.open(n.wiki, "_blank", "noopener"));
  click("#e-delete", () => {
    graph.nodes = graph.nodes.filter((x) => x.id !== n.id);
    graph.edges = graph.edges.filter((e) => e.from !== n.id && e.to !== n.id);
    if (focus === n.id) focus = null;
    selected = null;
    save();
    render();
  });

  for (const dep of rightPanel.querySelectorAll<HTMLElement>(".dep")) {
    const from = dep.dataset.from ?? "";
    const to = dep.dataset.to ?? "";
    const edge = graph.edges.find((e) => e.from === from && e.to === to);
    dep.querySelector(".name")?.addEventListener("click", () => {
      selected = dep.querySelector<HTMLElement>(".name")?.dataset.goto ?? null;
      render();
    });
    dep.querySelector<HTMLSelectElement>(".etype")?.addEventListener("change", (ev) => {
      if (edge) edge.type = (ev.target as HTMLSelectElement).value as EdgeType;
      save();
      render();
    });
    dep.querySelector(".x")?.addEventListener("click", () => {
      graph.edges = graph.edges.filter((e) => !(e.from === from && e.to === to));
      save();
      render();
    });
  }
}

// ---------------------------------------------------------------------- view

function applyView(): void {
  gViewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);
}

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const r = svg.getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
}

function fitToContent(): void {
  const placed = layout(graph, { groupLanes });
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
  // Deliberately NOT fit-to-everything: a 10-layer DAG squeezed into one screen
  // is unreadable. Start at a zoom where labels are legible, pinned to the roots
  // on the left, and let the user pan rightward through the progression.
  const fit = Math.min((r.height - pad * 2) / (maxY - minY), 1);
  view.k = Math.min(1, Math.max(0.55, fit));
  view.x = pad - minX * view.k;
  view.y = (r.height - (maxY - minY) * view.k) / 2 - minY * view.k;
}

function centerOn(id: string): void {
  const p = layout(graph, { groupLanes }).get(id);
  if (!p) return;
  const r = svg.getBoundingClientRect();
  view.x = r.width / 2 - (p.x + p.w / 2) * view.k;
  view.y = r.height / 2 - (p.y + p.h / 2) * view.k;
  applyView();
}

// ---------------------------------------------------------------------- canvas input

type Drag =
  | { mode: "pan"; sx: number; sy: number; ox: number; oy: number }
  | { mode: "node"; id: string; dx: number; dy: number; moved: boolean }
  | { mode: "link"; id: string; x1: number; y1: number };

let drag: Drag | null = null;

svg.addEventListener("mousedown", (ev) => {
  const target = ev.target as Element;
  const nodeEl = target.closest<SVGGElement>(".node");

  if (nodeEl && target.classList.contains("handle")) {
    const id = nodeEl.dataset.id as string;
    const p = layout(graph, { groupLanes }).get(id);
    if (!p) return;
    drag = { mode: "link", id, x1: p.x + p.w, y1: p.y + p.h / 2 };
    dragEdgePath.classList.add("on");
    ev.preventDefault();
    return;
  }

  if (nodeEl) {
    const id = nodeEl.dataset.id as string;
    const p = layout(graph, { groupLanes }).get(id);
    const w = toWorld(ev.clientX, ev.clientY);
    if (!p) return;
    drag = { mode: "node", id, dx: w.x - p.x, dy: w.y - p.y, moved: false };
    ev.preventDefault();
    return;
  }

  drag = { mode: "pan", sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y };
  svg.classList.add("panning");
});

window.addEventListener("mousemove", (ev) => {
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
  // Dragging a node pins it; the rest of the graph keeps auto-arranging.
  const n = nodeById(drag.id);
  if (!n) return;
  drag.moved = true;
  n.pin = { x: Math.round(w.x - drag.dx), y: Math.round(w.y - drag.dy) };
  render();
});

window.addEventListener("mouseup", (ev) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  svg.classList.remove("panning");
  dragEdgePath.classList.remove("on");

  if (d.mode === "pan") return;

  if (d.mode === "link") {
    const targetEl = (ev.target as Element).closest<SVGGElement>(".node");
    const to = targetEl?.dataset.id;
    if (!to || to === d.id) return;
    if (graph.edges.some((e) => e.from === d.id && e.to === to)) return;
    if (wouldCycle(d.id, to)) {
      saveState.textContent = `${labelOf(to)} already leads to ${labelOf(d.id)}`;
      saveState.className = "save error";
      return;
    }
    // Default to "soft" — most of what you track is preference, not a game lock.
    graph.edges.push({ from: d.id, to, type: "soft", note: "", verify: false });
    selected = to;
    save();
    render();
    return;
  }

  if (!d.moved) {
    selected = selected === d.id ? null : d.id;
    render();
  } else {
    save();
  }
});

svg.addEventListener("dblclick", (ev) => {
  const nodeEl = (ev.target as Element).closest<SVGGElement>(".node");
  if (!nodeEl) return;
  const n = nodeById(nodeEl.dataset.id as string);
  if (!n) return;
  n.done = !n.done;
  save();
  render();
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

for (const list of ["#frontier", "#soon"]) {
  $(list).addEventListener("click", (ev) => {
    const li = (ev.target as Element).closest<HTMLElement>("li[data-id]");
    if (!li?.dataset.id) return;
    selected = li.dataset.id;
    render();
    centerOn(selected);
  });
}

$("#lanes").addEventListener("click", (ev) => {
  const lane = (ev.target as HTMLElement).dataset.lane as Lane | undefined;
  if (!lane) return;
  if (hidden.has(lane)) hidden.delete(lane);
  else hidden.add(lane);
  render();
});

$("#add-node").addEventListener("click", () => {
  const r = svg.getBoundingClientRect();
  const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
  const node: GraphNode = {
    id: slug("new node"),
    label: "New node",
    kind: "activity",
    lane: "pvm",
    done: false,
    note: "",
    wiki: "",
    verify: false,
    pin: { x: Math.round(c.x), y: Math.round(c.y - NODE_H / 2) },
  };
  graph.nodes.push(node);
  selected = node.id;
  save();
  render();
  rightPanel.querySelector<HTMLInputElement>("#e-label")?.select();
});

$("#relayout").addEventListener("click", () => {
  for (const n of graph.nodes) n.pin = null;
  save();
  fitToContent();
  render();
});

$<HTMLInputElement>("#group-lanes").addEventListener("change", (ev) => {
  groupLanes = (ev.target as HTMLInputElement).checked;
  render();
});

window.addEventListener("keydown", (ev) => {
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
    if (n) {
      n.done = !n.done;
      save();
      render();
    }
  }
  if (ev.key === "f" && selected) {
    focus = focus === selected ? null : selected;
    render();
  }
});

/** Flush the server's debounced commit rather than losing it to a closed tab. */
window.addEventListener("beforeunload", () => {
  navigator.sendBeacon("/api/commit");
});

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

await load();
