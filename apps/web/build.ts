// Bundle apps/web to dist/ — runnable from repo root: node apps/web/build.ts
import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [join(here, "src/main.tsx")],
  bundle: true,
  format: "esm",
  splitting: true,
  jsx: "automatic",
  sourcemap: true,
  minify: true,
  outdir: dist,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
await copyFile(join(here, "src/index.html"), join(dist, "index.html"));
// F18: the service worker must live at the origin root (its own scope), so it
// is copied verbatim instead of being bundled.
await copyFile(join(here, "sw.js"), join(dist, "sw.js"));