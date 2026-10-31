import { lstat, mkdir, open, readlink, realpath, symlink, unlink, rmdir, writeFile, rename } from "node:fs/promises";
import * as constants from "node:constants";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { SpaceStorage } from "@polyth/contracts";
import type { WorkspaceContext } from "@polyth/contracts/workspace";

const MAX_ROOTS = 128;

const safeAlias = (value: string): string => {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return !normalized || normalized === "." || normalized === ".." || normalized === ".polyth-terminal-workspace.json"
    ? "repository"
    : normalized;
};

const manifestName = (root: string, name: string): string | undefined => {
  if (!name || name.includes("\0") || name.includes("/") || name.includes("\\") || name === "." || name === ".." || basename(name) !== name) return undefined;
  const candidate = resolve(root, name);
  return dirname(candidate) === resolve(root) ? candidate : undefined;
};

interface OwnedLink { path: string; target: string }
interface CompositeOwnership {
  root: string;
  parent: string;
  rootDev: number;
  rootIno: number;
  links: readonly OwnedLink[];
  manifestPath: string;
  manifestDigest?: string;
}

export interface CompositeWorkspace {
  root: string;
  revision: number;
  repositoryIds: string[];
  roots: string[];
  cleanup(): Promise<void>;
}

export async function materializeCompositeWorkspace(input: {
  storage: SpaceStorage;
  workspace: WorkspaceContext;
  projectId: string;
  sessionId?: string;
  ownerId?: string;
  revision?: number;
}): Promise<CompositeWorkspace> {
  if (input.workspace.repositories.length > MAX_ROOTS) {
    throw Object.assign(new Error(`workspace contains too many repositories (maximum ${MAX_ROOTS})`), { code: "resource-limit" });
  }
  const ready = input.workspace.repositories.filter((repository) => repository.state !== "missing");
  if (!ready.length) throw Object.assign(new Error("workspace has no ready repositories"), { code: "not-found" });
  const revision = Math.max(0, Math.floor(input.revision ?? 0));
  const identity = `${safeAlias(input.sessionId ?? input.projectId)}-${createHash("sha256").update(`${input.projectId}\0${input.sessionId ?? ""}\0${input.ownerId ?? ""}`).digest("hex").slice(0, 12)}-${randomUUID().slice(0, 12)}`;
  const root = input.storage.path(join("terminal-workspaces", identity, `r${revision}`));
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  const parent = await realpath(dirname(root));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Object.assign(new Error("composite workspace root is not an owned directory"), { code: "invalid-path" });
  const used = new Set<string>();
  const created: OwnedLink[] = [];
  const manifestPath = join(root, ".polyth-terminal-workspace.json");
  const ownership: CompositeOwnership = { root, parent, rootDev: Number(rootStat.dev), rootIno: Number(rootStat.ino), links: created, manifestPath };
  const authorized = new Map<string, string>();
  try {
    for (const repository of ready) {
      let name = safeAlias(repository.alias);
      if (used.has(name)) name = `${name}-${safeAlias(repository.repositoryId)}`;
      let suffix = 2;
      while (used.has(name)) name = `${safeAlias(repository.alias)}-${suffix++}`;
      used.add(name);
      const link = join(root, name);
      let target: string;
      try { target = await realpath(repository.path); }
      catch { throw Object.assign(new Error("authorized repository checkout is unavailable"), { code: "not-found" }); }
      const targetStat = await lstat(target);
      if (!targetStat.isDirectory()) throw Object.assign(new Error("authorized repository checkout is not a directory"), { code: "invalid-path" });
      authorized.set(name, target);
      try {
        const existing = await lstat(link);
        if (!existing.isSymbolicLink() || resolve(root, await readlink(link)) !== target) {
          throw Object.assign(new Error("composite workspace contains an unexpected entry"), { code: "conflict" });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
        created.push({ path: link, target });
      }
    }
    const tmpManifest = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
    const body = JSON.stringify({ version: 1, links: Object.fromEntries(authorized) });
    await writeFile(tmpManifest, body, { mode: 0o600 });
    await rename(tmpManifest, manifestPath);
    ownership.manifestDigest = createHash("sha256").update(body).digest("hex");
  } catch (error) {
    await cleanupCompositeWorkspace({ ownership }).catch(() => undefined);
    throw error;
  }
  created.length = 0;
  for (const [name, target] of authorized) {
    const path = manifestName(root, name);
    if (path) created.push({ path, target });
  }
  const cleanup = () => cleanupCompositeWorkspace({ ownership });
  return { root, revision, repositoryIds: ready.map((repository) => repository.repositoryId), roots: ready.map((repository) => resolve(repository.path)), cleanup };
}

export async function cleanupCompositeWorkspace(input: { ownership?: CompositeOwnership }): Promise<void> {
  const ownership = input.ownership;
  if (!ownership) return;
  const rootOwned = async (): Promise<boolean> => {
    const currentRoot = await lstat(ownership.root).catch(() => undefined);
    return Boolean(currentRoot && !currentRoot.isSymbolicLink() && currentRoot.isDirectory()
      && Number(currentRoot.dev) === ownership.rootDev && Number(currentRoot.ino) === ownership.rootIno
      && await realpath(dirname(ownership.root)).catch(() => "") === ownership.parent);
  };
  if (!await rootOwned()) return;
  for (const owned of ownership.links) {
    try {
      if (!await rootOwned()) return;
      if (!manifestName(ownership.root, basename(owned.path)) || dirname(resolve(owned.path)) !== resolve(ownership.root)) continue;
      const stat = await lstat(owned.path);
      if (stat.isSymbolicLink() && resolve(ownership.root, await readlink(owned.path)) === resolve(owned.target)) await unlink(owned.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (ownership.manifestDigest) {
    let manifest: Buffer | undefined;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(ownership.manifestPath, constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)));
      const stat = await handle.stat();
      if (stat.isFile() && stat.size <= 64 * 1024) {
        const buffer = Buffer.alloc(64 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead <= 64 * 1024) manifest = buffer.subarray(0, bytesRead);
      }
    } catch { /* replaced, missing, or oversized manifest is not deletion authority */ }
    finally { await handle?.close().catch(() => {}); }
    if (manifest && createHash("sha256").update(manifest).digest("hex") === ownership.manifestDigest && await rootOwned()) await unlink(ownership.manifestPath);
  }
  if (!await rootOwned()) return;
  try { await rmdir(ownership.root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
}

export const compositeDisplayName = (root: string): string => basename(root);
