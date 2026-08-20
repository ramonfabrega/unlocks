import type { Graph } from "./schema.ts";

/**
 * Human-readable commit messages, built by diffing what actually changed.
 * The point of putting graph.json in git is that `git log` becomes a
 * progression log — "3 nodes done: cg, bowfa, muspah" is worth reading back in
 * six months; "update graph.json" is not.
 *
 * Lives apart from server.ts so it can be tested without standing a server up:
 * this is the one piece of the tool whose output is meant to be read by a human
 * years later, and it was the only piece with no tests at all.
 */
export function describe(before: Graph, after: Graph): string[] {
  const lines: string[] = [];
  const wasDone = new Map(before.nodes.map((n) => [n.id, n.done]));
  const label = new Map(after.nodes.map((n) => [n.id, n.label]));

  const done: string[] = [];
  const undone: string[] = [];
  for (const n of after.nodes) {
    const prev = wasDone.get(n.id);
    if (prev === undefined || prev === n.done) continue;
    (n.done ? done : undone).push(n.label);
  }
  if (done.length) lines.push(`done: ${done.join(", ")}`);
  if (undone.length) lines.push(`un-done: ${undone.join(", ")}`);

  const beforeIds = new Set(before.nodes.map((n) => n.id));
  const added = after.nodes.filter((n) => !beforeIds.has(n.id)).map((n) => n.label);
  const afterIds = new Set(after.nodes.map((n) => n.id));
  const removed = before.nodes.filter((n) => !afterIds.has(n.id)).map((n) => n.label);
  if (added.length)
    lines.push(`+${added.length} node${added.length > 1 ? "s" : ""}: ${added.join(", ")}`);
  if (removed.length)
    lines.push(`-${removed.length} node${removed.length > 1 ? "s" : ""}: ${removed.join(", ")}`);

  const key = (e: { from: string; to: string }) => `${e.from}->${e.to}`;
  const beforeEdges = new Map(before.edges.map((e) => [key(e), e.type]));
  const afterEdges = new Map(after.edges.map((e) => [key(e), e.type]));
  const name = (id: string) => label.get(id) ?? id;
  const edgeAdds: string[] = [];
  for (const [k, type] of afterEdges) {
    const prev = beforeEdges.get(k);
    const [from = "", to = ""] = k.split("->");
    if (prev === undefined) edgeAdds.push(`${name(from)} ${type} ${name(to)}`);
    else if (prev !== type) edgeAdds.push(`${name(from)} ${prev}->${type} ${name(to)}`);
  }
  const edgeDrops = [...beforeEdges.keys()].filter((k) => !afterEdges.has(k)).length;
  if (edgeAdds.length) lines.push(`edges: ${edgeAdds.join("; ")}`);
  if (edgeDrops) lines.push(`removed ${edgeDrops} edge${edgeDrops > 1 ? "s" : ""}`);

  return lines;
}

/** Subject line plus body, the shape git wants. */
export function commitMessage(lines: string[]): string {
  const subject = lines[0] ?? "update graph";
  const body = lines.slice(1).join("\n");
  return body ? `${subject}\n\n${body}` : subject;
}
