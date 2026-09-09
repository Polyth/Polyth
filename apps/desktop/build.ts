import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");
const lock = JSON.parse(await readFile(join(here, "opencode.json"), "utf8")) as { version: string };

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(join(here, "build"), { recursive: true });
await copyFile(join(here, "..", "web", "icon-512.png"), join(here, "build", "icon.png"));

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

const linkHostName = process.platform === "win32" ? "polyth-link-host.exe" : "polyth-link-host";
const linkHostSrc = join(here, "..", "..", "target", "release", linkHostName);
const linkHostDir = join(here, "resources", "polyth-link");
await mkdir(linkHostDir, { recursive: true });
if (process.platform === "win32") {
  console.warn("Polyth Link host is not packaged on Windows until named-pipe IPC exists.");
} else {
  const repoRoot = join(here, "..", "..");
  const cargoArgs = ["build", "--release", "-p", "polyth-link-host"];
  if (process.platform === "darwin" && process.env.POLYTH_MAC_UNIVERSAL === "1") {
    for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
      const added = spawnSync("rustup", ["target", "add", target], { cwd: repoRoot, stdio: "inherit" });
      if (added.status !== 0) {
        throw new Error(`failed to add Rust target ${target}`);
      }
      const cargo = spawnSync("cargo", [...cargoArgs, "--target", target], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      if (cargo.status !== 0) {
        throw new Error(`failed to build the Polyth Link host binary for ${target}`);
      }
    }
    const arm = join(repoRoot, "target", "aarch64-apple-darwin", "release", linkHostName);
    const intel = join(repoRoot, "target", "x86_64-apple-darwin", "release", linkHostName);
    if (!existsSync(arm) || !existsSync(intel)) {
      throw new Error("universal Polyth Link host binaries missing after release build");
    }
    const lipo = spawnSync("lipo", ["-create", arm, intel, "-output", join(linkHostDir, linkHostName)], {
      stdio: "inherit",
    });
    if (lipo.status !== 0) {
      throw new Error("failed to create a universal Polyth Link host binary");
    }
  } else {
    const cargo = spawnSync("cargo", cargoArgs, {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (cargo.status !== 0) {
      throw new Error("failed to build the Polyth Link host binary");
    }
    if (!existsSync(linkHostSrc)) {
      throw new Error(`Polyth Link host binary missing after release build: ${linkHostSrc}`);
    }
    await copyFile(linkHostSrc, join(linkHostDir, linkHostName));
  }
  if (!existsSync(join(linkHostDir, linkHostName))) {
    throw new Error(`Polyth Link host binary missing from package resources: ${join(linkHostDir, linkHostName)}`);
  }
}

await copyFile(
  join(here, "..", "..", "packages", "server", "src", "agentToolsMcp.mjs"),
  join(dist, "agentToolsMcp.mjs"),
);

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
