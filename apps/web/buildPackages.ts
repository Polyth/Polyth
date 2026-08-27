// Build every polyth.webEntry into its owning package's dist/web directory.
import { build, type Plugin } from "esbuild";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  browserBuildOptions,
  shellModuleName,
  shellModuleUrl,
  uiFontScalePlugin,
} from "./buildConfig.ts";
import { discoverWebPackages } from "./webPackages.ts";

const here = import.meta.dirname;
const repositoryRoot = resolve(here, "../..");
const packagesDir = resolve(repositoryRoot, "packages");
const webSourceDir = resolve(here, "src");
const analysisOutdir = resolve(repositoryRoot, ".polyth-build-analysis");
const webPackages = await discoverWebPackages(packagesDir);

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

const repositoryRelative = (file: string): string =>
  relative(repositoryRoot, file).split(sep).join("/");

function shellExternalPlugin(
  collected: Set<string>,
  shellOwnedPackageFiles: ReadonlySet<string> = new Set(),
): Plugin {
  return {
    name: "shell-module-externals",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, async (args) => {
        if (args.namespace !== "file" || (args.pluginData as { shellResolve?: boolean } | undefined)?.shellResolve) {
          return undefined;
        }
        const resolved = await buildApi.resolve(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          importer: args.importer,
          pluginData: { shellResolve: true },
        });
        if (resolved.errors.length > 0 || resolved.external) return undefined;
        const isShellModule = inside(webSourceDir, resolved.path)
          || shellOwnedPackageFiles.has(resolved.path);
        if (!isShellModule) return undefined;
        const source = repositoryRelative(resolved.path);
        collected.add(resolved.path);
        return { path: shellModuleUrl(source), external: true };
      });
    },
  };
}

const packageEntryPoints = Object.fromEntries(
  webPackages.map((pkg) => [pkg.id, pkg.entryFile]),
);

// First identify shell modules referenced by package code. Those modules need
// named shell entry points so separately-built packages share the shell's
// stateful stores, registries, and helpers instead of cloning them.
const appShellImports = new Set<string>();
if (webPackages.length > 0) {
  await build({
    ...browserBuildOptions,
    entryPoints: packageEntryPoints,
    outdir: analysisOutdir,
    write: false,
    logLevel: "silent",
    plugins: [uiFontScalePlugin, shellExternalPlugin(appShellImports)],
  });
}

const shellAnalysisEntries: Record<string, string> = {
  main: resolve(webSourceDir, "main.tsx"),
};
for (const file of appShellImports) {
  shellAnalysisEntries[shellModuleName(repositoryRelative(file))] = file;
}
const shellAnalysis = await build({
  ...browserBuildOptions,
  entryPoints: shellAnalysisEntries,
  outdir: analysisOutdir,
  write: false,
  metafile: true,
  logLevel: "silent",
  plugins: [uiFontScalePlugin],
});
const shellOwnedPackageFiles = new Set(
  Object.keys(shellAnalysis.metafile.inputs)
    .map((input) => resolve(repositoryRoot, input))
    .filter((input) => inside(packagesDir, input)),
);

for (const pkg of webPackages) {
  const outdir = resolve(pkg.dir, "dist", "web");
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const shellImports = new Set<string>();
  await build({
    ...browserBuildOptions,
    entryPoints: { entry: pkg.entryFile },
    outdir,
    plugins: [
      uiFontScalePlugin,
      shellExternalPlugin(shellImports, shellOwnedPackageFiles),
    ],
  });
  const outputs = await readdir(outdir);
  const publicManifest = {
    id: pkg.id,
    module: `/packages/${pkg.id}/entry.js`,
    styles: outputs
      .filter((name) => name.endsWith(".css"))
      .sort()
      .map((name) => `/packages/${pkg.id}/${name}`),
  };
  await writeFile(
    resolve(outdir, "package-manifest.json"),
    `${JSON.stringify({
      ...publicManifest,
      shellEntries: [...shellImports]
        .map((file) => repositoryRelative(file))
        .sort(),
    })}\n`,
  );
}

// Keep analysis virtual: write:false means this is normally absent, but
// remove a stale directory left by an interrupted older build.
await rm(analysisOutdir, { recursive: true, force: true });
