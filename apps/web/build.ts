// Bundle apps/web to dist/ — runnable from repo root: node apps/web/build.ts
import { build, type Metafile } from "esbuild";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  browserBuildOptions,
  shellModuleName,
  uiFontScalePlugin,
} from "./buildConfig.ts";
import { discoverWebPackages } from "./webPackages.ts";

const here = import.meta.dirname;
const dist = join(here, "dist");
const repositoryRoot = resolve(here, "../..");
const packagesDir = resolve(repositoryRoot, "packages");
const projectIcons = join(here, "src", "assets", "project-icons");
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH ?? "");
const buildId = process.env.POLYTH_WEB_BUILD_ID?.trim()
  || (Number.isFinite(sourceDateEpoch) && sourceDateEpoch > 0
    ? Math.round(sourceDateEpoch * 1000).toString(36)
    : Date.now().toString(36));
const webPackages = await discoverWebPackages(packagesDir);
const packageManifests = await Promise.all(webPackages.map(async (pkg) => {
  const parsed = JSON.parse(
    await readFile(resolve(pkg.dir, "dist", "web", "package-manifest.json"), "utf8"),
  ) as {
    id?: unknown;
    module?: unknown;
    styles?: unknown;
    shellEntries?: unknown;
  };
  if (
    parsed.id !== pkg.id
    || typeof parsed.module !== "string"
    || !Array.isArray(parsed.styles)
    || !parsed.styles.every((style) => typeof style === "string")
    || !Array.isArray(parsed.shellEntries)
    || !parsed.shellEntries.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`invalid package web manifest for "${pkg.id}"`);
  }
  return {
    id: pkg.id,
    module: parsed.module,
    styles: parsed.styles as string[],
    shellEntries: parsed.shellEntries as string[],
  };
}));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const shared = join(dist, "shared");

// React stays shell-owned. Package bundles import these same browser modules.
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

const shellEntries: Record<string, string> = {
  main: join(here, "src/main.tsx"),
};
for (const source of new Set(packageManifests.flatMap((manifest) => manifest.shellEntries))) {
  shellEntries[shellModuleName(source)] = resolve(repositoryRoot, source);
}

// This graph contains only shell-owned entries. Explicit shell API entries let
// independently emitted packages consume stateful shell seams as singletons.
const appResult = await build({
  ...browserBuildOptions,
  entryPoints: shellEntries,
  metafile: true,
  outdir: dist,
  define: {
    ...browserBuildOptions.define,
    __POLYTH_WEB_BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [uiFontScalePlugin],
});
await writeFile(
  join(dist, "packages-manifest.json"),
  `${JSON.stringify({
    packages: packageManifests.map(({ id, module, styles }) => ({ id, module, styles })),
  })}\n`,
);
await writeFile(
  join(dist, "build-id.json"),
  `${JSON.stringify({ build: buildId })}\n`,
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

const shellPreloadUrls = [
  ...staticClosure(sharedResult.metafile, sharedRoots),
  ...staticClosure(appResult.metafile, [mainOut, bootstrapOut].filter((p): p is string => p !== null)),
].map(outUrl);
const preloadUrls = [...new Set([
  ...shellPreloadUrls,
])].filter((url) => url !== "/main.js"); // main.js is the script tag itself

const preloadTags = preloadUrls
  .map((url) => `    <link rel="modulepreload" href="${url}" />`)
  .join("\n");
const htmlSource = await readFile(join(here, "src/index.html"), "utf8");
const mainScriptTag = '<script type="module" src="/main.js"></script>';
if (!htmlSource.includes(mainScriptTag)) throw new Error("index.html: main.js script tag not found for modulepreload injection");
await writeFile(
  join(dist, "index.html"),
  htmlSource
    .replace(mainScriptTag, `${preloadTags}\n    ${mainScriptTag}`),
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
