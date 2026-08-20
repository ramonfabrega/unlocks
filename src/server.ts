import { basename, dirname, join, resolve } from "node:path";
import index from "../web/index.html";
import { commitMessage, describe } from "./log.ts";
import { Graph, validateGraph } from "./schema.ts";

const ROOT = join(import.meta.dir, "..");

/**
 * Where the account lives. It defaults to graph.json beside the tool, which is
 * how this started and how it stays for whoever wrote it — but the point of the
 * env var is that your progression and this tool's source do not have to be the
 * same git history.
 *
 * They shouldn't be. Every save commits, so a fork that keeps its graph in the
 * tool repo can never pull an improvement without resolving a conflict against
 * its own account. Point UNLOCKS_FILE at a file in a repo of your own and the
 * two histories stop touching: commits land next to the graph, not next to the
 * source.
 */
const FILE = resolve(process.env.UNLOCKS_FILE ?? join(ROOT, "graph.json"));
/** Git runs where the graph lives, which may be another repo entirely. */
const DATA_DIR = dirname(FILE);
const NAME = basename(FILE);
const SEED = join(ROOT, "example.json");
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

/** A pointed-at file that isn't there yet is a first run, not a mistake. */
async function bootstrap(): Promise<void> {
  if (await Bun.file(FILE).exists()) return;
  const seed = await Bun.file(SEED).text();
  await Bun.write(FILE, seed);
  console.log(`unlocks  ${FILE} did not exist — started you off from example.json\n`);
}

async function read(): Promise<Graph> {
  const raw = await Bun.file(FILE).json();
  const parsed = Graph.parse(raw);
  const errors = validateGraph(parsed);
  if (errors.length) throw new Error(`${NAME} is not a valid DAG:\n  ${errors.join("\n  ")}`);
  return parsed;
}

await bootstrap();
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
    const inRepo = await Bun.$`git rev-parse --is-inside-work-tree`.cwd(DATA_DIR).quiet().nothrow();
    if (inRepo.exitCode !== 0) return;
    const dirty = await Bun.$`git status --porcelain -- ${NAME}`.cwd(DATA_DIR).quiet().nothrow();
    if (!dirty.stdout.toString().trim()) return;

    let lines: string[] = [];
    // `HEAD:./name` resolves relative to cwd, so this keeps working when the
    // graph sits in a subdirectory of its repo rather than at the root.
    const head = await Bun.$`git show ${`HEAD:./${NAME}`}`.cwd(DATA_DIR).quiet().nothrow();
    if (head.exitCode === 0) {
      const parsed = Graph.safeParse(JSON.parse(head.stdout.toString()));
      if (parsed.success) lines = describe(parsed.data, graph);
    }

    const message = commitMessage(lines);
    await Bun.$`git add ${NAME}`.cwd(DATA_DIR).quiet();
    await Bun.$`git commit -m ${message}`.cwd(DATA_DIR).quiet();
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
