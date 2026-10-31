// Polyth-owned Git worktrees. Distinct from user-created worktrees: a marker
// in the worktree git dir plus a namespaced branch (`polyth/isolate/…`) are
// both required before anything is deleted.
import { constants, existsSync, realpathSync } from "node:fs";
import { access, link, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JsonObject } from "@polyth/contracts";
import type { GitService } from "./index.ts";
import { inheritCheckoutEnvironment } from "./worktreeInheritance.ts";

export const MANAGED_BRANCH_PREFIX = "polyth/isolate/";
export const INTEGRATE_DIR_SUFFIX = "-polyth-integrate";
export const ISOLATE_DIR_SUFFIX = "-polyth-isolate";
const MARKER = "polyth-managed.json";
const RECEIPTS = "polyth/creation-receipts";
const CREATION_TOKEN = "polyth-creation-token";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_ID = /^[0-9a-f]{40,64}$/i;
const STALE_PLANNED_RECEIPT_MS = 60 * 60_000;

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
  /** The target before the latest at-rest retarget. Ownership accepts either,
   *  so a crash between rewriting this marker and persisting the session's
   *  new target never leaves the checkout unowned. */
  retargetedFrom?: string;
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

/** Per-user home for managed checkouts of a repository whose parent folder
 * cannot hold the `<repo>-polyth-isolate` sibling (for example `/data/swarm`
 * under a root-owned `/data`). Canonicalized so ownership checks compare the
 * same real path that Git records. */
export function managedWorktreeFallbackBase(): string {
  const configured = process.env.POLYTH_MANAGED_WORKTREES_DIR?.trim();
  const base = configured
    ? resolve(configured)
    : resolve(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "polyth", "worktrees");
  try { return realpathSync(base); } catch { return base; }
}

const samePathSync = (a: string, b: string): boolean => resolve(a) === resolve(b);

/** Managed folders for one checkout root, in placement order: the sibling next
 * to it, then the per-user fallback keyed by its full path so equal basenames
 * never share a folder. */
function managedFolders(repoRoot: string, suffix: string): [string, string] {
  const root = resolve(repoRoot);
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return [
    join(dirname(root), `${basename(root)}${suffix}`),
    join(managedWorktreeFallbackBase(), `${basename(root)}-${key}${suffix}`),
  ];
}

/** Folders a repository's managed checkouts are created in. `anchor` is the
 * Git worktree that contains `repoRoot` (see `placementAnchor`): a project
 * registered at a subdirectory places its checkouts next to that worktree,
 * never inside it. */
const allocationFolders = (repoRoot: string, suffix: string, anchor = repoRoot): string[] =>
  managedFolders(anchor, suffix);

/** Folders a repository's managed checkouts may legitimately occupy: the
 * allocation folders plus, for a subdirectory project, the folders next to the
 * subdirectory itself, where checkouts were created before placement moved to
 * the containing worktree. */
const acceptedFolders = (repoRoot: string, suffix: string, anchor = repoRoot): string[] =>
  samePathSync(anchor, repoRoot)
    ? managedFolders(repoRoot, suffix)
    : [...managedFolders(anchor, suffix), ...managedFolders(repoRoot, suffix)];

const shortId = (sessionId: string): string => sessionId.replaceAll("-", "").slice(0, 12);

/** Every location a session's isolated checkout may legitimately occupy. */
export function isolateWorktreePaths(repoRoot: string, sessionId: string, anchor = repoRoot): string[] {
  return acceptedFolders(repoRoot, ISOLATE_DIR_SUFFIX, anchor).map((folder) => join(folder, shortId(sessionId)));
}

/** The preferred (sibling) isolated checkout location. */
export function isolateWorktreePath(repoRoot: string, sessionId: string, anchor = repoRoot): string {
  return isolateWorktreePaths(repoRoot, sessionId, anchor)[0]!;
}

const integrationFolders = (repoRoot: string, anchor = repoRoot): string[] =>
  acceptedFolders(repoRoot, INTEGRATE_DIR_SUFFIX, anchor);

/** The Git worktree whose checkout contains `repoRoot`: the repository itself
 * when it is registered at its top level, the containing worktree when a
 * project points at a subdirectory. Managed checkouts are full checkouts of
 * that worktree's repository, so placing them next to a subdirectory would
 * nest a whole copy of the repository inside the user's working tree. A Git
 * error keeps the repository path itself, the placement used before. */
export async function placementAnchor(git: Pick<GitService, "worktrees">, repoRoot: string): Promise<string> {
  const root = resolve(repoRoot);
  const listed = await git.worktrees.list(root).catch(() => []);
  let anchor: string | undefined;
  for (const item of listed) {
    const path = resolve(item.path);
    const rel = relative(path, root);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    if (!anchor || path.length > anchor.length) anchor = path;
  }
  return anchor ?? root;
}

export function integrationWorktreePath(repoRoot: string, sessionId: string, folder = integrationFolders(repoRoot)[0]!): string {
  return join(folder, `${shortId(sessionId)}-${randomUUID()}`);
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

/** Persist a creation receipt. The planned receipt is the creation's claim on
 * its exact path: it is published with `link`, which fails when the name is
 * taken, so two creates for one session (in this process or another) can
 * never both proceed and the loser never mistakes the winner's checkout for
 * its own half-made one. Later phases replace the claimed receipt. */
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
  if (receipt.phase === "planned") {
    try {
      await link(temp, target);
    } catch (error) {
      if ((error as { code?: unknown })?.code === "EEXIST") {
        throw Object.assign(new Error("a managed workspace for this session is already being created"), { code: "conflict" });
      }
      throw error;
    } finally {
      await rm(temp, { force: true });
    }
  } else {
    await rename(temp, target);
  }
  const dir = await open(directory, "r");
  try { await dir.sync(); } finally { await dir.close(); }
  return target;
}

const creationReceiptName = (receipt: Pick<CreationReceipt, "kind" | "sessionId" | "path">): string =>
  `${receipt.kind}-${receipt.sessionId.replaceAll("-", "")}-${basename(receipt.path)}.json`;

const validReceipt = (value: unknown, root: string, anchor = root): value is CreationReceipt => {
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
    const path = resolve(item.path);
    return isolateWorktreePaths(root, item.sessionId, anchor).some((candidate) => resolve(candidate) === path)
      && item.branch === isolateBranchName(item.sessionId);
  }
  const parent = resolve(dirname(item.path));
  return item.branch === undefined
    && integrationFolders(root, anchor).some((folder) => resolve(folder) === parent)
    && new RegExp(`^${shortId(item.sessionId)}-[0-9a-z-]+$`).test(basename(item.path));
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
    ...(typeof parsed.retargetedFrom === "string" ? { retargetedFrom: parsed.retargetedFrom } : {}),
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
  /** The `<repo>-polyth-isolate` / `-polyth-integrate` folders exist only to
   * hold managed checkouts. Drop the folder with its last checkout; a
   * non-empty or already-missing folder is left alone. A concurrent create
   * is unaffected: Git recreates leading directories itself. */
  const removeEmptyFolder = async (folder: string): Promise<void> => {
    if (!folder.endsWith(ISOLATE_DIR_SUFFIX) && !folder.endsWith(INTEGRATE_DIR_SUFFIX)) return;
    await rmdir(folder).catch(() => undefined);
  };
  const removeEmptyParent = (path: string): Promise<void> => removeEmptyFolder(dirname(resolve(path)));
  const prepareParent = async (path: string) => {
    const parent = dirname(path);
    await mkdir(parent, { recursive: true });
    if (!samePath(await realpath(parent), parent)) {
      throw invalid("managed workspace parent must use its canonical filesystem path; reopen the project through its real path");
    }
    await access(parent, constants.W_OK);
  };
  const unwritable = (error: unknown): boolean => {
    const code = (error as { code?: unknown })?.code;
    return code === "EACCES" || code === "EPERM" || code === "EROFS";
  };
  /** Prepare the first candidate whose parent Polyth may write. Only a
   * permission/read-only refusal moves on; an aliased parent still fails. */
  const allocate = async (candidates: string[]): Promise<string> => {
    let refusal: unknown;
    for (const candidate of candidates) {
      try {
        await prepareParent(candidate);
        return candidate;
      } catch (error) {
        if (!unwritable(error)) throw error;
        refusal ??= error;
      }
    }
    throw refusal;
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

  /** The checkout was deleted outside Polyth (its folder removed, or `git
   * worktree remove`). Drop Git's stale entry and the managed branch it left,
   * but only a branch that holds nothing unique: its tip is the recorded base
   * or already reached the target branch. A branch with commits of its own is
   * the session's only copy of that work and stays. */
  const releaseVanishedBranch = async (root: string, ref: OwnedWorktreeRef): Promise<void> => {
    if (!isManagedBranch(ref.worktreeBranch) || ref.worktreeBranch !== isolateBranchName(ref.sessionId)) return;
    await git.worktrees.prune(root).catch(() => undefined);
    const head = await git.revParse(root, `refs/heads/${ref.worktreeBranch}`).catch(() => undefined);
    if (!head) return;
    const listed = await git.worktrees.list(root).catch(() => undefined);
    if (!listed || listed.some((item) => item.branch === ref.worktreeBranch)) return;
    const target = ref.targetBranch
      ? await git.revParse(root, ref.targetBranch).catch(() => undefined)
      : undefined;
    const holdsNothing = head === ref.baseCommit
      || (target !== undefined && await git.isAncestor(root, head, target).catch(() => false));
    if (!holdsNothing) {
      log("cleanup-branch-kept", { sessionId: ref.sessionId, branch: ref.worktreeBranch, reason: "unmerged-commits" });
      return;
    }
    if (await git.deleteRef(root, `refs/heads/${ref.worktreeBranch}`, head)) {
      log("cleanup", { sessionId: ref.sessionId, worktreePath: ref.worktreePath, branch: ref.worktreeBranch, kind: "vanished" });
    }
  };

  const inspectOwned = async (root: string, ref: OwnedWorktreeRef): Promise<OwnedWorktreeInspection> => {
    const expectedBranch = isolateBranchName(ref.sessionId);
    const anchor = await placementAnchor(git, root);
    if (ref.worktreeBranch !== expectedBranch || !isManagedBranch(ref.worktreeBranch)
      || !isolateWorktreePaths(root, ref.sessionId, anchor).some((candidate) => samePath(ref.worktreePath, candidate))) {
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
      || (ref.targetBranch !== undefined && marker.targetBranch !== ref.targetBranch
        && marker.retargetedFrom !== ref.targetBranch)) {
      return { status: "unowned", reason: "target-mismatch" };
    }
    if ((ref.baseCommit !== undefined && marker.baseCommit !== ref.baseCommit)
      || !(await git.isAncestor(root, marker.baseCommit, listed.head))) {
      return { status: "unowned", reason: "base-mismatch" };
    }
    return { status: "owned", worktree: { path: listed.path, branch: listed.branch, head: listed.head, meta: marker } };
  };

  /** Claim a planned creation. A receipt left by a create that crashed before
   * Git made anything is released by recovery once it is past the age floor;
   * try that once before reporting the path as busy. */
  const claimPlanned = async (planned: CreationReceipt): Promise<string> => {
    try {
      return await writeCreationReceipt(git, planned);
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "conflict") throw error;
      await service.recoverCreations(planned.root);
      return writeCreationReceipt(git, planned);
    }
  };

  const service = {
    isManagedBranch,
    isolateBranchName,
    isolateWorktreePath,
    inspectOwned,

    /** Record a new merge target in an owned checkout's marker, keeping the
     *  previous one as `retargetedFrom`. Ownership is proven first against
     *  the current target; the write is an atomic rename. */
    async retarget(root: string, ref: OwnedWorktreeRef & { targetBranch: string }, targetBranch: string): Promise<void> {
      const inspection = await inspectOwned(root, ref);
      if (inspection.status !== "owned") {
        throw Object.assign(new Error(`refusing to retarget an isolated workspace whose ownership is not proven (${inspection.status === "unowned" ? inspection.reason : "missing"})`), { code: "conflict" });
      }
      const { retargetedFrom: _previous, ...meta } = inspection.worktree.meta;
      await writeMarker(git, inspection.worktree.path, {
        ...meta,
        kind: "isolate",
        targetBranch,
        ...(ref.targetBranch !== targetBranch ? { retargetedFrom: ref.targetBranch } : {}),
      });
      log("retargeted", { sessionId: ref.sessionId, from: ref.targetBranch, to: targetBranch });
    },

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
      /** A delegated child may branch from, and merge back into, its parent's
       *  managed checkout. The caller proves that ownership chain first. */
      nested?: boolean;
    }): Promise<ManagedWorktree> {
      if (!input.nested && isManagedBranch(input.targetBranch.replace(/^refs\/heads\//, ""))) throw invalid("nested isolation is unsupported");
      const branch = isolateBranchName(input.sessionId);
      const anchor = await placementAnchor(git, input.root);
      const path = await allocate(allocationFolders(input.root, ISOLATE_DIR_SUFFIX, anchor)
        .map((folder) => join(folder, shortId(input.sessionId))));
      const start = input.base ?? input.targetBranch;
      const expectedHead = await git.revParse(input.root, start);
      const occupied = async (): Promise<boolean> =>
        (await git.worktrees.list(input.root)).some((item) => resolve(item.path) === resolve(path))
        || await git.revParse(input.root, branch).then(() => true).catch(() => false)
        || existsSync(path);
      const conflict = () => Object.assign(new Error("managed workspace path already exists or its branch already exists"), { code: "conflict" });
      if (await occupied()) throw conflict();
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
      const receipt = await claimPlanned(planned);
      // A create that won the claim just before this one has already finished
      // and released it: its checkout is now in place, so look again.
      if (await occupied()) {
        await rm(receipt, { force: true });
        throw conflict();
      }
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
        // Ownership is established; inherited links are ignored conveniences
        // that leave with the worktree, so a failure here never fails create.
        // The checkout mirrors the whole worktree that contains the target, so
        // inherit from that worktree's root, not from a project subdirectory.
        const inheritFrom = samePath(input.targetPath, input.root) ? anchor : input.targetPath;
        await inheritCheckoutEnvironment(inheritFrom, created.path).then((inherited) => {
          if (inherited.links) {
            log("inherited", {
              sessionId: input.sessionId,
              links: inherited.links,
              dependencyFolders: inherited.dependencyFolders.join(","),
              files: inherited.files.length,
            });
          }
        }, (error: unknown) => {
          log("inherit-failed", {
            sessionId: input.sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
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
      const anchor = await placementAnchor(git, input.root);
      const path = await allocate(allocationFolders(input.root, INTEGRATE_DIR_SUFFIX, anchor)
        .map((folder) => integrationWorktreePath(input.root, input.sessionId, folder)));
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
      const receipt = await claimPlanned(planned);
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
      if (inspection.status === "missing") {
        await releaseVanishedBranch(root, ref);
        return { status: "already-gone" };
      }
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
      await removeEmptyParent(inspection.worktree.path);
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
      if (validReceipt(receipt, root, await placementAnchor(git, root))
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
      const prefix = owner ? `${shortId(owner)}-` : "";
      if (
        !marker
        || marker === "corrupt"
        || marker.kind !== "integration"
        || (sessionId !== undefined && marker.sessionId !== sessionId)
        || listed.isMain
        || listed.branch !== null
        || !owner
        || !integrationFolders(root, await placementAnchor(git, root)).some((folder) => samePath(dirname(integrationPath), folder))
        || !basename(integrationPath).startsWith(prefix)
        || !samePath(await realpath(integrationPath), integrationPath)
      ) {
        throw Object.assign(new Error("refusing to delete an unowned integration workspace whose ownership is not proven"), {
          code: "conflict",
        });
      }
      await git.worktrees.remove(root, { path: integrationPath, deleteBranch: false, force: true });
      await git.worktrees.prune(root);
      await removeEmptyParent(integrationPath);
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
      const anchor = names.length ? await placementAnchor(git, root) : root;
      let recovered = 0;
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        const file = join(directory, name);
        let receipt: CreationReceipt;
        try {
          const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
          if (!validReceipt(parsed, root, anchor)) continue;
          receipt = parsed;
          if (name !== creationReceiptName(receipt)) continue;
        } catch {
          continue;
        }
        const listed = (await git.worktrees.list(root))
          .find((item) => resolve(item.path) === resolve(receipt.path));
        if (!listed) {
          if (receipt.phase !== "created") {
            // A planned intent whose create never produced a checkout or a
            // branch has nothing left to reconcile. The age floor keeps a
            // create that is still in flight from losing its receipt.
            const age = Date.now() - (await stat(file).then((info) => info.mtimeMs, () => Date.now()));
            if (age < STALE_PLANNED_RECEIPT_MS || existsSync(receipt.path)) continue;
            if (receipt.branch && await git.revParse(root, receipt.branch).then(() => true, () => false)) continue;
            await rm(file, { force: true });
            recovered += 1;
            log("creation-receipt-released", { sessionId: receipt.sessionId, worktreePath: receipt.path, kind: receipt.kind });
            continue;
          }
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
        // Planned intent is not proof that Git completed resource creation:
        // within the age floor the create may still be running. Past it, a
        // create that died between `git worktree add` and its creation token
        // left this checkout at the receipt's exact managed path, with no
        // marker, on the planned branch and start commit. Planned receipts are
        // exclusive per path, so no other create can own it; remove it only
        // while it still holds nothing beyond that start commit.
        if (receipt.phase !== "created") {
          const age = Date.now() - (await stat(file).then((info) => info.mtimeMs, () => Date.now()));
          if (age < STALE_PLANNED_RECEIPT_MS || marker !== null) continue;
          if (listed.isMain
            || listed.head !== receipt.expectedHead
            || (receipt.kind === "isolate" ? listed.branch !== receipt.branch : listed.branch !== null)
            || !samePath(await realpath(listed.path).catch(() => ""), listed.path)
            || await git.hasUniqueChanges(listed.path, receipt.expectedHead)) continue;
          await git.worktrees.remove(root, { path: listed.path, deleteBranch: false, force: true });
          if (receipt.branch && !await git.deleteRef(root, `refs/heads/${receipt.branch}`, receipt.expectedHead)) continue;
          await git.worktrees.prune(root);
          await rm(file, { force: true });
          await removeEmptyParent(listed.path);
          recovered += 1;
          log("creation-recovered", { sessionId: receipt.sessionId, worktreePath: receipt.path, kind: receipt.kind, phase: "planned" });
          continue;
        }
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

    /** Remove this repository's managed parent folders when they are empty. */
    async pruneEmptyParents(root: string): Promise<void> {
      const anchor = await placementAnchor(git, root);
      for (const folder of [...acceptedFolders(root, ISOLATE_DIR_SUFFIX, anchor), ...integrationFolders(root, anchor)]) {
        await removeEmptyFolder(folder);
      }
    },
  };
  return service;
}

export type ManagedWorktreeService = ReturnType<typeof createManagedWorktrees>;
