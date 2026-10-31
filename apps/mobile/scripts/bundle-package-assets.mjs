#!/usr/bin/env node
// The native shell is served from the app bundle (the Link loopback proxy answers
// every non-/api path from `public/`), and package web bundles are NOT part of
// apps/web/dist: each lives in packages/<id>/dist/web. Copy them next to the
// shell at exactly the URLs the bundled packages-manifest.json names, so the
// bundled shell and its packages are one build (package code imports the shell's
// /shell-api/* modules and must match them). Runs after `cap sync` / `cap copy`.
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const defaultAppRoot = resolve(here, "..");
const PUBLIC_DIRS = [
  ["ios", "App", "App", "public"],
  ["android", "app", "src", "main", "assets", "public"],
];

const exists = async (path) => stat(path).then(() => true, () => false);

async function filesUnder(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await filesUnder(join(dir, entry.name), relative));
    else if (entry.isFile()) out.push(relative);
  }
  return out;
}

const bare = (url) => url.split("?")[0];

/**
 * @param {{ appRoot?: string, webDist?: string, packagesDir?: string, publicDirs?: string[] }} options
 * @returns {Promise<{ packages: number, files: number, targets: string[] }>}
 */
export async function bundlePackageAssets(options = {}) {
  const appRoot = options.appRoot ?? defaultAppRoot;
  const webDist = options.webDist ?? resolve(appRoot, "../web/dist");
  const packagesDir = options.packagesDir ?? resolve(appRoot, "../../packages");
  const targets = options.publicDirs
    ?? (await Promise.all(PUBLIC_DIRS.map(async (parts) => {
      const dir = join(appRoot, ...parts);
      return (await exists(dir)) ? dir : null;
    }))).filter(Boolean);
  if (targets.length === 0) {
    throw new Error("no Capacitor public directory found; run `cap sync` first");
  }

  const manifestPath = join(webDist, "packages-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${manifestPath}: ${error.message}; run the web build first`);
  }
  if (!Array.isArray(manifest.packages)) throw new Error(`${manifestPath} has no packages list`);

  let files = 0;
  for (const pkg of manifest.packages) {
    if (typeof pkg.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(pkg.id)) {
      throw new Error(`invalid package id in manifest: ${String(pkg.id)}`);
    }
    const source = join(packagesDir, pkg.id, "dist", "web");
    const root = `/packages/${pkg.id}/`;
    for (const url of [pkg.module, ...(pkg.styles ?? [])]) {
      const path = bare(url);
      if (!path.startsWith(root)) throw new Error(`${pkg.id}: ${url} is outside ${root}`);
      if (!(await exists(join(source, path.slice(root.length))))) {
        throw new Error(`${pkg.id}: manifest lists ${url} but ${join(source, path.slice(root.length))} is missing; build the packages first`);
      }
    }
    // Entry, stylesheets and any code-split chunks; source maps and the build
    // manifest are not needed at runtime.
    const names = (await filesUnder(source)).filter((name) => !name.endsWith(".map") && name !== "package-manifest.json");
    for (const target of targets) {
      for (const name of names) {
        const destination = join(target, "packages", pkg.id, name);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(source, name), destination);
      }
    }
    files += names.length;
  }
  return { packages: manifest.packages.length, files, targets };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await bundlePackageAssets();
  console.log(`bundled ${result.files} package files (${result.packages} packages) into ${result.targets.join(", ")}`);
}
