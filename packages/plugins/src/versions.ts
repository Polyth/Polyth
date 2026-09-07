import { copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { compare as compareSemver, valid as validSemver } from "semver";
import { atomicWriteSync } from "./atomicWrite.ts";

const SKIP = new Set(["node_modules", "versions", ".versions"]);

async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const name of await readdir(src)) {
    if (SKIP.has(name) || name === "active") continue;
    const from = join(src, name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) {
      throw Object.assign(new Error(`symlink in published tree: ${name}`), { code: "invalid-input" });
    }
    const to = join(dest, name);
    if (info.isDirectory()) await copyTree(from, to);
    else await copyFile(from, to);
  }
}

export function copyTreeSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    if (SKIP.has(name) || name === "active") continue;
    const from = join(src, name);
    const info = lstatSync(from);
    if (info.isSymbolicLink()) {
      throw Object.assign(new Error(`symlink in published tree: ${name}`), { code: "invalid-input" });
    }
    const to = join(dest, name);
    if (info.isDirectory()) copyTreeSync(from, to);
    else copyFileSync(from, to);
  }
}

export function treeIntegrity(dir: string): string {
  const hash = createHash("sha256");
  const visit = (current: string, prefix = ""): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw Object.assign(new Error(`symlink in published tree: ${entry.name}`), { code: "invalid-input" });
      }
      if (entry.isDirectory() && SKIP.has(entry.name)) continue;
      if (entry.name === "active") continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path, relativePath);
      else if (entry.isFile()) {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  };
  visit(dir);
  return hash.digest("hex");
}

export function versionDir(pluginHome: string, version: string): string {
  return join(pluginHome, "versions", version);
}

export function readActiveSync(pluginHome: string): string | null {
  try {
    const value = readFileSync(join(pluginHome, "active"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function resolveActiveDir(pluginHome: string): string {
  const active = readActiveSync(pluginHome);
  if (active) {
    const dir = versionDir(pluginHome, active);
    if (existsSync(dir)) return dir;
  }
  throw Object.assign(new Error("active version pointer is missing or invalid"), { code: "conflict" });
}

export async function writeActive(pluginHome: string, version: string): Promise<void> {
  writeActiveSync(pluginHome, version);
}

export function writeActiveSync(pluginHome: string, version: string): void {
  mkdirSync(pluginHome, { recursive: true });
  atomicWriteSync(join(pluginHome, "active"), `${version}\n`);
}

export async function publishVersion(pluginHome: string, version: string, src: string): Promise<string> {
  const dest = versionDir(pluginHome, version);
  await mkdir(join(pluginHome, "versions"), { recursive: true });
  if (existsSync(dest)) {
    if (treeIntegrity(dest) === treeIntegrity(src)) return dest;
    throw Object.assign(
      new Error(`version ${version} is already published with different contents`),
      { code: "conflict" },
    );
  }
  const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await rm(tmp, { recursive: true, force: true });
  try {
    await copyTree(src, tmp);
    await rename(tmp, dest);
    return dest;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function listVersionsSync(pluginHome: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(pluginHome, "versions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.includes(".tmp-"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .filter((name) => validSemver(name))
    .sort((a, b) => compareSemver(b, a));
}
