// Polyth-owned Git worktrees. Distinct from user-created worktrees: a marker
// in the worktree git dir plus a namespaced branch (`polyth/isolate/…`) are
// both required before anything is deleted.
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "@polyth/contracts";
import type { GitService } from "./index.ts";

export const MANAGED_BRANCH_PREFIX = "polyth/isolate/";
export const INTEGRATE_DIR_SUFFIX = "-polyth-integrate";
export const ISOLATE_DIR_SUFFIX = "-polyth-isolate";
const MARKER = "polyth-managed.json";

export interface ManagedWorktreeMeta {
  kind?: "isolate";
  sessionId: string;
  createdAt: string;
  targetPath: string;
  targetBranch: string;
  baseCommit: string;
  worktreeBranch: string;
}

export interface IntegrationMarker {
  kind: "integration";
  sessionId: string;
  createdAt: string;
}

export type ManagedMarker = ManagedWorktreeMeta | IntegrationMarker;

export interface ManagedWorktree {
  path: string;
  branch: string;
  head: string;
  meta: ManagedWorktreeMeta;
}

export type OwnershipFailure = "not-listed" | "marker-missing" | "marker-corrupt" | "wrong-kind" | "mismatch";
export type OwnedWorktreeInspection =
  | { status: "owned"; worktree: ManagedWorktree }
  | { status: "missing" }
  | { status: "unowned"; reason: OwnershipFailure };

export type RemoveOwnedResult =
  | { status: "removed" }
  | { status: "already-gone" }
  | { status: "unowned"; reason: OwnershipFailure };

export interface OwnedWorktreeRef {
  sessionId: string;
  worktreePath: string;
  worktreeBranch: string;
  targetPath?: string;
  targetBranch?: string;
  baseCommit?: string;
}

const log = (event: string, data: JsonObject): void => {
  console.log(`[polyth] isolation ${event} ${JSON.stringify(data)}`);
};

export const isManagedBranch = (branch: string | null | undefined): boolean =>
  !!branch && branch.startsWith(MANAGED_BRANCH_PREFIX);

export function isolateBranchName(sessionId: string): string {
  const short = sessionId.replaceAll("-", "").slice(0, 12);
  return `${MANAGED_BRANCH_PREFIX}${short}`;
}

export function isolateWorktreePath(repoRoot: string, sessionId: string): string {
  const root = resolve(repoRoot);
  const short = sessionId.replaceAll("-", "").slice(0, 12);
  return join(dirname(root), `${basename(root)}${ISOLATE_DIR_SUFFIX}`, short);
}

export function integrationWorktreePath(repoRoot: string, sessionId: string): string {
  const root = resolve(repoRoot);
  const short = sessionId.replaceAll("-", "").slice(0, 12);
  return join(dirname(root), `${basename(root)}${INTEGRATE_DIR_SUFFIX}`, `${short}-${randomUUID()}`);
}

async function writeMarker(git: GitService, worktreePath: string, meta: ManagedMarker): Promise<void> {
  const dir = await git.gitDir(worktreePath);
  await writeFile(join(dir, MARKER), JSON.stringify(meta), "utf8");
}

export async function readManagedMarker(git: GitService, worktreePath: string): Promise<ManagedMarker | null | "corrupt"> {
  let raw: string;
  try {
    const dir = await git.gitDir(worktreePath);
    raw = await readFile(join(dir, MARKER), "utf8");
  } catch {
    return null;
  }
  let parsed: Partial<ManagedMarker> & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Partial<ManagedMarker> & Record<string, unknown>;
  } catch {
    return "corrupt";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "corrupt";
  if (parsed.kind !== undefined && parsed.kind !== "isolate" && parsed.kind !== "integration") return "corrupt";
  if (parsed.kind === "integration") {
    if (typeof parsed.sessionId !== "string") return "corrupt";
    return {
      kind: "integration",
      sessionId: parsed.sessionId,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  }
  if (
    typeof parsed.sessionId !== "string"
    || typeof parsed.worktreeBranch !== "string"
    || typeof parsed.targetPath !== "string"
    || typeof parsed.targetBranch !== "string"
    || typeof parsed.baseCommit !== "string"
  ) return "corrupt";
  return {
    kind: "isolate",
    sessionId: parsed.sessionId,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    targetPath: parsed.targetPath,
    targetBranch: parsed.targetBranch,
    baseCommit: parsed.baseCommit,
    worktreeBranch: parsed.worktreeBranch,
  };
}

export async function readManagedMeta(git: GitService, worktreePath: string): Promise<ManagedWorktreeMeta | null> {
  const marker = await readManagedMarker(git, worktreePath);
  if (!marker || marker === "corrupt" || marker.kind === "integration") return null;
  return marker;
}

export function createManagedWorktrees(git: GitService) {
  const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid-input" });
  const samePath = (a: string, b: string) => resolve(a) === resolve(b);
  const prepareParent = async (path: string) => {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    if (!samePath(await realpath(parent), parent)) {
      throw invalid("managed workspace parent must use its canonical filesystem path; reopen the project through its real path");
    }
  };


  // The creator retains its exact receipt until marker establishment succeeds.
  // Rollback never scans for lookalike paths or falls back to recursive rm.
  const rollback = async (root: string, path: string, branch: string | null, head: string, sessionId: string) => {
    try {
      const listed = (await git.worktrees.list(root)).find((wt) => samePath(wt.path, path));
      if (!listed && !existsSync(path) && (!branch || await git.readRef(root, `refs/heads/${branch}`) === null)) return;
      if (!listed || listed.isMain || listed.branch !== branch || listed.head !== head
        || !samePath(await realpath(path), path)) {
        throw invalid("created worktree identity changed before rollback");
      }
      await git.worktrees.remove(root, { path, deleteBranch: false, force: true });
      if (branch && !await git.deleteRef(root, `refs/heads/${branch}`, head)) throw invalid("created branch rollback failed");
    } catch (error) {
      log("creation-rollback-failed", { sessionId, root, path, branch, head, message: String(error) });
    }
  };

  const inspectOwned = async (root: string, ref: OwnedWorktreeRef): Promise<OwnedWorktreeInspection> => {
    if (ref.worktreeBranch !== isolateBranchName(ref.sessionId)
      || !isManagedBranch(ref.worktreeBranch)
      || !samePath(ref.worktreePath, isolateWorktreePath(root, ref.sessionId))) {
      return { status: "unowned", reason: "mismatch" };
    }
    const listed = (await git.worktrees.list(root)).find((wt) => samePath(wt.path, ref.worktreePath));
    if (!existsSync(ref.worktreePath)) return { status: "missing" };
    if (!listed) return { status: "unowned", reason: "not-listed" };
    if (listed.isMain || listed.branch !== ref.worktreeBranch) return { status: "unowned", reason: "mismatch" };
    // Symlink substitution must not redirect marker reads or destructive Git calls.
    if (!samePath(await realpath(ref.worktreePath), ref.worktreePath)) return { status: "unowned", reason: "mismatch" };
    const marker = await readManagedMarker(git, listed.path);
    if (marker === "corrupt") return { status: "unowned", reason: "marker-corrupt" };
    if (!marker) return { status: "unowned", reason: "marker-missing" };
    if (marker.kind === "integration") return { status: "unowned", reason: "wrong-kind" };
    if (marker.sessionId !== ref.sessionId || marker.worktreeBranch !== ref.worktreeBranch
      || (ref.targetPath !== undefined && !samePath(marker.targetPath, ref.targetPath))
      || (ref.targetBranch !== undefined && marker.targetBranch !== ref.targetBranch)
      || (ref.baseCommit !== undefined && marker.baseCommit !== ref.baseCommit)) {
      return { status: "unowned", reason: "mismatch" };
    }
    if (!(await git.isAncestor(root, marker.baseCommit, listed.head))) return { status: "unowned", reason: "mismatch" };
    return { status: "owned", worktree: { path: listed.path, branch: ref.worktreeBranch, head: listed.head, meta: marker } };
  };

  return {
    isManagedBranch,
    isolateBranchName,
    isolateWorktreePath,
    inspectOwned,

    async inspect(root: string, worktreePath: string): Promise<ManagedWorktree | null> {
      const marker = await readManagedMeta(git, worktreePath);
      if (!marker) return null;
      const result = await inspectOwned(root, { sessionId: marker.sessionId, worktreePath, worktreeBranch: marker.worktreeBranch });
      return result.status === "owned" ? result.worktree : null;
    },

    async create(input: {
      root: string;
      sessionId: string;
      targetBranch: string;
      targetPath: string;
      base?: string;
    }): Promise<ManagedWorktree> {
      if (isManagedBranch(input.targetBranch.replace(/^refs\/heads\//, ""))) throw invalid("nested isolation is unsupported");
      const branch = isolateBranchName(input.sessionId);
      const path = isolateWorktreePath(input.root, input.sessionId);
      if (existsSync(path) || (await git.worktrees.list(input.root)).some((wt) => samePath(wt.path, path))) throw invalid("managed workspace path already exists");
      if (await git.readRef(input.root, `refs/heads/${branch}`) !== null) throw invalid("managed branch already exists");
      const head = await git.revParse(input.root, input.base ?? input.targetBranch);
      await prepareParent(path);
      try {
        const created = await git.worktrees.create(input.root, { branch, path, base: head, newBranchOnly: true });
        const actualHead = await git.revParse(created.path, "HEAD");
        if (!samePath(created.path, path) || created.branch !== branch || actualHead !== head
          || !samePath(await realpath(created.path), created.path)) {
          throw invalid("created worktree identity mismatch");
        }
        const meta: ManagedWorktreeMeta = {
          kind: "isolate",
          sessionId: input.sessionId,
          createdAt: new Date().toISOString(),
          targetPath: resolve(input.targetPath),
          targetBranch: input.targetBranch,
          baseCommit: head,
          worktreeBranch: branch,
        };
        await writeMarker(git, path, meta);
        log("created", { sessionId: input.sessionId, repository: input.root, targetBranch: input.targetBranch, baseCommit: head });
        return { path, branch, head, meta };
      } catch (error) {
        await rollback(input.root, path, branch, head, input.sessionId);
        throw error;
      }
    },

    async snapshot(worktreePath: string, message: string): Promise<{ sha: string; created: boolean }> {
      const result = await git.snapshotCommit(worktreePath, message);
      log("snapshot-created", { worktreePath, sha: result.sha, created: result.created });
      return result;
    },

    async createIntegrationWorkspace(input: {
      root: string;
      sessionId: string;
      startPoint: string;
    }): Promise<string> {
      const path = integrationWorktreePath(input.root, input.sessionId);
      if (existsSync(path) || (await git.worktrees.list(input.root)).some((wt) => samePath(wt.path, path))) throw invalid("integration workspace path already exists");
      const head = await git.revParse(input.root, input.startPoint);
      await prepareParent(path);
      try {
        await git.worktrees.addDetached(input.root, path, head);
        if (!samePath(await realpath(path), path) || await git.revParse(path, "HEAD") !== head
          || (await git.branches(path)).current !== null) throw invalid("created integration identity mismatch");
        await writeMarker(git, path, { kind: "integration", sessionId: input.sessionId, createdAt: new Date().toISOString() });
        log("integration-started", { sessionId: input.sessionId, repository: input.root, startPoint: head });
        return path;
      } catch (error) {
        await rollback(input.root, path, null, head, input.sessionId);
        throw error;
      }
    },

    async removeOwned(root: string, ref: OwnedWorktreeRef): Promise<RemoveOwnedResult> {
      const result = await inspectOwned(root, ref);
      if (result.status === "unowned") return result;
      if (result.status === "missing") {
        // A missing path is not a receipt for deleting a same-named branch.
        // Leave externally removed resources and branch identities untouched.
        return { status: "already-gone" };
      }
      await git.worktrees.remove(root, { path: result.worktree.path, deleteBranch: false, force: true });
      if (!await git.deleteRef(root, `refs/heads/${ref.worktreeBranch}`, result.worktree.head)) throw invalid("owned branch cleanup failed");
      log("cleanup", { sessionId: ref.sessionId, worktreePath: ref.worktreePath, branch: ref.worktreeBranch });
      return { status: "removed" };
    },

    async removeIfOwned(root: string, worktreePath: string): Promise<boolean> {
      const marker = await readManagedMeta(git, worktreePath);
      if (!marker) return false;
      const result = await this.removeOwned(root, { sessionId: marker.sessionId, worktreePath, worktreeBranch: marker.worktreeBranch });
      return result.status === "removed" || result.status === "already-gone";
    },

    async discardIntegration(root: string, integrationPath: string, sessionId: string): Promise<void> {
      const listed = (await git.worktrees.list(root)).find((wt) => samePath(wt.path, integrationPath));
      if (!listed && !existsSync(integrationPath)) return;
      const expectedParent = dirname(integrationWorktreePath(root, sessionId));
      const prefix = `${sessionId.replaceAll("-", "").slice(0, 12)}-`;
      if (!listed || listed.isMain || listed.branch !== null
        || !samePath(dirname(integrationPath), expectedParent) || !basename(integrationPath).startsWith(prefix)
        || !samePath(await realpath(integrationPath), integrationPath)) {
        throw invalid("refusing to delete an unowned integration workspace");
      }
      const marker = await readManagedMarker(git, integrationPath);
      if (!marker || marker === "corrupt" || marker.kind !== "integration" || marker.sessionId !== sessionId) {
        throw invalid("refusing to delete an unowned integration workspace");
      }
      await git.worktrees.remove(root, { path: integrationPath, deleteBranch: false, force: true });
    },

    async pruneIntegrationsForSession(root: string, sessionId: string): Promise<number> {
      if (!sessionId) return 0;
      const list = await git.worktrees.list(root);
      let removed = 0;
      for (const wt of list) {
        if (wt.isMain) continue;
        const marker = await readManagedMarker(git, wt.path);
        if (!marker || marker === "corrupt" || marker.kind !== "integration" || marker.sessionId !== sessionId) continue;
        await this.discardIntegration(root, wt.path, sessionId);
        removed += 1;
        log("cleanup", { sessionId, worktreePath: wt.path, kind: "integration" });
      }
      return removed;
    },

  };
}

export type ManagedWorktreeService = ReturnType<typeof createManagedWorktrees>;
