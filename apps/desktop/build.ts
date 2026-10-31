import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { desktopServerPackagesPlugin } from "./serverPackageInventory.ts";
import { prepareAppIcons } from "./scripts/prepare-icon.mjs";
import { writeThirdPartyNotices } from "../../scripts/third-party-notices.mjs";

const here = import.meta.dirname;
const dist = join(here, "dist");
const lock = JSON.parse(await readFile(join(here, "opencode.json"), "utf8")) as { version: string };

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(join(here, "build"), { recursive: true });
await prepareAppIcons({ buildDir: join(here, "build") });
await copyFile(join(here, "src", "bootstrap.cjs"), join(dist, "bootstrap.cjs"));

const supervisorResources = join(here, "resources", "runtime-supervisor");
await mkdir(supervisorResources, { recursive: true });
if (process.platform === "linux") {
  const target = `linux-${process.arch}`;
  const builder = join(here, "..", "..", "packages", "harness-runtime", "build-supervisor.mjs");
  const built = spawnSync(process.execPath, [builder, `--target=${target}`], { stdio: "inherit" });
  if (built.status !== 0) throw new Error(`failed to build the Polyth runtime supervisor for ${target}`);
  const targetDir = join(supervisorResources, target);
  await mkdir(targetDir, { recursive: true });
  await copyFile(
    join(here, "..", "..", "packages", "harness-runtime", "native", "bin", target, "polyth-supervisor"),
    join(targetDir, "polyth-supervisor"),
  );
}
if (process.platform === "win32") {
  // The Windows execution boundary: without it a Polyth crash fences every
  // harness session until reboot, so a desktop build never ships without it.
  const builder = join(here, "..", "..", "packages", "harness-runtime", "build-supervisor.mjs");
  const built = spawnSync(process.execPath, [builder], { stdio: "inherit" });
  const helper = join(here, "..", "..", "packages", "harness-runtime", "native", "bin", "win32", "polyth-job.exe");
  if (built.status !== 0 || !existsSync(helper)) throw new Error("failed to build polyth-job.exe, the Windows harness job boundary");
  const targetDir = join(supervisorResources, "win32");
  await mkdir(targetDir, { recursive: true });
  await copyFile(helper, join(targetDir, "polyth-job.exe"));
}

const repoRoot = join(here, "..", "..");
const linkDir = join(here, "resources", "polyth-link");
const linkHostName = process.platform === "win32" ? "polyth-link-host.exe" : "polyth-link-host";
const linkClientName = process.platform === "win32" ? "polyth-link-client.exe" : "polyth-link-client";
await mkdir(linkDir, { recursive: true });

if (process.platform === "win32") {
  console.warn("Polyth Link host/client are not packaged on Windows until the native client IPC has a named-pipe transport.");
} else if (process.platform === "darwin" && process.env.POLYTH_MAC_MULTI_ARCH === "1") {
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    const added = spawnSync("rustup", ["target", "add", target], { cwd: repoRoot, stdio: "inherit" });
    if (added.status !== 0) throw new Error(`failed to add Rust target ${target}`);
    for (const pkg of ["polyth-link-host", "polyth-link-client"]) {
      const cargo = spawnSync("cargo", ["build", "--release", "-p", pkg, "--target", target], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      if (cargo.status !== 0) throw new Error(`failed to build ${pkg} for ${target}`);
    }
  }
  for (const name of [linkHostName, linkClientName]) {
    const arm = join(repoRoot, "target", "aarch64-apple-darwin", "release", name);
    const intel = join(repoRoot, "target", "x86_64-apple-darwin", "release", name);
    if (!existsSync(arm) || !existsSync(intel)) throw new Error(`universal Polyth Link binary missing: ${name}`);
    const lipo = spawnSync("lipo", ["-create", arm, intel, "-output", join(linkDir, name)], { stdio: "inherit" });
    if (lipo.status !== 0) throw new Error(`failed to create universal Polyth Link binary: ${name}`);
  }
} else {
  for (const pkg of ["polyth-link-host", "polyth-link-client"]) {
    const cargo = spawnSync("cargo", ["build", "--release", "-p", pkg], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (cargo.status !== 0) throw new Error(`failed to build ${pkg}`);
  }
  await copyFile(join(repoRoot, "target", "release", linkHostName), join(linkDir, linkHostName));
  await copyFile(join(repoRoot, "target", "release", linkClientName), join(linkDir, linkClientName));
}

if (process.platform !== "win32") {
  for (const name of [linkHostName, linkClientName]) {
    if (!existsSync(join(linkDir, name))) {
      throw new Error(`Polyth Link binary missing from package resources: ${join(linkDir, name)}`);
    }
  }
}

await copyFile(
  join(here, "..", "..", "packages", "server", "src", "agentToolsMcp.mjs"),
  join(dist, "agentToolsMcp.mjs"),
);
await copyFile(join(here, "src", "update-window.html"), join(dist, "update-window.html"));

// TypeScript is a runtime dependency of the packaged editor language service.
// Keep it external so its CommonJS implementation is not rewritten into the
// ESM main bundle, then place the exact package beside main.js so electron-
// builder cannot omit it from a workspace's production dependency graph.
const typescriptPackage = join(repoRoot, "node_modules", "typescript");
if (!existsSync(join(typescriptPackage, "package.json"))) {
  throw new Error(`TypeScript runtime package is missing at ${typescriptPackage}`);
}
await cp(typescriptPackage, join(dist, "node_modules", "typescript"), { recursive: true });

const bundles = await Promise.all([
  build({
    entryPoints: [join(here, "src", "main.ts")],
    outfile: join(dist, "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    packages: "bundle",
    plugins: [desktopServerPackagesPlugin(repoRoot)],
    // Playwright uses a generated internal require map that static bundlers
    // cannot resolve. Keep its published package intact in app.asar.
    external: ["electron", "electron-updater", "esbuild", "playwright-core", "typescript"],
    // Bundled CommonJS dependencies such as ws still use dynamic built-in
    // requires. Electron's ESM main process needs a real Node require shim.
    banner: {
      js: 'import { createRequire as __polythCreateRequire } from "node:module"; const require = __polythCreateRequire(import.meta.url);',
    },
    define: {
      __POLYTH_OPENCODE_VERSION__: JSON.stringify(lock.version),
      // "mac-legacy" for the macOS 12 build (scripts/ci/mac-legacy.mjs); empty otherwise.
      __POLYTH_DESKTOP_FLAVOR__: JSON.stringify(process.env.POLYTH_DESKTOP_FLAVOR ?? ""),
      // Polyth's own Google app (packages/google): only release builds have it.
      ...Object.fromEntries(["POLYTH_GOOGLE_BUILTIN_CLIENT_ID", "POLYTH_GOOGLE_BUILTIN_CLIENT_SECRET"]
        .filter((name) => process.env[name])
        .map((name) => [`process.env.${name}`, JSON.stringify(process.env[name])])),
    },
    // Dependency notices ship in THIRD_PARTY_NOTICES.txt, written from the metafiles below.
    legalComments: "none",
    metafile: true,
    logLevel: "info",
  }),
  // The `polyth` CLI, run by the app binary in Node mode (ELECTRON_RUN_AS_NODE)
  // from a user-installed launcher. Outside app.asar so any shell can run it.
  build({
    entryPoints: [join(here, "src", "cliEntry.ts")],
    outfile: join(here, "resources", "cli", "polyth.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    legalComments: "none",
    metafile: true,
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
    metafile: true,
    logLevel: "info",
  }),
  // The small update window: its own least-privilege preload and page script.
  build({
    entryPoints: [join(here, "src", "updateWindowPreload.ts")],
    outfile: join(dist, "update-window-preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    legalComments: "none",
    metafile: true,
    logLevel: "info",
  }),
  build({
    entryPoints: [join(here, "src", "updateWindowPage.ts")],
    outfile: join(dist, "update-window.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    legalComments: "none",
    metafile: true,
    logLevel: "info",
  }),
]);

// Bundling copies dependency code into these files, so their license notices
// travel with the app: in the resources directory, next to the CLI and web app.
await writeThirdPartyNotices(
  join(here, "resources", "notices", "THIRD_PARTY_NOTICES.txt"),
  bundles.map((result) => result.metafile),
  { product: "The Polyth desktop app", workingDir: process.cwd() },
);
