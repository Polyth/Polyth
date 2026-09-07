import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PackageManifestV1 } from "@polyth/package-sdk/manifest";
import { loadCanonicalManifest } from "./canonical.ts";
import type { ManagedPluginManifest } from "./managedManifest.ts";
import {
  copyTreeSync,
  listVersionsSync,
  readActiveSync,
  treeIntegrity,
  versionDir,
  writeActiveSync,
} from "./versions.ts";

export interface VersionRecord {
  version: string;
  dir: string;
  canonical: PackageManifestV1;
  legacy: ManagedPluginManifest;
  integrity: string;
  ui?: { integrity: string };
  sandbox?: { integrity: string };
}

export interface PersistedPackage {
  id: string;
  source: string;
  installationId: string;
  candidateVersion?: string;
  previousVersion?: string;
  lastError?: string;
}

const hasInstallManifest = (dir: string): boolean =>
  existsSync(join(dir, "polyth-plugin.json")) || existsSync(join(dir, "polyth-package.json"));

export function publishedAssets(dir: string): Pick<VersionRecord, "ui" | "sandbox"> {
  const out: Pick<VersionRecord, "ui" | "sandbox"> = {};
  try {
    for (const name of readdirSync(join(dir, ".polyth", "ui"))) {
      const match = name.match(/^ui-([a-f0-9]{64})\.mjs$/);
      if (match?.[1]) out.ui = { integrity: match[1] };
    }
  } catch { /* no ui bundle */ }
  try {
    for (const name of readdirSync(join(dir, ".polyth", "sandbox"))) {
      const match = name.match(/^sandbox-([a-f0-9]{64})\.js$/);
      if (match?.[1]) out.sandbox = { integrity: match[1] };
    }
  } catch { /* no sandbox bundle */ }
  return out;
}

function recordKey(home: string, version: string): string {
  return `${home}::${version}`;
}

export function loadVersionRecord(
  home: string,
  version: string,
  cache: Map<string, VersionRecord>,
): VersionRecord {
  const key = recordKey(home, version);
  const hit = cache.get(key);
  if (hit) return hit;
  const dir = versionDir(home, version);
  if (!existsSync(dir)) {
    throw Object.assign(new Error(`version ${version} is not installed`), { code: "not-found" });
  }
  const loaded = loadCanonicalManifest(dir);
  const record: VersionRecord = {
    version,
    dir,
    canonical: loaded.canonical,
    legacy: loaded.legacy,
    integrity: treeIntegrity(dir),
    ...publishedAssets(dir),
  };
  cache.set(key, record);
  return record;
}

/** After migration the `active` pointer is authoritative. Never guess newest semver. */
export function activeVersion(home: string): string | null {
  const fromFile = readActiveSync(home);
  if (fromFile && existsSync(versionDir(home, fromFile))) return fromFile;
  return null;
}

export function migratePersisted(raw: unknown[]): PersistedPackage[] {
  return raw.map((item) => {
    const row = item as Record<string, unknown>;
    if (typeof row.id === "string" && typeof row.installationId === "string" && !row.manifest) {
      return row as unknown as PersistedPackage;
    }
    const manifest = row.manifest as ManagedPluginManifest;
    const out: PersistedPackage = {
      id: manifest.id,
      source: String(row.source ?? ""),
      installationId: String(row.installGeneration ?? row.integrity ?? manifest.version),
    };
    if (row.candidateVersion) out.candidateVersion = String(row.candidateVersion);
    if (row.previousVersion) out.previousVersion = String(row.previousVersion);
    if (row.lastError) out.lastError = String(row.lastError);
    return out;
  });
}

/** One-time: `.versions` and plugin-root installs → `versions/<v>` + `active`. */
export function migratePackageLayout(home: string): void {
  const legacyDot = join(home, ".versions");
  const versionsRoot = join(home, "versions");
  if (existsSync(legacyDot) && !existsSync(versionsRoot)) {
    renameSync(legacyDot, versionsRoot);
  }
  const active = readActiveSync(home);
  if (active && existsSync(versionDir(home, active))) return;
  if (!hasInstallManifest(home)) return;
  const loaded = loadCanonicalManifest(home);
  const version = loaded.legacy.version;
  const dest = versionDir(home, version);
  if (!existsSync(dest)) {
    const tmp = `${dest}.tmp-migrate`;
    rmSync(tmp, { recursive: true, force: true });
    try {
      copyTreeSync(home, tmp);
      mkdirSync(join(home, "versions"), { recursive: true });
      renameSync(tmp, dest);
    } catch (cause) {
      rmSync(tmp, { recursive: true, force: true });
      throw cause;
    }
  }
  writeActiveSync(home, version);
}

export function invalidateVersionCache(cache: Map<string, VersionRecord>, home: string, version?: string): void {
  if (version) {
    cache.delete(recordKey(home, version));
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${home}::`)) cache.delete(key);
  }
}

export function listInstalledVersions(home: string): string[] {
  return listVersionsSync(home);
}
