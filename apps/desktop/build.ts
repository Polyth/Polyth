import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");
const lock = JSON.parse(await readFile(join(here, "opencode.json"), "utf8")) as { version: string };

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(join(here, "build"), { recursive: true });
await copyFile(join(here, "..", "web", "icon-512.png"), join(here, "build", "icon.png"));

await Promise.all([
  build({
    entryPoints: [join(here, "src", "main.ts")],
    outfile: join(dist, "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    packages: "bundle",
    // Playwright uses a generated internal require map that static bundlers
    // cannot resolve. Keep its published package intact in app.asar.
    external: ["electron", "electron-updater", "esbuild", "playwright-core"],
    // Bundled CommonJS dependencies such as ws still use dynamic built-in
    // requires. Electron's ESM main process needs a real Node require shim.
    banner: {
      js: 'import { createRequire as __polythCreateRequire } from "node:module"; const require = __polythCreateRequire(import.meta.url);',
    },
    define: {
      __POLYTH_OPENCODE_VERSION__: JSON.stringify(lock.version),
    },
    legalComments: "none",
    logLevel: "info",
  }),
  build({
    entryPoints: [join(here, "src", "preload.ts")],
    outfile: join(dist, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    legalComments: "none",
    logLevel: "info",
  }),
]);
