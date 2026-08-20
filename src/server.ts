import { join } from "node:path";
import index from "../web/index.html";
import { commitMessage, describe } from "./log.ts";
import { Graph, validateGraph } from "./schema.ts";

const ROOT = join(import.meta.dir, "..");
const FILE = join(ROOT, "graph.json");
const PORT = Number(process.env.PORT ?? 5173);
/**
 * Every interface by default, because using this on a phone means reaching it
 * over the LAN. That is a real, if small, exposure: there is no auth, so anyone
 * on the same network can PUT the graph. `HOST=127.0.0.1` closes it when you are
 * only ever on the laptop, and the banner says which one you got.
 */
const HOST = process.env.HOST ?? "0.0.0.0";
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

    const message = commitMessage(lines);
    await Bun.$`git add graph.json`.cwd(ROOT).quiet();
    await Bun.$`git commit -m ${message}`.cwd(ROOT).quiet();
    console.log(`  committed: ${lines[0] ?? "update graph"}`);
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
  hostname: HOST,
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
console.log(
  `         ${HOST === "0.0.0.0" ? "reachable on your LAN, no auth (HOST=127.0.0.1 to close)" : `bound to ${HOST}`}`,
);
console.log(`\n  ->  ${server.url}\n`);
