// Bundle apps/web to dist/ — runnable from repo root: node apps/web/build.ts
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dirname;

await mkdir(join(here, "dist"), { recursive: true });
await build({
  entryPoints: [join(here, "src/main.tsx")],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  sourcemap: true,
  minify: true,
  outfile: join(here, "dist/bundle.js"),
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
await copyFile(join(here, "src/index.html"), join(here, "dist/index.html"));
// F18: the service worker must live at the origin root (its own scope), so it
// is copied verbatim instead of being bundled.
await copyFile(join(here, "sw.js"), join(here, "dist/sw.js"));