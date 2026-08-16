import { join } from "node:path";
import index from "../web/index.html";
import { Graph, validateGraph } from "./schema.ts";

const ROOT = join(import.meta.dir, "..");
const FILE = join(ROOT, "graph.json");
const PORT = Number(process.env.PORT ?? 5173);
const GIT = process.env.UNLOCKS_NO_GIT !== "1";
/** Coalesce a flurry of clicks into one commit rather than one per tick. */
const COMMIT_DEBOUNCE_MS = 15_000;

async function read(): Promise<Graph> {
  const raw = await Bun.file(FILE).json();
  const parsed = Graph.parse(raw);
  const errors = validateGraph(parsed);
  if (errors.length) throw new Error(`graph.json is not a valid DAG:\n  ${errors.join("\n  ")}`);
  return parsed;
}

let graph = await read();

/**
 * Human-readable commit messages, built by diffing what actually changed.
 * The point of putting graph.json in git is that `git log` becomes a
 * progression log — "3 nodes done: cg, bowfa, muspah" is worth reading back in
 * six months; "update graph.json" is not.
 */
function describe(before: Graph, after: Graph): string[] {
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
  if (added.length) lines.push(`+${added.length} node${added.length > 1 ? "s" : ""}: ${added.join(", ")}`);
  if (removed.length) lines.push(`-${removed.length} node${removed.length > 1 ? "s" : ""}: ${removed.join(", ")}`);

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

let commitTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The message is derived at commit time by diffing the committed graph against
 * the current one — never accumulated per-request. Within one debounce window
 * you can tick a node and untick it again, and a running tally would describe
 * changes that are no longer in the tree.
 */
async function commit(): Promise<void> {
  commitTimer = null;
  if (!GIT) return;
  try {
    const inRepo = await Bun.$`git rev-parse --is-inside-work-tree`.cwd(ROOT).quiet().nothrow();
    if (inRepo.exitCode !== 0) return;
    const dirty = await Bun.$`git status --porcelain -- graph.json`.cwd(ROOT).quiet().nothrow();
    if (!dirty.stdout.toString().trim()) return;

    let lines: string[] = [];
    const head = await Bun.$`git show HEAD:graph.json`.cwd(ROOT).quiet().nothrow();
    if (head.exitCode === 0) {
      const parsed = Graph.safeParse(JSON.parse(head.stdout.toString()));
      if (parsed.success) lines = describe(parsed.data, graph);
    }

    const subject = lines[0] ?? "update graph";
    const body = lines.slice(1).join("\n");
    const message = body ? `${subject}\n\n${body}` : subject;
    await Bun.$`git add graph.json`.cwd(ROOT).quiet();
    await Bun.$`git commit -m ${message}`.cwd(ROOT).quiet();
    console.log(`  committed: ${subject}`);
  } catch (err) {
    // Never let a git problem cost you an edit — the file is already written.
    console.warn(`  git commit skipped: ${err instanceof Error ? err.message : err}`);
  }
}

function scheduleCommit(): void {
  if (!GIT) return;
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => void commit(), COMMIT_DEBOUNCE_MS);
}

const server = Bun.serve({
  port: PORT,
  // Off by default: Bun's dev overlay covers the app whenever a browser
  // extension throws on the page, which has nothing to do with this code.
  // `bun run dev` turns it back on when you're actually editing source.
  development: process.env.UNLOCKS_DEV === "1",
  routes: {
    "/": index,

    "/api/graph": {
      GET: () => Response.json(graph),

      PUT: async (req) => {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "body is not JSON" }, { status: 400 });
        }

        const parsed = Graph.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "schema", detail: z_issues(parsed.error) },
            { status: 400 },
          );
        }
        const errors = validateGraph(parsed.data);
        if (errors.length) return Response.json({ error: errors.join("; ") }, { status: 400 });

        graph = parsed.data;
        await Bun.write(FILE, `${JSON.stringify(graph, null, 2)}\n`);
        scheduleCommit();
        return Response.json({ ok: true });
      },
    },

    /** Flush the debounce now — the UI calls this on tab close. */
    "/api/commit": {
      POST: async () => {
        if (commitTimer) clearTimeout(commitTimer);
        await commit();
        return Response.json({ ok: true });
      },
    },
  },

  error: (err) => Response.json({ error: err.message }, { status: 500 }),
});

function z_issues(err: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return err.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (commitTimer) clearTimeout(commitTimer);
    void commit().finally(() => process.exit(0));
  });
}

console.log(`unlocks  ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
console.log(`         ${FILE}`);
console.log(`         git auto-commit ${GIT ? "on" : "off (UNLOCKS_NO_GIT=1)"}`);
console.log(`\n  ->  ${server.url}\n`);
