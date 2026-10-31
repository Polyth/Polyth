// Package-owned, deployment-wide (non-tenant) data. A removable feature
// package keeps every file it writes under one of two roots it owns:
//
//   packageDataDir(host)                         <dataDir>/packages/<id>
//   host.spaceStorage(ctx).packageDir(host.pluginId)  <space>/packages/<id>
//
// so deleting the package can delete everything it left behind (see
// `packageResidue.ts`). Writing straight into the shared `host.storageDir`
// root is reserved for framework packages; the containment test enforces it.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

const PACKAGE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PackageDataHost {
  storageDir: string;
  pluginId: string;
}

/** Root of every package's deployment-wide data: `<dataDir>/packages`. */
export function packageDataRoot(storageDir: string): string {
  return join(storageDir, "packages");
}

/** The package's own deployment-wide data directory, created on demand. */
export function packageDataDir(host: PackageDataHost): string {
  if (!PACKAGE_ID.test(host.pluginId)) {
    throw Object.assign(new Error("package id must be lowercase letters, digits, and dashes"), { code: "invalid-input" });
  }
  const dir = join(packageDataRoot(host.storageDir), host.pluginId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const relativeInside = (path: string): boolean => {
  if (!path || isAbsolute(path) || path.includes("\\")) return false;
  const normalized = normalize(path);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${sep}`);
};

/**
 * One-time adoption of files a package wrote into the shared data root before
 * it owned a directory. Each legacy path (relative to `host.storageDir`) is
 * renamed to the same relative path inside `packageDataDir(host)` when the
 * target does not exist yet. Never overwrites, never copies, never deletes: a
 * failed rename leaves the legacy file in place and is reported, so the caller
 * can keep reading it. Returns the relative paths that now live in the
 * package directory (moved now or earlier).
 */
export function adoptLegacyPackageData(
  host: PackageDataHost,
  legacyPaths: readonly string[],
  onError: (path: string, error: unknown) => void = (path, error) =>
    console.warn(`[polyth] ${host.pluginId}: could not adopt legacy data ${path}`, error),
): string[] {
  const dir = packageDataDir(host);
  const adopted: string[] = [];
  for (const path of legacyPaths) {
    if (!relativeInside(path)) throw new Error(`legacy package data path must be relative: ${path}`);
    const from = join(host.storageDir, path);
    const to = join(dir, path);
    if (existsSync(to)) {
      // Adopted before. A legacy file beside it was written after that (an
      // older build after a downgrade, or a restored backup): the package keeps
      // reading its own copy, so say so instead of hiding the second one.
      if (existsSync(from)) {
        console.warn(`[polyth] ${host.pluginId}: legacy data ${path} exists beside the adopted copy in ${dir}; it is left untouched and not read`);
      }
      adopted.push(path);
      continue;
    }
    if (!existsSync(from)) continue;
    try {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameSync(from, to);
      adopted.push(path);
    } catch (error) {
      onError(path, error);
    }
  }
  return adopted;
}
