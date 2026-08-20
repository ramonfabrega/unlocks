import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * The static build: the same UI, with no server behind it.
 *
 * There is no build flag distinguishing it. The client asks at startup whether
 * /api/graph answers, and falls back to localStorage when nothing does — so this
 * output is the ordinary app, and `bun run graph` serves the ordinary app too.
 * One artefact, one code path, and no way to ship a bundle wired to the wrong
 * storage because a flag was forgotten.
 */
const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist");

await rm(OUT, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(ROOT, "web", "index.html")],
  outdir: OUT,
  minify: true,
  // Relative, so the bundle works from a subdirectory of a CDN as happily as
  // from a domain root — or straight off the filesystem.
  publicPath: "./",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

let total = 0;
console.log("");
for (const out of result.outputs) {
  const size = out.size ?? (await Bun.file(out.path).arrayBuffer()).byteLength;
  total += size;
  console.log(`  ${(size / 1024).toFixed(1).padStart(7)} KB  ${out.path.slice(OUT.length + 1)}`);
}
console.log(`  ${(total / 1024).toFixed(1).padStart(7)} KB  total\n`);
console.log(`  ${OUT}\n`);
console.log("  Serve that directory anywhere. With no /api/graph behind it the");
console.log("  graph lives in localStorage, and export is the way out.\n");
