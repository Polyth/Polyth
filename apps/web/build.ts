// Bundle apps/web to dist/ — runnable from repo root: node apps/web/build.ts
import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scaleUiFontSizes } from "./fontScaleCss.ts";
import { discoverWebPackages } from "./webPackages.ts";

const here = import.meta.dirname;
const dist = join(here, "dist");
const projectIcons = join(here, "src", "assets", "project-icons");

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

const uiFontScalePlugin = {
  name: "ui-font-scale",
  setup(buildApi: { onLoad(options: { filter: RegExp }, callback: (args: { path: string }) => Promise<{ contents: string; loader: "css" }>): void }) {
    buildApi.onLoad({ filter: /styles\.css$/ }, async (args) => ({
      contents: scaleUiFontSizes(await readFile(args.path, "utf8")),
      loader: "css",
    }));
  },
};

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
  plugins: [uiFontScalePlugin],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
const webPackages = await discoverWebPackages(join(here, "..", "..", "packages"));
const webPackageManifest: Array<{
  id: string;
  module: string;
  styles: string[];
}> = [];
for (const pkg of webPackages) {
  const outdir = join(dist, "web-packages", pkg.id);
  await build({
    entryPoints: [pkg.entryFile],
    bundle: true,
    platform: "browser",
    format: "esm",
    splitting: true,
    jsx: "automatic",
    external: reactExternals,
    sourcemap: true,
    minify: true,
    outdir,
    entryNames: "entry",
    chunkNames: "chunks/[name]-[hash]",
    assetNames: "assets/[name]-[hash]",
    loader: { ".css": "css" },
    plugins: [uiFontScalePlugin],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "info",
  });
  const outputs = await readdir(outdir);
  webPackageManifest.push({
    id: pkg.id,
    module: `/web-packages/${pkg.id}/entry.js`,
    styles: outputs
      .filter((name) => name.endsWith(".css"))
      .sort()
      .map((name) => `/web-packages/${pkg.id}/${name}`),
  });
}
await mkdir(join(dist, "web-packages"), { recursive: true });
await writeFile(
  join(dist, "web-packages", "manifest.json"),
  JSON.stringify({ packages: webPackageManifest }),
);
await copyFile(join(here, "src/index.html"), join(dist, "index.html"));
const projectIconNames = (await readdir(projectIcons))
  .filter((name) => name.endsWith(".svg"))
  .sort();
await cp(projectIcons, join(dist, "assets", "project-icons"), { recursive: true });
await writeFile(join(dist, "project-icons.json"), JSON.stringify(projectIconNames));
// PWA files live at the origin root and are copied verbatim instead of bundled.
await Promise.all([
  copyFile(join(here, "sw.js"), join(dist, "sw.js")),
  copyFile(join(here, "manifest.json"), join(dist, "manifest.json")),
  copyFile(join(here, "icon-192.png"), join(dist, "icon-192.png")),
  copyFile(join(here, "icon-512.png"), join(dist, "icon-512.png")),
]);
