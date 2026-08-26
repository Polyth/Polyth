import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";

export interface DiscoveredWebPackage {
  id: string;
  packageName: string;
  dir: string;
  entryPath: string;
  entryFile: string;
}

const INFRASTRUCTURE_PACKAGES = new Set([
  "backend-opencode",
  "contracts",
  "kernel",
  "plugins",
  "server",
  "session",
  "web-sdk",
]);

const invalid = (message: string): Error =>
  Object.assign(new Error(message), { code: "invalid-input" });

const validEntryPath = (entry: string): boolean =>
  entry.length > 0
  && !entry.includes("\\")
  && !isAbsolute(entry)
  && !win32.isAbsolute(entry)
  && !entry.split("/").includes("..");

const inside = (base: string, candidate: string): boolean =>
  candidate === base || candidate.startsWith(base + sep);

/** Discover trusted workspace browser entries from package manifests.
 * Marked entries are resolved through real paths so symlinks cannot escape
 * their package. Unmarked or unreadable directories are ignored. */
export async function discoverWebPackages(
  packagesDir: string,
): Promise<DiscoveredWebPackage[]> {
  let entries;
  try {
    entries = await readdir(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const discovered: DiscoveredWebPackage[] = [];
  for (const item of entries) {
    if (!item.isDirectory()) continue;
    const packageDir = join(packagesDir, item.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const manifest = parsed as { name?: unknown; polyth?: { webEntry?: unknown } } | null;
    const entryPath = manifest?.polyth?.webEntry;
    if (entryPath === undefined) continue;
    if (INFRASTRUCTURE_PACKAGES.has(item.name)) {
      throw invalid(`infrastructure package "${item.name}" must not declare polyth.webEntry`);
    }
    if (typeof entryPath !== "string" || !validEntryPath(entryPath)) {
      throw invalid(
        `package "${item.name}" polyth.webEntry must be a relative path without ".." or backslashes`,
      );
    }
    const dir = await realpath(packageDir);
    const requested = resolve(dir, entryPath);
    if (!inside(dir, requested)) {
      throw invalid(`web entry for "${item.name}" escapes its package directory`);
    }
    const entryFile = await realpath(requested);
    if (!inside(dir, entryFile)) {
      throw invalid(`web entry for "${item.name}" escapes its package directory`);
    }
    if (!(await stat(entryFile)).isFile()) {
      throw invalid(`web entry for "${item.name}" must resolve to a file`);
    }
    discovered.push({
      id: item.name,
      packageName: typeof manifest?.name === "string"
        ? manifest.name
        : `@polyth/${item.name}`,
      dir,
      entryPath,
      entryFile,
    });
  }
  return discovered.sort((left, right) => left.id.localeCompare(right.id));
}
