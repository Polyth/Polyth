// Bundle apps/web to dist/ — runnable from repo root: node apps/web/build.ts
import { build, type Metafile } from "esbuild";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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
const sharedResult = await build({
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
  // Escaped \uXXXX sequences bloat non-ASCII strings 6x; every response is
  // served as UTF-8 anyway.
  charset: "utf8",
  metafile: true,
  outdir: shared,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
const webPackages = await discoverWebPackages(join(here, "..", "..", "packages"));
const browserEntries: Record<string, string> = {
  main: join(here, "src/main.tsx"),
};
for (const pkg of webPackages) {
  browserEntries[`web-packages/${pkg.id}/entry`] = pkg.entryFile;
}

// Build the shell and package entries as one split graph. Feature components
// still consume generic shell seams such as the store and i18n; a shared graph
// guarantees those stateful modules are singletons instead of silently
// cloning them once per dynamically loaded package.
const appResult = await build({
  entryPoints: browserEntries,
  bundle: true,
  platform: "browser",
  format: "esm",
  splitting: true,
  jsx: "automatic",
  external: reactExternals,
  sourcemap: true,
  minify: true,
  charset: "utf8",
  metafile: true,
  outdir: dist,
  entryNames: "[dir]/[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  loader: { ".css": "css" },
  plugins: [uiFontScalePlugin],
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
const webPackageManifest: Array<{
  id: string;
  module: string;
  styles: string[];
}> = [];
for (const pkg of webPackages) {
  const outdir = join(dist, "web-packages", pkg.id);
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
// ---- modulepreload injection --------------------------------------------
// Cold boot is a 3-level module waterfall (main.js → chunks → bootstrap
// dynamic chunk → its chunks) plus the importmap-ed React entries. Preload
// links let the browser fetch every level in parallel with the first one.
const outUrl = (outPath: string): string =>
  "/" + relative(dist, resolve(outPath)).split("\\").join("/");

/** Transitive static-import closure over metafile outputs (skips externals). */
const staticClosure = (metafile: Metafile, roots: string[]): string[] => {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur) || !metafile.outputs[cur]) continue;
    seen.add(cur);
    for (const imp of metafile.outputs[cur]!.imports) {
      if (imp.kind === "import-statement" && !imp.external) queue.push(imp.path);
    }
  }
  return [...seen];
};

const findOutput = (metafile: Metafile, predicate: (outPath: string, out: Metafile["outputs"][string]) => boolean): string | null => {
  for (const [outPath, out] of Object.entries(metafile.outputs)) {
    if (outPath.endsWith(".js") && predicate(outPath, out)) return outPath;
  }
  return null;
};

const mainOut = findOutput(appResult.metafile, (_p, out) => (out.entryPoint ?? "").endsWith("src/main.tsx"));
// The bootstrap chunk is the dynamic-import target rooted at src/bootstrap.tsx.
const bootstrapOut = findOutput(appResult.metafile, (_p, out) =>
  Object.keys(out.inputs).some((input) => input.endsWith("src/bootstrap.tsx")));
const sharedRoots = ["react.ts", "react-dom.ts", "react-dom-client.ts", "react-jsx-runtime.ts"]
  .map((name) => findOutput(sharedResult.metafile, (_p, out) => (out.entryPoint ?? "").endsWith(`src/shared/${name}`)))
  .filter((p): p is string => p !== null);

const preloadUrls = [...new Set([
  ...staticClosure(sharedResult.metafile, sharedRoots),
  ...staticClosure(appResult.metafile, [mainOut, bootstrapOut].filter((p): p is string => p !== null)),
].map(outUrl))].filter((url) => url !== "/main.js"); // main.js is the script tag itself

const preloadTags = preloadUrls
  .map((url) => `    <link rel="modulepreload" href="${url}" />`)
  .join("\n");
const htmlSource = await readFile(join(here, "src/index.html"), "utf8");
const mainScriptTag = '<script type="module" src="/main.js"></script>';
if (!htmlSource.includes(mainScriptTag)) throw new Error("index.html: main.js script tag not found for modulepreload injection");
await writeFile(
  join(dist, "index.html"),
  htmlSource.replace(mainScriptTag, `${preloadTags}\n    ${mainScriptTag}`),
);
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
