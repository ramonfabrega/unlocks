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
console.log(`  ${(total / 1024).toFixed(1).padStart(7)} KB  total`);

/**
 * And the same thing again as one file.
 *
 * Sending someone a directory of hash-named assets means sending them a web
 * server too. Inlined, it is a single link, or an attachment, or a thing you
 * double-click out of your downloads folder — and there are no asset paths left
 * to break when it is served from some nested prefix.
 */
const single = join(OUT, "unlocks.html");
let html = await Bun.file(join(OUT, "index.html")).text();

for (const out of result.outputs) {
  const name = out.path.slice(OUT.length + 1);
  if (name.endsWith(".css")) {
    const css = await Bun.file(out.path).text();
    html = html.replace(
      new RegExp(`<link[^>]*href="\\./${name}"[^>]*>`),
      `<style>\n${css}\n</style>`,
    );
  } else if (name.endsWith(".js")) {
    const js = await Bun.file(out.path).text();
    // A literal </script> anywhere in the source would close the tag early.
    html = html.replace(
      new RegExp(`<script[^>]*src="\\./${name}"[^>]*>\\s*</script>`),
      `<script type="module">\n${js.replaceAll("</script", "<\\/script")}\n</script>`,
    );
  }
}

if (html.includes("./chunk-")) {
  console.error("\n  single-file build still references a chunk — inlining missed something\n");
  process.exit(1);
}
await Bun.write(single, html);
console.log(
  `  ${(Buffer.byteLength(html) / 1024).toFixed(1).padStart(7)} KB  unlocks.html (self-contained)\n`,
);

console.log(`  ${OUT}\n`);
console.log("  Serve the directory anywhere, or hand someone unlocks.html on its own.");
console.log("  With no /api/graph behind it the graph lives in localStorage,");
console.log("  and export is the way out.\n");
