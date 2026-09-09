// Polyth-owned Git worktrees. Distinct from user-created worktrees: a marker
// in the worktree git dir plus a namespaced branch (`polyth/isolate/…`) are
// both required before anything is deleted.
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { JsonObject } from "@polyth/contracts";
import type { GitService } from "./index.ts";

export const MANAGED_BRANCH_PREFIX = "polyth/isolate/";
export const INTEGRATE_DIR_SUFFIX = "-polyth-integrate";
export const ISOLATE_DIR_SUFFIX = "-polyth-isolate";
const MARKER = "polyth-managed.json";
const RECEIPTS = "polyth/creation-receipts";
const CREATION_TOKEN = "polyth-creation-token";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_ID = /^[0-9a-f]{40,64}$/i;

type CreationReceipt = {
  version: 1;
  phase: "planned" | "created";
  kind: "isolate" | "integration";
  root: string;
  path: string;
  sessionId: string;
  expectedHead: string;
  nonce: string;
  branch?: string;
  gitDir?: string;
};

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
  | { status: "unowned"; reason: OwnershipFailureReason };

export type OwnershipFailureReason =
  | "not-listed"
  | "marker-missing"
  | "marker-corrupt"
  | "wrong-kind"
  | "branch-unmanaged"
  | "session-mismatch"
  | "branch-mismatch"
  | "target-mismatch"
  | "base-mismatch";

export type OwnedWorktreeInspection =
  | { status: "owned"; worktree: ManagedWorktree }
  | { status: "missing" }
  | { status: "unowned"; reason: OwnershipFailureReason };

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

const preservedBranchName = (sessionId: string): string => {
  const short = sessionId.replaceAll("-", "").slice(0, 12);
  return `polyth-preserved/${short}-${randomUUID().slice(0, 8)}`;
};

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
  const target = join(dir, MARKER);
  const temp = join(dir, `${MARKER}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(meta), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
    const directory = await open(dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeCreationToken(git: GitService, worktreePath: string, nonce: string): Promise<string> {
  const dir = resolve(await git.gitDir(worktreePath));
  const target = join(dir, CREATION_TOKEN);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(nonce, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
    const directory = await open(dir, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return dir;
}

async function writeCreationReceipt(git: GitService, receipt: CreationReceipt): Promise<string> {
  const directory = join(await git.commonDir(receipt.root), RECEIPTS);
  await mkdir(directory, { recursive: true });
  const name = creationReceiptName(receipt);
  const target = join(directory, name);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(receipt), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
  const dir = await open(directory, "r");
  try { await dir.sync(); } finally { await dir.close(); }
  return target;
}

const creationReceiptName = (receipt: Pick<CreationReceipt, "kind" | "sessionId" | "path">): string =>
  `${receipt.kind}-${receipt.sessionId.replaceAll("-", "")}-${basename(receipt.path)}.json`;

const validReceipt = (value: unknown, root: string): value is CreationReceipt => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CreationReceipt>;
  if (!(item.version === 1
    && (item.phase === "planned" || item.phase === "created")
    && (item.kind === "isolate" || item.kind === "integration")
    && typeof item.root === "string"
    && resolve(item.root) === resolve(root)
    && typeof item.path === "string"
    && typeof item.sessionId === "string" && SESSION_ID.test(item.sessionId)
    && typeof item.expectedHead === "string" && COMMIT_ID.test(item.expectedHead)
    && typeof item.nonce === "string" && SESSION_ID.test(item.nonce)
    && (item.branch === undefined || typeof item.branch === "string")
    && (item.gitDir === undefined || typeof item.gitDir === "string"))) return false;
  if (item.phase === "created" && typeof item.gitDir !== "string") return false;
  if (item.phase === "planned" && item.gitDir !== undefined) return false;
  if (item.kind === "isolate") {
    return resolve(item.path) === resolve(isolateWorktreePath(root, item.sessionId))
      && item.branch === isolateBranchName(item.sessionId);
  }
  const integrationDir = resolve(dirname(integrationWorktreePath(root, item.sessionId)));
  const short = item.sessionId.replaceAll("-", "").slice(0, 12);
  return item.branch === undefined
    && resolve(dirname(item.path)) === integrationDir
    && new RegExp(`^${short}-[0-9a-z]+$`).test(basename(item.path));
};

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
  const rollbackCreated = async (input: {
    root: string;
    path: string;
    branch?: string;
    expectedHead: string;
    sessionId: string;
    stage: string;
  }): Promise<void> => {
    const failures: string[] = [];
    let resourceIdentityProven = false;
    const listed = (await git.worktrees.list(input.root))
      .find((item) => resolve(item.path) === resolve(input.path));
    if (listed) {
      const unchanged = listed.head === input.expectedHead
        && (input.branch === undefined || listed.branch === input.branch)
        && !(await git.hasUniqueChanges(listed.path, input.expectedHead));
      if (!unchanged) {
        failures.push("worktree: identity or contents changed after creation");
      } else {
        resourceIdentityProven = true;
        try {
          await git.worktrees.remove(input.root, { path: input.path, deleteBranch: false, force: true });
        } catch (error) {
          resourceIdentityProven = false;
          failures.push(`worktree: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else if (existsSync(input.path)) {
      failures.push("worktree: unlisted path cannot be proven owned");
    } else {
      resourceIdentityProven = true;
    }

    if (input.branch && resourceIdentityProven) {
      const branchHead = await git.revParse(input.root, input.branch).catch(() => undefined);
      if (branchHead === input.expectedHead) {
        try { await git.deleteBranch(input.root, input.branch); } catch (error) {
          failures.push(`branch: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (branchHead !== undefined) {
        failures.push("branch: tip changed after creation");
      }
    }
    try { await git.worktrees.prune(input.root); } catch (error) {
      failures.push(`prune: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (failures.length) {
      log("creation-rollback-failed", {
        sessionId: input.sessionId,
        worktreePath: input.path,
        branch: input.branch ?? "",
        stage: input.stage,
        failures: failures.join("; "),
      });
      throw new AggregateError(failures.map((message) => new Error(message)), "managed worktree rollback failed");
    }
  };

  const reconcileThrowingCreate = async (
    planned: CreationReceipt,
  ): Promise<boolean> => {
    let inventory: Awaited<ReturnType<GitService["worktrees"]["list"]>>;
    try { inventory = await git.worktrees.list(planned.root); } catch { return false; }
    const listed = inventory.find((item) => resolve(item.path) === resolve(planned.path));
    if (listed) {
      const unchanged = listed.head === planned.expectedHead
        && (planned.branch === undefined || listed.branch === planned.branch)
        && !(await git.hasUniqueChanges(listed.path, planned.expectedHead));
      if (!unchanged) return false;
      const gitDir = await writeCreationToken(git, listed.path, planned.nonce);
      await writeCreationReceipt(git, { ...planned, phase: "created", gitDir });
      await rollbackCreated({
        root: planned.root,
        path: planned.path,
        ...(planned.branch ? { branch: planned.branch } : {}),
        expectedHead: planned.expectedHead,
        sessionId: planned.sessionId,
        stage: `${planned.kind}-create-threw`,
      });
      return true;
    }
    if (existsSync(planned.path)) return false;
    // A branch without its worktree/token is ambiguous: another actor may have
    // created or replaced it after the throwing Git call. Preserve it.
    if (planned.branch && await git.revParse(planned.root, planned.branch).then(() => true).catch(() => false)) return false;
    await git.worktrees.prune(planned.root);
    return true;
  };

  const inspectOwned = async (root: string, ref: OwnedWorktreeRef): Promise<OwnedWorktreeInspection> => {
    const expectedBranch = isolateBranchName(ref.sessionId);
    if (ref.worktreeBranch !== expectedBranch || !isManagedBranch(ref.worktreeBranch)
      || !samePath(ref.worktreePath, isolateWorktreePath(root, ref.sessionId))) {
      return { status: "unowned", reason: "branch-unmanaged" };
    }
    const listed = (await git.worktrees.list(root)).find((item) => samePath(item.path, ref.worktreePath));
    if (!listed) return existsSync(ref.worktreePath)
      ? { status: "unowned", reason: "not-listed" }
      : { status: "missing" };
    if (!existsSync(ref.worktreePath)) return { status: "missing" };
    if (listed.isMain || listed.branch !== ref.worktreeBranch
      || !samePath(await realpath(ref.worktreePath), ref.worktreePath)) {
      return { status: "unowned", reason: "branch-mismatch" };
    }
    const marker = await readManagedMarker(git, listed.path);
    if (marker === "corrupt") return { status: "unowned", reason: "marker-corrupt" };
    if (!marker) return { status: "unowned", reason: "marker-missing" };
    if (marker.kind === "integration") return { status: "unowned", reason: "wrong-kind" };
    if (marker.sessionId !== ref.sessionId) return { status: "unowned", reason: "session-mismatch" };
    if (marker.worktreeBranch !== ref.worktreeBranch) return { status: "unowned", reason: "branch-mismatch" };
    if ((ref.targetPath !== undefined && !samePath(marker.targetPath, ref.targetPath))
      || (ref.targetBranch !== undefined && marker.targetBranch !== ref.targetBranch)) {
      return { status: "unowned", reason: "target-mismatch" };
    }
    if ((ref.baseCommit !== undefined && marker.baseCommit !== ref.baseCommit)
      || !(await git.isAncestor(root, marker.baseCommit, listed.head))) {
      return { status: "unowned", reason: "base-mismatch" };
    }
    return { status: "owned", worktree: { path: listed.path, branch: listed.branch, head: listed.head, meta: marker } };
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
      await prepareParent(path);
      const start = input.base ?? input.targetBranch;
      const expectedHead = await git.revParse(input.root, start);
      const collision = (await git.worktrees.list(input.root))
        .some((item) => resolve(item.path) === resolve(path));
      const branchExists = await git.revParse(input.root, branch).then(() => true).catch(() => false);
      if (collision || branchExists || existsSync(path)) {
        throw Object.assign(new Error("managed workspace path already exists or its branch already exists"), { code: "conflict" });
      }
      const planned: CreationReceipt = {
        version: 1,
        phase: "planned",
        kind: "isolate",
        root: resolve(input.root),
        path: resolve(path),
        sessionId: input.sessionId,
        expectedHead,
        nonce: randomUUID(),
        branch,
      };
      const receipt = await writeCreationReceipt(git, planned);
      let createdResource = false;
      try {
        const created = await git.worktrees.create(input.root, { branch, path, base: expectedHead, newBranchOnly: true });
        createdResource = true;
        const createdGitDir = await writeCreationToken(git, created.path, planned.nonce);
        await writeCreationReceipt(git, { ...planned, phase: "created", gitDir: createdGitDir });
        const head = await git.revParse(created.path, "HEAD");
        if (!samePath(created.path, path) || created.branch !== branch || head !== expectedHead
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
          worktreeBranch: created.branch,
        };
        await writeMarker(git, created.path, meta);
        await rm(receipt, { force: true });
        log("created", {
          sessionId: input.sessionId,
          repository: input.root,
          targetBranch: input.targetBranch,
          baseCommit: head,
        });
        return { path: created.path, branch: created.branch, head, meta };
      } catch (error) {
        if (!createdResource) {
          try {
            if (await reconcileThrowingCreate(planned)) await rm(receipt, { force: true });
            else {
              log("creation-rollback-failed", {
                sessionId: planned.sessionId,
                worktreePath: planned.path,
                branch: planned.branch ?? "",
                stage: "isolation-create-threw",
                failures: "resource identity could not be proven",
              });
              throw error;
            }
          } catch (cleanupError) {
            if (cleanupError === error) throw error;
            throw new AggregateError([error, cleanupError], `managed worktree creation and rollback failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          throw error;
        }
        try {
          await rollbackCreated({
            root: input.root,
            path,
            branch,
            expectedHead,
            sessionId: input.sessionId,
            stage: "isolation-ownership",
          });
          await rm(receipt, { force: true });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `managed worktree creation and rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
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
      await prepareParent(path);
      const expectedHead = await git.revParse(input.root, input.startPoint);
      if ((await git.worktrees.list(input.root)).some((item) => resolve(item.path) === resolve(path)) || existsSync(path)) {
        throw Object.assign(new Error("managed integration destination already exists"), { code: "conflict" });
      }
      const planned: CreationReceipt = {
        version: 1,
        phase: "planned",
        kind: "integration",
        root: resolve(input.root),
        path: resolve(path),
        sessionId: input.sessionId,
        expectedHead,
        nonce: randomUUID(),
      };
      const receipt = await writeCreationReceipt(git, planned);
      let createdResource = false;
      try {
        await git.worktrees.addDetached(input.root, path, input.startPoint);
        createdResource = true;
        const createdGitDir = await writeCreationToken(git, path, planned.nonce);
        await writeCreationReceipt(git, { ...planned, phase: "created", gitDir: createdGitDir });
        await writeMarker(git, path, {
          kind: "integration",
          sessionId: input.sessionId,
          createdAt: new Date().toISOString(),
        });
        await rm(receipt, { force: true });
        log("integration-started", {
          sessionId: input.sessionId,
          repository: input.root,
          startPoint: input.startPoint,
        });
        return path;
      } catch (error) {
        if (!createdResource) {
          try {
            if (await reconcileThrowingCreate(planned)) await rm(receipt, { force: true });
            else throw error;
          } catch (cleanupError) {
            if (cleanupError === error) throw error;
            throw new AggregateError([error, cleanupError], "integration worktree creation and rollback failed");
          }
          throw error;
        }
        try {
          await rollbackCreated({
            root: input.root,
            path,
            expectedHead,
            sessionId: input.sessionId,
            stage: "integration-ownership",
          });
          await rm(receipt, { force: true });
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "integration worktree creation and rollback failed");
        }
        throw error;
      }
    },

    async removeOwned(root: string, ref: OwnedWorktreeRef): Promise<RemoveOwnedResult> {
      const inspection = await inspectOwned(root, ref);
      if (inspection.status === "missing") return { status: "already-gone" };
      if (inspection.status === "unowned") {
        log("cleanup-unowned", {
          worktreePath: ref.worktreePath,
          reason: inspection.reason,
          sessionId: ref.sessionId,
        });
        return inspection;
      }
      await git.worktrees.remove(root, { path: inspection.worktree.path, deleteBranch: false, force: true });
      if (!await git.deleteRef(root, `refs/heads/${ref.worktreeBranch}`, inspection.worktree.head)) {
        throw invalid("owned branch cleanup failed");
      }
      await git.worktrees.prune(root);
      log("cleanup", { sessionId: ref.sessionId, worktreePath: ref.worktreePath, branch: ref.worktreeBranch });
      return { status: "removed" };
    },

    async relinquishOwned(root: string, ref: OwnedWorktreeRef): Promise<{ branch: string }> {
      const inspection = await inspectOwned(root, ref);
      if (inspection.status !== "owned") {
        throw Object.assign(
          new Error(`refusing to relinquish an isolation workspace whose ownership is not proven (${inspection.status === "missing" ? "missing" : inspection.reason})`),
          { code: "conflict" },
        );
      }
      const branch = preservedBranchName(ref.sessionId);
      // Rename first. If any later metadata cleanup is interrupted, the branch
      // mismatch makes every managed deletion path fail closed and also makes
      // the preserved worktree visible in ordinary Git inventory.
      await git.renameBranch(root, ref.worktreeBranch, branch);
      const gitDir = resolve(await git.gitDir(ref.worktreePath));
      const marker = await readManagedMarker(git, ref.worktreePath);
      if (!marker || marker === "corrupt" || marker.kind === "integration"
        || marker.sessionId !== ref.sessionId || marker.worktreeBranch !== ref.worktreeBranch) {
        throw Object.assign(new Error("managed marker changed while relinquishing ownership"), { code: "conflict" });
      }
      await rm(join(gitDir, MARKER), { force: true });
      const tokenPath = join(gitDir, CREATION_TOKEN);
      const nonce = await readFile(tokenPath, "utf8").catch(() => "");
      if (SESSION_ID.test(nonce)) await rm(tokenPath, { force: true });
      const receiptPath = join(
        await git.commonDir(root),
        RECEIPTS,
        creationReceiptName({ kind: "isolate", sessionId: ref.sessionId, path: ref.worktreePath }),
      );
      const receipt = await readFile(receiptPath, "utf8")
        .then((raw) => JSON.parse(raw) as unknown)
        .catch(() => undefined);
      if (validReceipt(receipt, root)
        && receipt.kind === "isolate"
        && receipt.sessionId === ref.sessionId
        && resolve(receipt.path) === resolve(ref.worktreePath)
        && (!nonce || receipt.nonce === nonce)) {
        await rm(receiptPath, { force: true });
      }
      const directory = await open(gitDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      log("ownership-relinquished", {
        sessionId: ref.sessionId,
        worktreePath: ref.worktreePath,
        branch,
      });
      return { branch };
    },

    async removeIfOwned(root: string, worktreePath: string): Promise<boolean> {
      const marker = await readManagedMeta(git, worktreePath);
      if (!marker) return false;
      const result = await this.removeOwned(root, { sessionId: marker.sessionId, worktreePath, worktreeBranch: marker.worktreeBranch });
      return result.status === "removed" || result.status === "already-gone";
    },

    async discardIntegration(root: string, integrationPath: string, sessionId?: string): Promise<void> {
      const listed = (await git.worktrees.list(root))
        .find((item) => resolve(item.path) === resolve(integrationPath));
      if (!listed) return;
      const marker = await readManagedMarker(git, listed.path);
      const owner = marker && marker !== "corrupt" && marker.kind === "integration" ? marker.sessionId : sessionId;
      const expectedParent = owner ? dirname(integrationWorktreePath(root, owner)) : "";
      const prefix = owner ? `${owner.replaceAll("-", "").slice(0, 12)}-` : "";
      if (
        !marker
        || marker === "corrupt"
        || marker.kind !== "integration"
        || (sessionId !== undefined && marker.sessionId !== sessionId)
        || listed.isMain
        || listed.branch !== null
        || !owner
        || !samePath(dirname(integrationPath), expectedParent)
        || !basename(integrationPath).startsWith(prefix)
        || !samePath(await realpath(integrationPath), integrationPath)
      ) {
        throw Object.assign(new Error("refusing to delete an unowned integration workspace whose ownership is not proven"), {
          code: "conflict",
        });
      }
      await git.worktrees.remove(root, { path: integrationPath, deleteBranch: false, force: true });
      await git.worktrees.prune(root);
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
        await this.discardIntegration(root, wt.path, sessionId);
        removed += 1;
        log("cleanup", { sessionId, worktreePath: wt.path, kind: "integration" });
      }
      return removed;
    },

    /** Reconcile interrupted create→marker transactions from a durable exact
     * creation receipt. Dirty or identity-mismatched resources are preserved. */
    async recoverCreations(root: string): Promise<number> {
      const directory = join(await git.commonDir(root), RECEIPTS);
      const names = await readdir(directory).catch(() => [] as string[]);
      let recovered = 0;
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        const file = join(directory, name);
        let receipt: CreationReceipt;
        try {
          const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
          if (!validReceipt(parsed, root)) continue;
          receipt = parsed;
          if (name !== creationReceiptName(receipt)) continue;
        } catch {
          continue;
        }
        const listed = (await git.worktrees.list(root))
          .find((item) => resolve(item.path) === resolve(receipt.path));
        if (!listed) {
          if (receipt.phase !== "created") continue;
          const token = await readFile(join(receipt.gitDir!, CREATION_TOKEN), "utf8").catch(() => undefined);
          if (token !== receipt.nonce) continue;
          // A real path outside Git's worktree inventory has no provable
          // relationship to this receipt. Preserve both it and the branch.
          if (existsSync(receipt.path)) continue;
          if (receipt.branch) {
            const head = await git.revParse(root, receipt.branch).catch(() => undefined);
            if (head === receipt.expectedHead) await git.deleteBranch(root, receipt.branch);
            else if (head !== undefined) continue;
          }
          await rm(file, { force: true });
          recovered += 1;
          continue;
        }
        const marker = await readManagedMarker(git, listed.path);
        const established = receipt.kind === "integration"
          ? marker !== null && marker !== "corrupt" && marker.kind === "integration" && marker.sessionId === receipt.sessionId
          : marker !== null && marker !== "corrupt" && marker.kind !== "integration"
            && marker.sessionId === receipt.sessionId && marker.worktreeBranch === receipt.branch;
        if (established) {
          await rm(file, { force: true });
          recovered += 1;
          continue;
        }
        // Planned intent is not proof that Git completed resource creation.
        // Preserve ambiguous paths/refs rather than deleting a substitute.
        if (receipt.phase !== "created") continue;
        const token = await readFile(join(receipt.gitDir!, CREATION_TOKEN), "utf8").catch(() => undefined);
        if (token !== receipt.nonce) continue;
        const actualGitDir = await git.gitDir(listed.path).then(resolve).catch(() => undefined);
        if (
          actualGitDir !== resolve(receipt.gitDir!)
          ||
          listed.head !== receipt.expectedHead
          || (receipt.branch !== undefined && listed.branch !== receipt.branch)
          || await git.hasUniqueChanges(listed.path, receipt.expectedHead)
        ) continue;
        await git.worktrees.remove(root, { path: listed.path, deleteBranch: false, force: true });
        if (receipt.branch) {
          const head = await git.revParse(root, receipt.branch).catch(() => undefined);
          if (head !== receipt.expectedHead) continue;
          await git.deleteBranch(root, receipt.branch);
        }
        await git.worktrees.prune(root);
        await rm(file, { force: true });
        recovered += 1;
        log("creation-recovered", { sessionId: receipt.sessionId, worktreePath: receipt.path, kind: receipt.kind });
      }
      return recovered;
    },

    async prune(root: string): Promise<void> {
      await git.worktrees.prune(root);
    },
  };
}

export type ManagedWorktreeService = ReturnType<typeof createManagedWorktrees>;
