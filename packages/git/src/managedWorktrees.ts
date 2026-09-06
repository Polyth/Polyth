// Polyth-owned Git worktrees. Distinct from user-created worktrees: a marker
// in the worktree git dir plus a namespaced branch (`polyth/isolate/…`) are
// both required before anything is deleted.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { JsonObject } from "@polyth/contracts";
import type { GitService } from "./index.ts";

export const MANAGED_BRANCH_PREFIX = "polyth/isolate/";
export const INTEGRATE_DIR_SUFFIX = "-polyth-integrate";
export const ISOLATE_DIR_SUFFIX = "-polyth-isolate";
const MARKER = "polyth-managed.json";

export interface ManagedWorktreeMeta {
  sessionId: string;
  createdAt: string;
  targetPath: string;
  targetBranch: string;
  baseCommit: string;
  worktreeBranch: string;
}

export interface ManagedWorktree {
  path: string;
  branch: string;
  head: string;
  meta: ManagedWorktreeMeta;
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
  return join(dirname(root), `${basename(root)}${INTEGRATE_DIR_SUFFIX}`, `${short}-${Date.now().toString(36)}`);
}

async function writeMarker(git: GitService, worktreePath: string, meta: ManagedWorktreeMeta): Promise<void> {
  const dir = await git.gitDir(worktreePath);
  await writeFile(join(dir, MARKER), JSON.stringify(meta), "utf8");
}

export async function readManagedMeta(git: GitService, worktreePath: string): Promise<ManagedWorktreeMeta | null> {
  try {
    const dir = await git.gitDir(worktreePath);
    const raw = await readFile(join(dir, MARKER), "utf8");
    const parsed = JSON.parse(raw) as Partial<ManagedWorktreeMeta>;
    if (
      typeof parsed.sessionId !== "string"
      || typeof parsed.worktreeBranch !== "string"
      || typeof parsed.targetPath !== "string"
      || typeof parsed.targetBranch !== "string"
      || typeof parsed.baseCommit !== "string"
    ) return null;
    return {
      sessionId: parsed.sessionId,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      targetPath: parsed.targetPath,
      targetBranch: parsed.targetBranch,
      baseCommit: parsed.baseCommit,
      worktreeBranch: parsed.worktreeBranch,
    };
  } catch {
    return null;
  }
}

export function createManagedWorktrees(git: GitService) {
  return {
    isManagedBranch,
    isolateBranchName,
    isolateWorktreePath,

    async inspect(root: string, worktreePath: string): Promise<ManagedWorktree | null> {
      const list = await git.worktrees.list(root);
      const wt = list.find((item) => resolve(item.path) === resolve(worktreePath));
      if (!wt) return null;
      const meta = await readManagedMeta(git, wt.path);
      if (!meta) return null;
      return { path: wt.path, branch: wt.branch ?? meta.worktreeBranch, head: wt.head, meta };
    },

    async create(input: {
      root: string;
      sessionId: string;
      targetBranch: string;
      targetPath: string;
      base?: string;
    }): Promise<ManagedWorktree> {
      const branch = isolateBranchName(input.sessionId);
      const path = isolateWorktreePath(input.root, input.sessionId);
      await mkdir(dirname(path), { recursive: true });
      const start = input.base ?? input.targetBranch;
      const created = await git.worktrees.create(input.root, { branch, path, base: start });
      const head = await git.revParse(created.path, "HEAD");
      const meta: ManagedWorktreeMeta = {
        sessionId: input.sessionId,
        createdAt: new Date().toISOString(),
        targetPath: resolve(input.targetPath),
        targetBranch: input.targetBranch,
        baseCommit: head,
        worktreeBranch: created.branch,
      };
      await writeMarker(git, created.path, meta);
      log("created", {
        sessionId: input.sessionId,
        repository: input.root,
        targetBranch: input.targetBranch,
        baseCommit: head,
      });
      return { path: created.path, branch: created.branch, head, meta };
    },

    async snapshot(worktreePath: string, message: string): Promise<{ sha: string; created: boolean }> {
      const identity = await git.identity(worktreePath);
      const result = await git.snapshotCommit(worktreePath, message, {
        name: identity.name || "Polyth",
        email: identity.email || "polyth@localhost",
      });
      log("snapshot-created", { worktreePath, sha: result.sha, created: result.created });
      return result;
    },

    async createIntegrationWorkspace(input: {
      root: string;
      sessionId: string;
      startPoint: string;
    }): Promise<string> {
      const path = integrationWorktreePath(input.root, input.sessionId);
      await mkdir(dirname(path), { recursive: true });
      await git.worktrees.addDetached(input.root, path, input.startPoint);
      log("integration-started", {
        sessionId: input.sessionId,
        repository: input.root,
        startPoint: input.startPoint,
      });
      return path;
    },

    async remove(root: string, worktreePath: string, opts?: { deleteBranch?: boolean }): Promise<void> {
      const owned = await this.inspect(root, worktreePath);
      if (!owned) {
        throw Object.assign(new Error("refusing to delete a worktree Polyth does not own"), {
          code: "invalid-input",
        });
      }
      const deleteBranch = opts?.deleteBranch !== false && isManagedBranch(owned.branch);
      await git.worktrees.remove(root, { path: worktreePath, deleteBranch });
      await git.worktrees.prune(root);
      log("cleanup", { sessionId: owned.meta.sessionId, worktreePath, branch: owned.branch });
    },

    async removeIfOwned(root: string, worktreePath: string): Promise<boolean> {
      const owned = await this.inspect(root, worktreePath).catch(() => null);
      if (!owned) return false;
      await this.remove(root, worktreePath, { deleteBranch: true });
      return true;
    },

    async discardIntegration(root: string, integrationPath: string): Promise<void> {
      try {
        await git.worktrees.remove(root, { path: integrationPath, deleteBranch: false });
      } catch {
        await rm(integrationPath, { recursive: true, force: true }).catch(() => undefined);
        await git.worktrees.prune(root);
      }
    },

    async prune(root: string): Promise<void> {
      await git.worktrees.prune(root);
    },
  };
}

export type ManagedWorktreeService = ReturnType<typeof createManagedWorktrees>;
