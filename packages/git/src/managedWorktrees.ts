// Polyth-owned Git worktrees. Distinct from user-created worktrees: a marker
// in the worktree git dir plus a namespaced branch (`polyth/isolate/…`) are
// both required before anything is deleted.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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

export type RemoveOwnedResult =
  | { status: "removed" }
  | { status: "already-gone" }
  | { status: "unowned"; reason: "not-listed" | "marker-missing" | "marker-corrupt" | "wrong-kind" | "mismatch" };

export interface OwnedWorktreeRef {
  sessionId: string;
  worktreePath: string;
  worktreeBranch: string;
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
        kind: "isolate",
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
      await writeMarker(git, path, {
        kind: "integration",
        sessionId: input.sessionId,
        createdAt: new Date().toISOString(),
      });
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
      // Owned isolation worktrees are discarded after identity + rebound gates.
      // User `/api/worktrees/remove` still refuses dirty trees unless the user
      // confirms `force`. Isolation cleanup is throwing away managed
      // infrastructure, so Git `--force` is required here.
      await git.worktrees.remove(root, { path: worktreePath, deleteBranch, force: true });
      await git.worktrees.prune(root);
      log("cleanup", { sessionId: owned.meta.sessionId, worktreePath, branch: owned.branch });
    },

    async removeOwned(root: string, ref: OwnedWorktreeRef): Promise<RemoveOwnedResult> {
      const expectedBranch = isolateBranchName(ref.sessionId);
      if (ref.worktreeBranch !== expectedBranch || !isManagedBranch(ref.worktreeBranch)) {
        log("cleanup-unowned", { worktreePath: ref.worktreePath, reason: "mismatch", sessionId: ref.sessionId });
        return { status: "unowned", reason: "mismatch" };
      }
      const listed = (await git.worktrees.list(root))
        .find((item) => resolve(item.path) === resolve(ref.worktreePath));
      if (!listed && !existsSync(ref.worktreePath)) {
        await git.deleteBranch(root, expectedBranch);
        await git.worktrees.prune(root);
        return { status: "already-gone" };
      }
      if (!listed) {
        log("cleanup-unowned", { worktreePath: ref.worktreePath, reason: "not-listed" });
        return { status: "unowned", reason: "not-listed" };
      }
      const marker = await readManagedMarker(git, listed.path);
      if (marker === "corrupt") {
        log("cleanup-unowned", { worktreePath: ref.worktreePath, reason: "marker-corrupt" });
        return { status: "unowned", reason: "marker-corrupt" };
      }
      if (!marker) {
        log("cleanup-unowned", { worktreePath: ref.worktreePath, reason: "marker-missing" });
        return { status: "unowned", reason: "marker-missing" };
      }
      if (marker.kind === "integration") {
        log("cleanup-unowned", { worktreePath: ref.worktreePath, reason: "wrong-kind" });
        return { status: "unowned", reason: "wrong-kind" };
      }
      if (
        marker.sessionId !== ref.sessionId
        || marker.worktreeBranch !== ref.worktreeBranch
        || (listed.branch && listed.branch !== ref.worktreeBranch)
      ) {
        log("cleanup-unowned", {
          worktreePath: ref.worktreePath,
          reason: "mismatch",
          sessionId: ref.sessionId,
          markerSessionId: marker.sessionId,
        });
        return { status: "unowned", reason: "mismatch" };
      }
      await this.remove(root, ref.worktreePath, { deleteBranch: true });
      return { status: "removed" };
    },

    async removeIfOwned(root: string, worktreePath: string): Promise<boolean> {
      const listed = (await git.worktrees.list(root))
        .find((item) => resolve(item.path) === resolve(worktreePath));
      if (!listed) return false;
      const marker = await readManagedMarker(git, listed.path);
      if (!marker || marker === "corrupt" || marker.kind === "integration") return false;
      const result = await this.removeOwned(root, {
        sessionId: marker.sessionId,
        worktreePath,
        worktreeBranch: marker.worktreeBranch,
      });
      return result.status === "removed" || result.status === "already-gone";
    },

    async discardIntegration(root: string, integrationPath: string): Promise<void> {
      try {
        await git.worktrees.remove(root, { path: integrationPath, deleteBranch: false, force: true });
      } catch (error) {
        log("cleanup-failed", {
          worktreePath: integrationPath,
          stage: "discard-integration",
          message: error instanceof Error ? error.message : String(error),
        });
        await rm(integrationPath, { recursive: true, force: true }).catch((rmError: unknown) => {
          log("cleanup-failed", {
            worktreePath: integrationPath,
            stage: "discard-integration-rm",
            message: rmError instanceof Error ? rmError.message : String(rmError),
          });
        });
        await git.worktrees.prune(root);
      }
    },

    async pruneIntegrationsForSession(root: string, sessionId: string): Promise<number> {
      if (!sessionId) return 0;
      const list = await git.worktrees.list(root);
      let removed = 0;
      for (const wt of list) {
        if (wt.isMain) continue;
        const marker = await readManagedMarker(git, wt.path);
        if (!marker || marker === "corrupt" || marker.kind !== "integration") continue;
        if (marker.sessionId !== sessionId) continue;
        await this.discardIntegration(root, wt.path);
        removed += 1;
        log("cleanup", { sessionId, worktreePath: wt.path, kind: "integration" });
      }
      return removed;
    },

    async prune(root: string): Promise<void> {
      await git.worktrees.prune(root);
    },
  };
}

export type ManagedWorktreeService = ReturnType<typeof createManagedWorktrees>;
