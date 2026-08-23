// Bundle apps/web to dist/ — runnable from repo root: node apps/web/build.ts
import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const shared = join(dist, "shared");
const reactExternals = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
];

// Plugin bundles leave React external. These entries are built together with
// splitting so the shell and every hot-loaded plugin resolve one React graph.
await build({
  entryPoints: {
    react: join(here, "src/shared/react.ts"),
    "react-dom": join(here, "src/shared/react-dom.ts"),
    "react-dom-client": join(here, "src/shared/react-dom-client.ts"),
    "react-jsx-runtime": join(here, "src/shared/react-jsx-runtime.ts"),
    "react-jsx-dev-runtime": join(here, "src/shared/react-jsx-dev-runtime.ts"),
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  splitting: true,
  sourcemap: true,
  minify: true,
  outdir: shared,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
await build({
  entryPoints: [join(here, "src/main.tsx")],
  bundle: true,
  platform: "browser",
  format: "esm",
  splitting: true,
  jsx: "automatic",
  external: reactExternals,
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
// PWA files live at the origin root and are copied verbatim instead of bundled.
await Promise.all([
  copyFile(join(here, "sw.js"), join(dist, "sw.js")),
  copyFile(join(here, "manifest.json"), join(dist, "manifest.json")),
  copyFile(join(here, "icon-192.png"), join(dist, "icon-192.png")),
  copyFile(join(here, "icon-512.png"), join(dist, "icon-512.png")),
]);