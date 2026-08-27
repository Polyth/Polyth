// Bundle apps/web to dist/ — runnable from repo root: node apps/web/build.ts
import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

const shellEntries: Record<string, string> = {
  main: join(here, "src/main.tsx"),
};
for (const source of new Set(packageManifests.flatMap((manifest) => manifest.shellEntries))) {
  shellEntries[shellModuleName(source)] = resolve(repositoryRoot, source);
}

// This graph contains only shell-owned entries. Explicit shell API entries let
// independently emitted packages consume stateful shell seams as singletons.
await build({
  ...browserBuildOptions,
  entryPoints: shellEntries,
  outdir: dist,
  plugins: [uiFontScalePlugin],
});
await writeFile(
  join(dist, "packages-manifest.json"),
  `${JSON.stringify({
    packages: packageManifests.map(({ id, module, styles }) => ({ id, module, styles })),
  })}\n`,
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
