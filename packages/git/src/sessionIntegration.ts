// Session isolation lifecycle. Git details stay in managedWorktrees; this
// module owns session-level state, publication durability, and recovery.
//
// Invariants (enforced, not documentary):
// - one origin: repo + local targetBranch + originPath checkout + baseCommit;
//   targetBranch/originPath change only by an explicit at-rest retarget to
//   another checked-out branch, before any publication intent exists
// - after merge/discard, session.branch, cwd, runtime cwd, and checked-out branch agree
// - a result commit is never published twice
// - destructive cleanup runs only after rebind durably reaches cleanup-pending
//   AND the session workspace is the origin checkout — never "not source anymore"
// - user-owned worktrees are never deleted (session-specific marker + branch prefix)
// - one mutating lifecycle op per session; one ref publication per repo+branch
// - GET status is observational; recovery is a write path
// - integration worktrees are pruned only for that session
// - target updates use expected-old-SHA / ff-only
// - conflicts happen in a detached integration worktree, never the user checkout
// - restart never treats ambiguous irreversible work as "not done"
// - after publication, failures are finalization-pending, not "merge failed"
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreateIsolatedSessionInput,
  CreateSessionInput,
  DelegatedIsolationDto,
  IsolationMergeResultDto,
  IsolationPublishIntent,
  IsolationPushResultDto,
  IsolationStatusDto,
  IsolationSuggestionDto,
  IsolationTargetDto,
  IsolationTargetPushDto,
  IsolationTargetRepair,
  IsolateSessionResultDto,
  JsonObject,
  SessionEvent,
  SessionIsolation,
  IsolationState,
  SessionProjection,
  SessionDebugDto,
  SessionRef,
  SessionWorkspace,
} from "@polyth/contracts";
import {
  isolationBlocksUserMutation,
  isolationRuntimeUnsettled,
  isolationNeedsRecovery,
  normalizeIsolation as normalizeIsolationContract,
  SESSION_PURPOSE_CONVERSATION,
  transitionIsolation as transitionIsolationContract,
} from "@polyth/contracts";
import { projectRepositories, resolveWorkspaceContext, workspaceExecutionPath } from "@polyth/contracts/workspace";
import type {
  ServerDelegatedMergeResult,
  ServerDelegatedSessionCreated,
  ServerDelegatedSessionInput,
} from "@polyth/plugins";
import { buildLocalConflictResolutionPrompt, type GitMergeConflicts, type GitService } from "./index.ts";
import type { GitActor } from "./actingPerson.ts";
import { currentGitCommitIdentity } from "./sourceControlAccounts.ts";
import {
  createManagedWorktrees,
  isolateBranchName,
  isManagedBranch,
  readManagedMarker,
  type ManagedWorktreeService,
} from "./managedWorktrees.ts";
import {
  isolationWorkspaceRows,
  selectIsolationRepositories,
  workspaceForIsolationAllocations,
  type IsolationAllocation,
  type IsolationRepositoryProject,
} from "./workspaceIsolation.ts";

const MAX_PUBLISH_RETRIES = 8;
const SNAPSHOT_MESSAGE = "polyth: snapshot isolated workspace";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPAIR_REF_PREFIX = "refs/polyth/isolation-repair/";
const RECEIPT_REF_PREFIX = "refs/polyth/isolation/";
const MAX_REPAIR_FILES = 200;
const USER_OPS = {
  keep: new Set<IsolationState>(["active", "merge-ready", "conflict"]),
  merge: new Set<IsolationState>(["active", "merge-ready", "conflict"]),
  resolve: new Set<IsolationState>(["conflict"]),
  discard: new Set<IsolationState>(["active", "merge-ready", "conflict", "missing"]),
} as const;

const NO_ACTIONS = {
  canReview: false,
  canMerge: false,
  canKeep: false,
  canResolve: false,
  canDiscard: false,
  canRecover: false,
  canAbandon: false,
} as const;

export const isolationLog = (event: string, data: JsonObject): void => {
  console.log(`[polyth] isolation ${event} ${JSON.stringify(data)}`);
};

export interface IsolationSessionApi {
  create(input: CreateSessionInput): Promise<SessionRef>;
  snapshot(sessionId: string): Promise<SessionProjection>;
  list(projectId?: string): Promise<SessionProjection[]>;
  debug?(sessionId: string): Promise<SessionDebugDto>;
  send(sessionId: string, input: { text: string; githubConflictResolution?: boolean }): Promise<unknown>;
  patchIsolation?(sessionId: string, isolation: SessionIsolation | null): Promise<SessionProjection>;
  rebindWorkspace?(sessionId: string, input: {
    executionRepositoryId?: string;
    workspace?: SessionWorkspace;
    expectedWorkspaceRevision?: number;
    worktreePath?: string | null;
    branch?: string | null;
    isolation?: SessionIsolation | null;
    relocateManagedCheckout?: boolean;
  }): Promise<SessionProjection>;
  patchWorkspace?(sessionId: string, workspace: SessionProjection["workspace"], expectedRevision?: number): Promise<SessionProjection>;
  withWorkspaceMutation?<T>(sessionId: string, expectedRevision: number, mutate: (scope: {
    snapshot(): Promise<SessionProjection>;
    commit(workspace: SessionWorkspace, scalar?: { worktreePath?: string | null; branch?: string | null; isolation?: SessionIsolation | null }): Promise<SessionProjection>;
  }) => Promise<T>): Promise<T>;
}

export interface IsolationProjectApi {
  get(id: string): Promise<IsolationRepositoryProject | undefined>;
  list?: () => Promise<IsolationRepositoryProject[]>;
}

export interface IsolationTestHooks {
  beforePublish?: () => Promise<void>;
  afterPublish?: () => Promise<void>;
  afterIntegrationCreated?: (sessionId: string) => Promise<void>;
  beforeCleanup?: () => Promise<void>;
}

export interface IsolationIntegrationDeps {
  git: GitService;
  generateCommitMessage?: (session: SessionProjection, root: string) => Promise<string>;
  /** How long integration waits for a generated message before it commits
   *  with the deterministic fallback. Defaults to COMMIT_MESSAGE_WAIT_MS. */
  commitMessageWaitMs?: number;
  managed?: ManagedWorktreeService;
  sessions: IsolationSessionApi;
  projects: IsolationProjectApi;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  /** Durable events consulted for the session's last completed turn. Only
   *  the newest `turn/stopped` fact is read from them. */
  readEvents?: (sessionId: string) => Promise<SessionEvent[]>;
  /** The newest durable `turn/stopped` fact, from an indexed read. Preferred
   *  over `readEvents`: a status read must not load a whole long log. */
  latestTurnStop?: (sessionId: string) => Promise<SessionEvent | undefined>;
  /** The newest durable event of `type`, from an indexed read. Orders a
   *  conflict recorded before conflicts carried a time against the turns. */
  latestEvent?: (sessionId: string, type: string) => Promise<SessionEvent | undefined>;
  closeWorkspaceProcesses?: (cwd: string) => Promise<void>;
  /** Carry the session-lifetime chat media the canonical history of
   *  `sessionIds` references from the released checkout into the destination
   *  checkout, before the worktree is deleted. Chat images are
   *  project-relative paths resolved against the session's current execution
   *  root, so an untracked file that only lived in the worktree would
   *  otherwise 404 after the merge. `ignored` supplies the destination's
   *  Git-ignore set in one batch: only ignored files are copied, because Git
   *  itself carries a non-ignored untracked file on merge and a discard must
   *  not leave one behind. Best effort and bounded: it must never block
   *  cleanup or lose isolation evidence. Absent: preservation is skipped. */
  preserveSessionMedia?: (input: {
    sessionIds: readonly string[];
    projectId: string;
    sourceRoot: string;
    destinationRoot: string;
    ignored?(paths: readonly string[]): Promise<readonly string[]>;
  }) => Promise<{
    copied: readonly string[];
    skipped: readonly string[];
    missing: readonly string[];
    notIgnored: readonly string[];
  }>;
  /** Run Git work done for `session` as its acting person (Spaces §14.4):
   *  their commit identity and, with `transport`, their credentials for that
   *  remote. Refuses (nothing started) when that person cannot be resolved.
   *  Absent: the checkout's own Git configuration and helpers. */
  actingGit?: <T>(input: {
    session: SessionProjection;
    /** The person who asked (UI), when there is one. */
    requester?: GitActor;
    transport?: { root: string; remote: string };
  }, fn: () => Promise<T>) => Promise<T>;
  testHooks?: IsolationTestHooks;
}

/** The one structural media seam, so the composition root does not restate it. */
export type PreserveSessionMedia = NonNullable<IsolationIntegrationDeps["preserveSessionMedia"]>;

/** Whoever asked for a new isolated chat: its creator and owner. */
export type IsolationRequesterSessions = Pick<IsolationSessionApi, "create" | "snapshot">;

/** Whoever asked to isolate an existing chat: reads and rebinds it with their
 *  own Space scope and management rights. */
export type IsolationExistingSessions = Pick<IsolationSessionApi, "snapshot" | "rebindWorkspace">;

/** Where the isolated work (`source`, its HEAD plus uncommitted edits) and
 *  the current target branch overlap now. `recorded` is what the last merge
 *  attempt reported; the preview is recomputed from the live branches. */
export interface IsolationConflictPreview extends GitMergeConflicts {
  targetBranch: string;
  recorded: string[];
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Mark a merge failure that provably left the target branch untouched. The
 *  HTTP layer treats any other untagged mutation failure as outcome-unknown,
 *  which hides the real reason behind "The result is not confirmed" and tells
 *  the user not to retry a merge that is safe to retry. Explicit tags win. */
const unpublished = (error: unknown): unknown => {
  if (error && typeof error === "object" && !("mutationOutcome" in error)) {
    Object.assign(error, { mutationOutcome: "rejected", retryability: "safe" });
  }
  return error;
};

/** A generated commit message is a nicety. Integration holds the branch lock
 *  while it waits, so a slow or unavailable small model must never block or
 *  fail the merge itself. */
const COMMIT_MESSAGE_WAIT_MS = 12_000;

const repairRef = (sessionId: string): string => `${REPAIR_REF_PREFIX}${sessionId}`;
const receiptRefName = (sessionId: string): string => `${RECEIPT_REF_PREFIX}${sessionId}`;

const repairFiles = (status: {
  staged: readonly { path: string }[];
  unstaged: readonly { path: string }[];
  untracked: readonly { path: string }[];
  conflicted: readonly { path: string }[];
}): string[] => [...new Set([
  ...status.staged.map((file) => file.path),
  ...status.unstaged.map((file) => file.path),
  ...status.untracked.map((file) => file.path),
  ...status.conflicted.map((file) => file.path),
])].sort().slice(0, MAX_REPAIR_FILES);

const filesystemPathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
};

export function createKeyedLock() {
  const locks = new Map<string, Promise<void>>();
  const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    locks.set(key, held);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === held) locks.delete(key);
    }
  };
  return { withLock, size: () => locks.size };
}

const lastCompletedTurn = (events: readonly SessionEvent[]): SessionEvent | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "turn/stopped") return event;
  }
  return undefined;
};

const completedReason = (event: SessionEvent | undefined): boolean =>
  event?.type === "turn/stopped"
  && (event.data as { reason?: unknown } | null | undefined)?.reason === "completed";

/** The notice a failed merge appends right after it records the conflict. */
const CONFLICT_NOTICE = "isolation/conflict";

/** A conflict is settled only by a turn that completed after it was found:
 *  the turn that ended before the merge attempt is what conflicted. Records
 *  without a time are ordered by their notice; with neither, the newest
 *  completed turn is the only evidence there is. */
const turnCompletedAfterConflict = (isolation: SessionIsolation, events: readonly SessionEvent[]): boolean => {
  const stopped = lastCompletedTurn(events);
  if (!completedReason(stopped)) return false;
  const at = isolation.conflict?.at;
  if (typeof at === "number") return stopped!.time > at;
  const notice = events.findLast((event) => event.type === CONFLICT_NOTICE);
  return notice === undefined || stopped!.seq > notice.seq;
};

const isolationOf = (session: SessionProjection): SessionIsolation | null => {
  const value = session.isolation;
  if (!value || typeof value !== "object" || value.kind !== "git-worktree") return null;
  return normalizeIsolationContract(value);
};

const withoutTargetRepair = (isolation: SessionIsolation): SessionIsolation => {
  const { targetRepair: _targetRepair, ...rest } = isolation;
  return rest as SessionIsolation;
};

const targetRefName = (branch: string): string =>
  branch.startsWith("refs/") ? branch : `refs/heads/${branch.replace(/^refs\/heads\//, "")}`;

const localBranchName = (branch: string): string =>
  branch.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");

const samePath = (a: string, b: string): boolean => resolve(a) === resolve(b);

const shortSha = (sha: string): string => sha.slice(0, 7);

type IsolationTransition = (
  | { phase: "active" | "merge-ready" | "missing" | "unowned" | "corrupt"; dismissedRevision?: string }
  | { phase: "conflict"; conflict: { message: string; files: string[] } }
  | { phase: "publishing"; publish: IsolationPublishIntent }
  | { phase: "rebind-pending" | "cleanup-pending"; resultCommit?: string; sourceSnapshotSha?: string }
) & { targetRepair?: IsolationTargetRepair };

/** Adapter for the package's phase vocabulary. The contracts helper is the
 * only constructor for newly persisted lifecycle states. */
const transitionIsolation = (
  isolation: SessionIsolation,
  transition: IsolationTransition,
): SessionIsolation => {
  const repair = transition.targetRepair;
  if (transition.phase === "conflict") {
    return transitionIsolationContract(isolation, {
      state: "conflict",
      conflict: { ...transition.conflict, at: Date.now() },
      ...(repair ? { targetRepair: repair } : {}),
    });
  }
  if (transition.phase === "publishing") {
    return transitionIsolationContract(isolation, {
      state: "publishing",
      publish: transition.publish,
      ...(repair ? { targetRepair: repair } : {}),
    });
  }
  if (transition.phase === "rebind-pending" || transition.phase === "cleanup-pending") {
    return transitionIsolationContract(isolation, {
      state: transition.phase,
      ...(transition.resultCommit ? { resultCommit: transition.resultCommit } : {}),
      ...(transition.sourceSnapshotSha ? { sourceSnapshotSha: transition.sourceSnapshotSha } : {}),
      ...(repair ? { targetRepair: repair } : {}),
    });
  }
  return transitionIsolationContract(isolation, {
    state: transition.phase,
    ...("dismissedRevision" in transition && transition.dismissedRevision
      ? { dismissedRevision: transition.dismissedRevision }
      : {}),
    ...(repair ? { targetRepair: repair } : {}),
  });
};

const sessionLocks = createKeyedLock();
const branchLocks = createKeyedLock();

export const withBranchLock = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
  branchLocks.withLock(key, fn);

export const branchLockSize = (): number => branchLocks.size();

const publishedResult = (
  isolation: SessionIsolation,
  session: SessionProjection,
): IsolationMergeResultDto => ({
  ok: true,
  commit: isolation.resultCommit ?? isolation.publish?.resultCommit ?? "",
  targetBranch: isolation.targetBranch,
  session,
  finalized: !isolationOf(session),
});

export function createIsolationService(deps: IsolationIntegrationDeps) {
  const git = deps.git;
  const managed = deps.managed ?? createManagedWorktrees(git);
  /** The durable facts `suggestionFor` needs: the newest `turn/stopped`, and
   *  for a conflict recorded without a time, its notice to order it by. */
  const readTurnFacts = async (sessionId: string, isolation?: SessionIsolation): Promise<SessionEvent[] | undefined> => {
    if (deps.latestTurnStop) {
      const untimedConflict = isolation?.state === "conflict" && typeof isolation.conflict?.at !== "number";
      const [stop, notice] = await Promise.all([
        deps.latestTurnStop(sessionId),
        untimedConflict && deps.latestEvent ? deps.latestEvent(sessionId, CONFLICT_NOTICE) : undefined,
      ]);
      return [notice, stop].filter((event): event is SessionEvent => event !== undefined)
        .sort((a, b) => a.seq - b.seq);
    }
    return deps.readEvents?.(sessionId);
  };
  const readsTurnFacts = Boolean(deps.latestTurnStop || deps.readEvents);

  const acting = <T>(
    session: SessionProjection,
    requester: GitActor | undefined,
    fn: () => Promise<T>,
    transport?: { root: string; remote: string },
  ): Promise<T> => deps.actingGit
    ? deps.actingGit({ session, ...(requester ? { requester } : {}), ...(transport ? { transport } : {}) }, fn)
    : fn();
  /** The acting person's identity inside `acting`, else the checkout's own. */
  const commitIdentityFor = async (root: string) => currentGitCommitIdentity() ?? await git.identity(root);

  const persist = async (sessionId: string, isolation: SessionIsolation | null): Promise<SessionProjection> => {
    if (!deps.sessions.patchIsolation) throw err("unsupported", "session isolation persistence is unavailable");
    return deps.sessions.patchIsolation(sessionId, isolation);
  };

  const projectOf = async (projectId: string) => {
    const project = await deps.projects.get(projectId);
    if (!project) throw err("not-found", "unknown project");
    return project;
  };

  /** Managed checkouts are created by this server's Git, next to the
   *  repository on this machine. A remote project's path lives on its SSH
   *  host, where its sessions run: a checkout made here would be the wrong
   *  repository (or none), so isolation is refused before anything starts. */
  const assertLocalProject = (project: IsolationRepositoryProject): void => {
    if (project.remote) throw err("unsupported", "isolated workspaces are only available for projects on this server, not for remote projects");
  };

  const assertOp = (state: IsolationState, op: keyof typeof USER_OPS) => {
    if (!USER_OPS[op].has(state)) {
      throw err("conflict", `isolation cannot ${op} from ${state}`);
    }
  };

  const assertNotBusy = (session: SessionProjection) => {
    if (isolationBlocksUserMutation(session.status)) {
      throw err("conflict", "session is still running");
    }
  };

  const withSession = async <T>(sessionId: string, fn: () => Promise<T>): Promise<T> =>
    sessionLocks.withLock(sessionId, fn);

  const load = async (sessionId: string): Promise<{ session: SessionProjection; isolation: SessionIsolation }> => {
    const session = await deps.sessions.snapshot(sessionId);
    const isolation = isolationOf(session);
    if (!isolation) throw err("invalid-input", "session is not isolated");
    if (isolationWorkspaceRows(session).length > 1) {
      throw err("unsupported", "multi-repository isolation requires an explicit per-repository lifecycle operation");
    }
    return { session, isolation };
  };

  const resolveOriginForRepository = async (
    project: IsolationRepositoryProject,
    repository: { id: string; path: string },
    input: CreateIsolatedSessionInput,
    source?: SessionProjection,
    requestedBranch?: string,
  ): Promise<{ branch: string; originPath: string; head: string; startPoint: string; sourceSessionId?: string }> => {
    const list = await git.worktrees.list(repository.path);
    const requested = requestedBranch?.trim();
    if (requested?.startsWith("origin/") || requested?.startsWith("refs/remotes/")) {
      throw err("invalid-input", "Work in isolation needs a local checkout of that branch. Check it out first.");
    }
    const wanted = requested ? localBranchName(requested) : undefined;
    if (wanted && isManagedBranch(wanted)) {
      throw err("invalid-input", "managed isolation branches cannot be used as an origin");
    }
    const sourceRow = source?.workspace?.repositories.find((row) => row.repositoryId === repository.id);
    if (source?.isolation || sourceRow?.isolation) {
      throw err("invalid-input", "nested session isolation is not supported");
    }
    const sourcePath = sourceRow?.path
      ?? (source && (repository.id === "primary" || repository.path === project.path)
        ? source.worktreePath ?? project.path
        : undefined);
    const fromPath = sourcePath
      ? list.find((item) => samePath(item.path, sourcePath))
      : undefined;
    const fromBranch = wanted
      ? list.find((item) => item.branch === wanted)
      : fromPath;
    const checkout = fromBranch ?? fromPath ?? list.find((item) => item.isMain) ?? list[0];
    if (!checkout?.branch) throw err("invalid-input", "Work in isolation needs a checkout of a local branch.");
    if (isManagedBranch(checkout.branch)) throw err("invalid-input", "managed isolation branches cannot be used as an origin");
    if (wanted && checkout.branch !== wanted) {
      throw err("invalid-input", `Work in isolation needs a checkout of ${wanted}.`);
    }
    const originPath = resolve(checkout.path);
    const head = await git.revParse(originPath, "HEAD");
    return {
      branch: checkout.branch,
      originPath,
      head,
      startPoint: checkout.branch,
      ...(source && sourcePath && samePath(resolve(sourcePath), originPath) ? { sourceSessionId: source.id } : {}),
    };
  };

  /** The parent itself plus its recorded ancestors (bounded, cycle-safe). */
  const lineageOf = async (session: SessionProjection): Promise<Set<string>> => {
    const ids = new Set<string>([session.id]);
    let parentId = session.parentId;
    while (parentId && !ids.has(parentId) && ids.size < 64) {
      ids.add(parentId);
      parentId = (await deps.sessions.snapshot(parentId).catch(() => undefined))?.parentId;
    }
    return ids;
  };

  /** A delegated child branches from — and later merges back into — exactly
   * the checkout its parent executes in. When that checkout is a managed
   * isolation, it must belong to the parent or one of its ancestors, prove
   * ownership, and still be open for work; the child then targets that
   * managed branch (nested isolation). */
  const resolveDelegatedOrigin = async (
    project: IsolationRepositoryProject,
    repository: { id: string; path: string },
    parent: SessionProjection,
    /** The session isolates itself from this, its own resolved checkout. */
    self?: { path: string },
  ): Promise<{ branch: string; originPath: string; head: string; startPoint: string; nested: boolean }> => {
    const parentRow = parent.workspace?.repositories.find((row) => row.repositoryId === repository.id);
    if (!self && parentRow?.state === "missing") {
      throw err("conflict", "the delegating session's checkout is missing");
    }
    const sourcePath = self?.path ?? parentRow?.path ?? parent.worktreePath ?? project.path;
    const checkout = (await git.worktrees.list(repository.path)).find((item) => samePath(item.path, sourcePath));
    if (!checkout?.branch) {
      throw err("invalid-input", self
        ? "Work in isolation needs the session on a checkout of a local branch."
        : "An isolated agent needs its parent on a checkout of a local branch.");
    }
    const originPath = resolve(checkout.path);
    const head = await git.revParse(originPath, "HEAD");
    if (!isManagedBranch(checkout.branch)) {
      return { branch: checkout.branch, originPath, head, startPoint: head, nested: false };
    }
    const lineage = await lineageOf(parent);
    const owner = (await deps.sessions.list(parent.projectId)).find((candidate) =>
      isolationWorkspaceRows(candidate).some((row) => samePath(row.isolation.worktreePath, originPath)
        && row.isolation.worktreeBranch === checkout.branch));
    if (!owner || !lineage.has(owner.id)) {
      throw err("conflict", "the parent's managed checkout does not belong to the parent or its ancestors");
    }
    const ownerRow = isolationWorkspaceRows(owner).find((row) => samePath(row.isolation.worktreePath, originPath))!;
    const ownerIsolation = normalizeIsolationContract(ownerRow.isolation);
    if (ownerIsolation.state !== "active" && ownerIsolation.state !== "merge-ready" && ownerIsolation.state !== "conflict") {
      throw err("conflict", `the parent's isolated checkout is ${ownerIsolation.state}; finish that before delegating into it`);
    }
    const ownership = await inspectSource(owner.id, ownerIsolation);
    if (ownership.status !== "owned") {
      throw err("conflict", "the parent's isolated checkout ownership is not proven");
    }
    return { branch: checkout.branch, originPath, head, startPoint: head, nested: true };
  };

  const checkoutMatchesTarget = async (
    path: string,
    branch: string,
    isolation: SessionIsolation,
  ): Promise<boolean> => {
    if (!existsSync(path)) return false;
    try {
      if ((await git.branches(path)).current !== branch) return false;
      return samePath(await git.commonDir(path), await git.commonDir(isolation.targetPath));
    } catch {
      return false;
    }
  };

  const inspectTarget = async (isolation: SessionIsolation) => {
    const branch = localBranchName(isolation.targetBranch);
    const list = await git.worktrees.list(isolation.targetPath);
    const preferred = isolation.originPath
      ? list.find((item) => samePath(item.path, isolation.originPath!))
      : undefined;
    if (isolation.originPath && preferred?.branch !== branch) {
      throw err(
        "conflict",
        `origin workspace for ${isolation.targetBranch} is not checked out at ${isolation.originPath}`,
      );
    }
    // A recorded origin is immutable. Never silently publish through another
    // checkout if it disappears between admission and compare-and-swap.
    const checkout = isolation.originPath
      ? preferred ?? null
      : list.find((item) => item.branch === branch) ?? null;
    if (isolation.originPath && !checkout) {
      throw err(
        "conflict",
        `origin workspace for ${isolation.targetBranch} is not checked out at ${isolation.originPath}`,
      );
    }
    if (checkout && !await checkoutMatchesTarget(checkout.path, branch, isolation)) {
      throw err(
        "conflict",
        `origin workspace for ${isolation.targetBranch} is not the recorded repository checkout`,
      );
    }
    const liveHead = checkout
      ? await git.revParse(checkout.path, "HEAD")
      : await git.revParse(isolation.targetPath, branch);
    if (!checkout) return { checkout: null, dirty: false, liveHead, path: isolation.targetPath };
    const status = await git.status(checkout.path);
    return { checkout, dirty: !status.clean, liveHead, path: checkout.path };
  };

  const destinationFor = async (
    session: SessionProjection,
    isolation: SessionIsolation,
  ): Promise<{ path: string; isProjectRoot: boolean; branch: string }> => {
    const project = await projectOf(session.projectId);
    const projectRoot = resolve(project.path);
    const list = await git.worktrees.list(isolation.targetPath);
    const branch = localBranchName(isolation.targetBranch);
    if (isolation.originPath) {
      const origin = list.find((item) => samePath(item.path, isolation.originPath!));
      if (origin?.branch === branch
        && await checkoutMatchesTarget(origin.path, branch, isolation)) {
        return { path: resolve(origin.path), isProjectRoot: samePath(origin.path, projectRoot), branch };
      }
      // A durable discard has no publication to synchronize. Return to the
      // same recorded checkout even if its owner has since switched branches;
      // never switch that checkout back or use this fallback for a merge.
      if (!isolation.resultCommit && !isolation.publish
        && (isolation.state === "rebind-pending" || isolation.state === "cleanup-pending")
        && origin?.branch && !isManagedBranch(origin.branch)
        && await checkoutMatchesTarget(origin.path, origin.branch, isolation)) {
        return { path: resolve(origin.path), isProjectRoot: samePath(origin.path, projectRoot), branch: origin.branch };
      }
      throw err(
        "conflict",
        `origin workspace for ${isolation.targetBranch} is not checked out at ${isolation.originPath}`,
      );
    }
    const checkout = list.find((item) => item.branch === branch);
    if (!checkout || !await checkoutMatchesTarget(checkout.path, branch, isolation)) {
      throw err("conflict", `no checkout of ${isolation.targetBranch} to return this session to`);
    }
    return { path: resolve(checkout.path), isProjectRoot: samePath(checkout.path, projectRoot), branch };
  };

  /** Every ordinary local branch checked out in a checkout of this repository
   *  — what the work can be integrated into instead of the recorded target.
   *  One `git worktree list`: the per-checkout identity check runs only when a
   *  target is actually chosen. A delegated isolation (its target is a managed
   *  branch) and a pending AI target repair keep their recorded target. */
  const targetsFor = async (isolation: SessionIsolation): Promise<IsolationTargetDto[]> => {
    const recorded = localBranchName(isolation.targetBranch);
    if (isManagedBranch(recorded) || isolation.targetRepair) return [];
    const list = await git.worktrees.list(isolation.targetPath);
    const targets: IsolationTargetDto[] = [];
    for (const item of list) {
      if (!item.branch || isManagedBranch(item.branch) || samePath(item.path, isolation.worktreePath)) continue;
      if (!existsSync(item.path)) continue;
      const origin = !!isolation.originPath && samePath(item.path, isolation.originPath);
      targets.push({
        branch: item.branch,
        path: resolve(item.path),
        origin,
        current: item.branch === recorded && (isolation.originPath ? origin : true),
      });
    }
    return targets.sort((a, b) => Number(b.current) - Number(a.current)
      || Number(b.origin) - Number(a.origin)
      || a.branch.localeCompare(b.branch));
  };

  /** Point an at-rest isolation at another checked-out branch before merging.
   *  Everything is checked before anything is written; the new target
   *  replaces the old one durably (an earlier conflict or Keep-isolated
   *  dismissal was about the old target, so it is dropped). */
  const retargetAtRest = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    target: { branch: string; path: string },
  ): Promise<{ session: SessionProjection; isolation: SessionIsolation }> => {
    const branch = localBranchName(target.branch.trim());
    const path = resolve(target.path);
    if (branch === localBranchName(isolation.targetBranch)
      && (isolation.originPath ? samePath(path, isolation.originPath) : true)) {
      return { session, isolation };
    }
    if (isManagedBranch(localBranchName(isolation.targetBranch))) {
      throw unpublished(err("unsupported", "a delegated isolation integrates into the checkout it was delegated from"));
    }
    if (isolation.targetRepair) {
      throw unpublished(err("conflict", `finish the AI repair for ${isolation.targetBranch} before choosing another branch`));
    }
    if (!branch || isManagedBranch(branch)) {
      throw unpublished(err("invalid-input", "managed isolation branches cannot be a merge target"));
    }
    const checkout = (await git.worktrees.list(isolation.targetPath)).find((item) => samePath(item.path, path));
    if (!checkout || checkout.branch !== branch || samePath(path, isolation.worktreePath)
      || !await checkoutMatchesTarget(path, branch, isolation)) {
      throw unpublished(err("conflict", `${branch} is not checked out at ${path}`));
    }
    const targetHead = await git.revParse(path, "HEAD");
    if (!(await git.hasUniqueChanges(isolation.worktreePath, targetHead))) {
      throw unpublished(err("invalid-input", `No isolated changes to merge into ${branch}.`));
    }
    // The checkout's ownership marker names its target too. It is rewritten
    // first and keeps the old target as `retargetedFrom`, so ownership holds
    // whichever of the two writes a crash leaves behind.
    try {
      await managed.retarget(isolation.targetPath, ownedRef(session.id, isolation), branch);
    } catch (error) {
      throw unpublished(error);
    }
    const next = transitionIsolation({ ...isolation, targetBranch: branch, originPath: path }, { phase: "active" });
    const persisted = await persist(session.id, next);
    isolationLog("retargeted", {
      sessionId: session.id,
      from: isolation.targetBranch,
      to: branch,
      originPath: path,
    });
    // A changed target is an explicit fact of the chat's history, not a
    // silent substitution: whoever reads it later sees where the work goes.
    await notice(session.id, "isolation/retargeted", {
      fromBranch: isolation.targetBranch,
      targetBranch: branch,
    });
    return { session: persisted, isolation: isolationOf(persisted) ?? next };
  };

  /** Publish the target branch a merge just landed in, from the checkout it is
   *  checked out in, to its upstream remote (else `origin`) with the acting
   *  person's credentials. The merge already happened, so a refusal is
   *  reported, never thrown: the work stays merged and can be pushed again. */
  const pushTarget = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    requester: GitActor | undefined,
  ): Promise<IsolationTargetPushDto> => {
    const branch = localBranchName(isolation.targetBranch);
    let remote = "origin";
    try {
      const path = isolation.originPath ?? (await destinationFor(session, isolation)).path;
      const status = await git.status(path);
      remote = status.upstream?.split("/", 1)[0] || "origin";
      // Plain `push` publishes whatever is checked out, so the checkout must
      // still be on the branch that took the work.
      if (status.branch !== branch) {
        throw err("conflict", `${path} is no longer on ${branch}; push ${branch} from Source control`);
      }
      await acting(session, requester, () => git.push(path, remote), { root: path, remote });
      isolationLog("target-pushed", { sessionId: session.id, branch, remote });
      return { ok: true, remote, branch };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
      isolationLog("target-push-failed", { sessionId: session.id, branch, remote, message });
      return { ok: false, remote, branch, ...(code ? { code } : {}), message };
    }
  };

  const suggestionFor = async (
    session: SessionProjection,
    events?: readonly SessionEvent[],
  ): Promise<IsolationSuggestionDto | null> => {
    const isolation = isolationOf(session);
    if (!isolation) return null;
    const targetBranch = isolation.targetBranch;
    if (isolation.state === "missing") {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: false, revision: "", reason: "missing" };
    }
    if (isolation.state === "unowned" || isolation.state === "corrupt") {
      return {
        eligible: false,
        hasChanges: false,
        targetBranch,
        targetDirty: false,
        revision: "",
        reason: isolation.state,
      };
    }
    if (isolationNeedsRecovery(isolation.state)) {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: false, revision: "", reason: "merging" };
    }
    // A recovering runtime can last (an unconfirmed epoch step waits for
    // proof), so its read-only change check still runs: the card must say the
    // work is waiting instead of vanishing.
    const runtimeUnsettled = isolationRuntimeUnsettled(session.status);
    if (isolationBlocksUserMutation(session.status) && !runtimeUnsettled) {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: false, revision: "", reason: "working" };
    }
    const source = await inspectSource(session.id, isolation);
    if (source.status === "missing") {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: false, revision: "", reason: "missing" };
    }
    if (source.status === "unowned") {
      return {
        eligible: false,
        hasChanges: false,
        targetBranch,
        targetDirty: false,
        revision: "",
        reason: source.reason === "marker-corrupt" ? "corrupt" : "unowned",
      };
    }
    // Read-only Git work, so the independent reads run together; a status
    // read is on the path that shows "Changes ready" after every turn.
    const targetRead = inspectTarget(isolation).catch(() => null);
    const [revision, targetHead] = await Promise.all([
      git.fingerprint(isolation.worktreePath),
      git.revParse(isolation.targetPath, isolation.targetBranch).catch(() => isolation.baseCommit),
    ]);
    const [hasChanges, inspectedTarget] = await Promise.all([
      git.hasUniqueChanges(isolation.worktreePath, targetHead),
      targetRead,
    ]);
    const target = inspectedTarget ?? {
      dirty: true,
      liveHead: targetHead,
      checkout: null,
      path: isolation.targetPath,
    };
    if (runtimeUnsettled) {
      return { eligible: false, hasChanges, targetBranch, targetDirty: target.dirty, revision, reason: "runtime-recovering" };
    }
    if (!hasChanges) {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: target.dirty, revision, reason: "no-changes" };
    }
    if (isolation.dismissedRevision && isolation.dismissedRevision === revision) {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: target.dirty, revision, reason: "dismissed" };
    }
    if (isolation.targetRepair && !isolation.targetRepair.applied) {
      return {
        eligible: false,
        hasChanges: true,
        targetBranch,
        targetDirty: target.dirty,
        revision,
        reason: "target-overlap",
      };
    }
    if (isolation.state === "conflict") {
      if (isolation.targetRepair) {
        const sourceStatus = await git.status(isolation.worktreePath);
        if (sourceStatus.conflicted.length > 0) {
          return {
            eligible: false,
            hasChanges: true,
            targetBranch,
            targetDirty: target.dirty,
            revision,
            reason: "conflict",
          };
        }
      }
      if (events && turnCompletedAfterConflict(isolation, events)) {
        return { eligible: true, hasChanges: true, targetBranch, targetDirty: target.dirty, revision };
      }
      return {
        eligible: false,
        hasChanges: true,
        targetBranch,
        targetDirty: target.dirty,
        revision,
        reason: "conflict",
      };
    }
    if (events) {
      const stopped = lastCompletedTurn(events);
      const reason = stopped?.data && typeof stopped.data === "object"
        ? (stopped.data as { reason?: unknown }).reason
        : undefined;
      if (stopped?.type !== "turn/stopped" || reason !== "completed") {
        return { eligible: false, hasChanges: true, targetBranch, targetDirty: target.dirty, revision, reason: "no-turn" };
      }
    } else if (isolation.state !== "merge-ready") {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: target.dirty, revision, reason: "no-turn" };
    }
    return { eligible: true, hasChanges: true, targetBranch, targetDirty: target.dirty, revision };
  };

  const derivedState = (
    isolation: SessionIsolation,
    suggestion: IsolationSuggestionDto | null,
  ): IsolationState => {
    if (suggestion?.reason === "target-overlap") return "conflict";
    if (isolation.state === "merge-ready" && suggestion?.reason === "no-changes") return "active";
    if (
      (isolation.state === "active" || isolation.state === "merge-ready" || isolation.state === "conflict")
      && suggestion?.reason === "missing"
    ) return "missing";
    if (suggestion?.reason === "corrupt") return "corrupt";
    if (suggestion?.reason === "unowned") return "unowned";
    return isolation.state;
  };

  const closeProcesses = async (cwd: string) => {
    if (!deps.closeWorkspaceProcesses) return;
    await deps.closeWorkspaceProcesses(cwd);
  };

  const ownedRef = (sessionId: string, isolation: SessionIsolation) => ({
    sessionId,
    worktreePath: isolation.worktreePath,
    worktreeBranch: isolation.worktreeBranch || isolateBranchName(sessionId),
    targetPath: isolation.targetPath,
    targetBranch: isolation.targetBranch,
    baseCommit: isolation.baseCommit,
  });

  const inspectSource = (sessionId: string, isolation: SessionIsolation) =>
    managed.inspectOwned(isolation.targetPath, ownedRef(sessionId, isolation));

  const assertOwnedSource = async (sessionId: string, isolation: SessionIsolation) => {
    const inspection = await inspectSource(sessionId, isolation);
    if (inspection.status === "owned") return inspection.worktree;
    if (inspection.status === "missing") {
      throw err("not-found", "the isolated workspace is no longer available");
    }
    throw err(
      "conflict",
      `refusing to use an isolated workspace whose ownership is not proven (${inspection.reason})`,
    );
  };

  /** Capture destination-local work without touching the user's checkout. The
   * caller anchors the resulting commit only after the repair receipt is
   * durably projected, so a failed projection cannot strand a false receipt. */
  const anchorTargetRepair = async (
    sessionId: string,
    isolation: SessionIsolation,
    repair: IsolationTargetRepair,
  ): Promise<void> => {
    const ref = repairRef(sessionId);
    const existing = await git.readRef(isolation.targetPath, ref);
    if (existing === repair.snapshotSha) return;
    if (existing) throw err("conflict", "another AI repair receipt is already attached to this session");
    if (!await git.updateRef(isolation.targetPath, ref, repair.snapshotSha, "0".repeat(repair.snapshotSha.length))) {
      const raced = await git.readRef(isolation.targetPath, ref);
      if (raced !== repair.snapshotSha) {
        throw err("conflict", "the AI repair receipt changed while it was being created");
      }
    }
  };

  /** The publication receipt proves an in-flight merge to recovery; once the
   * record is released the published commit already lives on the target, so
   * the receipt leaves with it. AI repair backups are never released here:
   * they hold the user's target-checkout work, and several release paths
   * strip `targetRepair` first, so whether an applied repair rewrote that
   * checkout is no longer provable at this point. */
  const releaseIsolationRefs = async (sessionId: string, isolation: SessionIsolation): Promise<void> => {
    for (const ref of [receiptRefName(sessionId)]) {
      try {
        const sha = await git.readRef(isolation.targetPath, ref);
        if (sha && !await git.deleteRef(isolation.targetPath, ref, sha)) {
          throw new Error("ref changed while it was being released");
        }
      } catch (error) {
        isolationLog("cleanup-failed", {
          sessionId,
          stage: "refs",
          ref,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /** Startup reconciliation for receipts left by releases that predate
   * releaseIsolationRefs or crashed before it ran. Only receipts of a locally
   * known session with no isolation record left are dropped, and only when
   * their commit is still reachable from a branch, so nothing becomes
   * unreachable. Repair backups are never swept: whether a released merge
   * used one is no longer known. */
  const sweepReleasedReceipts = async (root: string): Promise<void> => {
    for (const { ref, sha } of await git.refsMergedIntoBranches(root, RECEIPT_REF_PREFIX)) {
      const sessionId = ref.slice(RECEIPT_REF_PREFIX.length);
      if (!UUID_RE.test(sessionId)) continue;
      await withSession(sessionId, async () => {
        // An unknown session can belong to another server or Space.
        const current = await deps.sessions.snapshot(sessionId).catch(() => undefined);
        if (!current || isolationOf(current) || isolationWorkspaceRows(current).length > 0) return;
        if (await git.deleteRef(root, ref, sha)) isolationLog("receipt-released", { sessionId, repository: root });
      });
    }
  };

  const captureTargetRepair = async (
    sessionId: string,
    isolation: SessionIsolation,
    target: { path: string; liveHead: string },
    files?: string[],
    anchor = true,
  ): Promise<IsolationTargetRepair> => {
    const beforeFingerprint = await git.workingFingerprint(target.path);
    const status = await git.status(target.path);
    if (status.clean) {
      throw err("conflict", `${isolation.targetBranch} changed while preparing the AI repair; review it and try again`);
    }
    const identity = await commitIdentityFor(target.path);
    const snapshot = await git.snapshotCommit(
      target.path,
      `polyth: preserve local ${isolation.targetBranch} work for AI repair (${sessionId.slice(0, 8)})`,
      identity,
    );
    if (!snapshot.created || snapshot.sha === target.liveHead) {
      throw err("conflict", `${isolation.targetBranch} changed while preparing the AI repair; review it and try again`);
    }
    const afterFingerprint = await git.workingFingerprint(target.path);
    if (afterFingerprint !== beforeFingerprint) {
      throw err("conflict", `${isolation.targetBranch} changed while preparing the AI repair; review it and try again`);
    }
    const repair: IsolationTargetRepair = {
      kind: "target-overlap",
      targetHead: target.liveHead,
      targetFingerprint: beforeFingerprint,
      snapshotSha: snapshot.sha,
      files: files?.length ? files : repairFiles(status),
      applied: false,
    };
    if (anchor) await anchorTargetRepair(sessionId, isolation, repair);
    return repair;
  };

  const assertTargetRepairUnchanged = async (
    isolation: SessionIsolation,
    repair: IsolationTargetRepair,
  ): Promise<{ path: string; liveHead: string }> => {
    const target = await inspectTarget(isolation);
    if (target.liveHead !== repair.targetHead) {
      throw err("conflict", `${isolation.targetBranch} changed since the AI repair was prepared; review it and try again`);
    }
    const fingerprint = await git.workingFingerprint(target.path);
    if (fingerprint !== repair.targetFingerprint) {
      throw err("conflict", `${isolation.targetBranch} local changes changed since the AI repair was prepared; nothing was overwritten`);
    }
    return target;
  };

  const sourceRequiresPreservation = async (
    isolation: SessionIsolation,
    source: Awaited<ReturnType<typeof inspectSource>>,
  ): Promise<boolean> => {
    if (source.status !== "owned") return true;
    if (!isolation.sourceSnapshotSha) return false;
    try {
      return !(await git.workingTreeMatches(isolation.worktreePath, isolation.sourceSnapshotSha));
    } catch {
      // An explicit abandonment is non-destructive. If the source cannot be
      // compared reliably, preserving it is safer than leaving the canonical
      // session permanently wedged in cleanup-pending.
      return true;
    }
  };

  /** Live isolation records whose merge-back returns to `checkoutPath`: the
   * delegated children branched from it. Removing that checkout would strand
   * their work, so they depend on it like a session running there. */
  const nestedIsolationsAt = (
    candidates: readonly SessionProjection[],
    sessionId: string,
    checkoutPath: string,
  ): SessionProjection[] => candidates.filter((candidate) => candidate.id !== sessionId
    && isolationWorkspaceRows(candidate).some((row) => row.isolation.originPath !== undefined
      && samePath(row.isolation.originPath, checkoutPath)));

  const sourceDependentsAt = async (
    sessionId: string,
    worktreePath: string,
  ): Promise<SessionProjection[]> => {
    const dependents: SessionProjection[] = [];
    const candidates = await deps.sessions.list();
    const nested = new Set(nestedIsolationsAt(candidates, sessionId, worktreePath).map((candidate) => candidate.id));
    for (const candidate of candidates) {
      if (candidate.id === sessionId) continue;
      const project = candidate.worktreePath ? undefined : await deps.projects.get(candidate.projectId);
      const cwd = candidate.worktreePath ?? project?.path;
      const workspacePaths = candidate.workspace?.repositories.map((row) => row.path) ?? [];
      if ((cwd && samePath(cwd, worktreePath))
        || workspacePaths.some((path) => samePath(path, worktreePath))
        || (candidate.runtimeBinding?.location.directory && samePath(candidate.runtimeBinding.location.directory, worktreePath))
        || nested.has(candidate.id)) {
        dependents.push(candidate);
      }
    }
    return dependents;
  };

  /** Refuse to publish or drop a checkout that delegated isolated work still
   * merges into. Merging first keeps every child's work on its way to the
   * same target; dropping first would strand it on an orphaned branch. */
  const assertNoPendingDelegations = async (
    session: SessionProjection,
    isolation: SessionIsolation,
  ): Promise<void> => {
    const pending = nestedIsolationsAt(await deps.sessions.list(session.projectId), session.id, isolation.worktreePath);
    if (pending.length === 0) return;
    const names = pending.slice(0, 5).map((candidate) => `“${candidate.title}”`).join(", ");
    throw Object.assign(
      err("conflict", `Delegated agents still have isolated work that merges into this workspace: ${names}${pending.length > 5 ? ", …" : ""}. Merge or discard their work first.`),
      {
        reason: "delegated-pending",
        sessionIds: pending.map((candidate) => candidate.id),
        mutationOutcome: "rejected",
        retryability: "safe",
      },
    );
  };

  /** A nested child publishes into its parent's managed branch. Only while
   * that parent isolation is open for work: once it is publishing or being
   * cleaned up, a late commit on its branch would miss the parent's merge. */
  const assertNestedTargetOpen = async (session: SessionProjection, isolation: SessionIsolation): Promise<void> => {
    if (!isManagedBranch(localBranchName(isolation.targetBranch)) || !isolation.originPath) return;
    const owner = (await deps.sessions.list(session.projectId)).find((candidate) =>
      isolationWorkspaceRows(candidate).some((row) => samePath(row.isolation.worktreePath, isolation.originPath!)));
    const ownerRow = owner && isolationWorkspaceRows(owner).find((row) => samePath(row.isolation.worktreePath, isolation.originPath!));
    const state = ownerRow ? normalizeIsolationContract(ownerRow.isolation).state : undefined;
    if (state !== "active" && state !== "merge-ready" && state !== "conflict") {
      throw Object.assign(
        err("conflict", `the parent workspace for ${isolation.targetBranch} is ${state ?? "no longer isolated"}; it cannot take delegated work now`),
        { mutationOutcome: "rejected", retryability: "safe" },
      );
    }
  };

  const sourceDependents = (sessionId: string, isolation: SessionIsolation): Promise<SessionProjection[]> =>
    sourceDependentsAt(sessionId, isolation.worktreePath);

  /** True only when neither the checkout nor its branch exists any more: the
   * record then refers to nothing. A Git error is never read as absence. */
  /** True when nothing the record names can still hold work: the checkout
   *  directory is gone and its branch is either gone or already contained in
   *  the target branch. A checkout deleted with `rm -rf` (not `git worktree
   *  remove`) leaves Git's stale admin entry listed until a prune; the
   *  directory itself is the evidence, so that entry does not count. A hand
   *  merge that keeps the branch leaves nothing unmerged on it either; the
   *  branch itself is left in place. */
  const isolationResourcesGone = async (sessionId: string, isolation: SessionIsolation): Promise<boolean> => {
    if (await filesystemPathExists(isolation.worktreePath)) return false;
    if (!await git.isRepo(isolation.targetPath)) return false;
    const branch = isolation.worktreeBranch || isolateBranchName(sessionId);
    const tip = await git.readRef(isolation.targetPath, `refs/heads/${branch}`);
    if (tip === null) return true;
    if (!isolation.targetBranch) return false;
    const target = await git.readRef(isolation.targetPath, `refs/heads/${isolation.targetBranch}`);
    return target !== null && await git.isAncestor(isolation.targetPath, tip, target).catch(() => false);
  };

  /** Drop the isolation record of an archived or epoch-pending session whose
   * checkout is gone and whose branch is gone or merged (removed outside
   * Polyth, e.g. a hand merge and `git worktree remove` or `rm -rf`). Core also moves the session's
   * execution to the target checkout, so a restore or the next runtime epoch
   * does not start in the deleted path. An in-flight publication or corrupt
   * evidence keeps its record for explicit recovery. */
  const releaseVanished = async (sessionId: string): Promise<boolean> => {
    const session = await deps.sessions.snapshot(sessionId).catch(() => undefined);
    if (!session || (session.status !== "archived" && session.status !== "epoch-pending")) return false;
    const rows = isolationWorkspaceRows(session);
    const isolation = isolationOf(session);
    if (!isolation || rows.length > 1) return false;
    const state = normalizeIsolationContract(isolation).state;
    if (state === "merging" || state === "publishing" || state === "corrupt") return false;
    if (!await isolationResourcesGone(sessionId, isolation)) return false;
    await persist(sessionId, null);
    await releaseIsolationRefs(sessionId, isolation);
    isolationLog("vanished-record-released", { sessionId, worktreePath: isolation.worktreePath, state, status: session.status });
    return true;
  };

  /** Rebind every completed descendant that ran in this checkout. Returns the
   *  ids it actually moved, so their own chat media can be preserved too. */
  const relocateCompletedChildren = async (session: SessionProjection, isolation: SessionIsolation): Promise<string[]> => {
    const relocated: string[] = [];
    if (!deps.sessions.rebindWorkspace) return relocated;
    const destination = await destinationFor(session, isolation);
    const all = await deps.sessions.list();
    const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
    const isDescendant = (candidate: SessionProjection): boolean => {
      const seen = new Set<string>();
      for (let parentId = candidate.parentId; parentId && !seen.has(parentId); parentId = byId.get(parentId)?.parentId) {
        if (parentId === session.id) return true;
        seen.add(parentId);
      }
      return false;
    };
    for (const candidate of await sourceDependents(session.id, isolation)) {
      // A descendant archived or left unknown before it ever reached a native
      // session (a failed startup) has no execution here; it moves as metadata
      // only, so it never pins its owner's cleanup. Core re-checks this.
      const unmaterialized = (candidate.status === "archived" || candidate.status === "unknown")
        && !candidate.runtimeBinding && !candidate.backendSessionId;
      if (candidate.projectId !== session.projectId || candidate.spaceId !== session.spaceId
        || !isDescendant(candidate) || (isolationBlocksUserMutation(candidate.status) && !unmaterialized)
        || candidate.isolation || candidate.workspace?.repositories.some((row) => row.isolation)) continue;
      const workspace = candidate.workspace && {
        ...candidate.workspace,
        repositories: candidate.workspace.repositories.map((row) => samePath(row.path, isolation.worktreePath)
          ? { ...row, path: destination.path, branch: destination.branch, state: "ready" as const }
          : row),
      };
      const project = await projectOf(candidate.projectId);
      const executionPath = candidate.workspace?.repositories.find((row) => row.repositoryId === candidate.workspace?.executionRepositoryId)?.path
        ?? candidate.worktreePath ?? project.path;
      try {
        const debug = await deps.sessions.debug?.(candidate.id);
        // A queued prompt must never move under a child. An unmaterialized
        // child's unresolved create outcome stays recorded; moving its
        // checkout does not replay it.
        if (debug && (debug.runtime.activeTurn || debug.runtime.admissionPending
          || (debug.counts.unknownOperations && !unmaterialized) || debug.queue.length)) continue;
        // Core owns the lock, revision check, execution-release proof and new
        // runtime epoch. Status alone is never release evidence.
        await deps.sessions.rebindWorkspace(candidate.id, {
          ...(workspace ? { workspace } : {}),
          expectedWorkspaceRevision: candidate.workspace?.revision ?? 0,
          ...(samePath(executionPath, isolation.worktreePath)
            ? { worktreePath: destination.path, branch: destination.branch }
            : {}),
          ...(unmaterialized ? { relocateManagedCheckout: true } : {}),
        });
        isolationLog("child-rebound", { sessionId: session.id, childSessionId: candidate.id, destination: destination.path });
        relocated.push(candidate.id);
      } catch (error) {
        isolationLog("child-rebind-failed", { sessionId: session.id, childSessionId: candidate.id, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return relocated;
  };

  /** Carry the session-lifetime chat media its canonical history references
   *  from a released checkout into the destination checkout, before the former
   *  is deleted. Best effort: a failure is logged, never thrown, so cleanup
   *  never blocks on media. */
  const preserveReferencedMedia = async (
    sessionIds: readonly string[],
    projectId: string,
    sourceRoot: string,
    destinationRoot: string,
  ): Promise<void> => {
    if (!deps.preserveSessionMedia) return;
    if (samePath(sourceRoot, destinationRoot)) return;
    try {
      const preserved = await deps.preserveSessionMedia({
        sessionIds,
        projectId,
        sourceRoot,
        destinationRoot,
        // One batch query against the destination checkout: the copy owns only
        // files Git ignores; everything else is Git's to carry or abandon.
        ignored: (paths) => git.checkIgnored(destinationRoot, paths),
      });
      if (preserved.copied.length || preserved.missing.length) {
        isolationLog("media-preserved", {
          sessionIds: sessionIds.join(","),
          copied: preserved.copied.length,
          skipped: preserved.skipped.length,
          missing: preserved.missing.length,
          notIgnored: preserved.notIgnored.length,
        });
      }
    } catch (error) {
      isolationLog("media-preserve-failed", {
        sessionIds: sessionIds.join(","),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const finishCleanup = async (sessionId: string): Promise<SessionProjection> => {
    const session = await deps.sessions.snapshot(sessionId);
    const isolation = isolationOf(session);
    if (!isolation) return session;
    if (isolation.state !== "cleanup-pending") {
      isolationLog("cleanup-skipped", {
        sessionId,
        state: isolation.state,
      });
      return session;
    }
    const project = await projectOf(session.projectId);
    const cwd = session.worktreePath ?? project.path;
    if (samePath(cwd, isolation.worktreePath)) {
      isolationLog("cleanup-failed", {
        sessionId,
        reason: "session-still-bound-to-source",
        worktreePath: isolation.worktreePath,
      });
      return session;
    }
    try {
      const dest = await destinationFor(session, isolation);
      if (!samePath(cwd, dest.path)) {
        isolationLog("cleanup-failed", {
          sessionId,
          reason: "cwd-is-not-origin",
          cwd,
          originPath: dest.path,
        });
        return session;
      }
    } catch (error) {
      isolationLog("cleanup-failed", {
        sessionId,
        reason: "origin-unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      return session;
    }
    isolationLog("cleanup", {
      sessionId: session.id,
      projectId: session.projectId,
      worktreePath: isolation.worktreePath,
    });
    if (deps.testHooks?.beforeCleanup) await deps.testHooks.beforeCleanup();
    const ownership = await inspectSource(session.id, isolation);
    const alreadyGone = ownership.status === "missing" && !await filesystemPathExists(isolation.worktreePath);
    if (ownership.status !== "owned" && !alreadyGone) {
      isolationLog("cleanup-unowned", {
        sessionId: session.id,
        worktreePath: isolation.worktreePath,
        reason: ownership.status === "missing" ? "missing" : ownership.reason,
        retained: true,
      });
      // Discard is an explicit abandonment action. Rebind the canonical
      // session, preserve every unproven path/ref, then release the unusable
      // isolation record. Published merges keep cleanup-pending so their
      // incomplete cleanup remains explicit and retryable.
      if (!isolation.resultCommit) {
        const released = await persist(session.id, null);
        await releaseIsolationRefs(session.id, isolation);
        return released;
      }
      return session;
    }
    const relocatedChildren = await relocateCompletedChildren(session, isolation);
    const dependents = await sourceDependents(session.id, isolation);
    if (dependents.length) {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        reason: "source-has-dependent-sessions",
        dependentSessionIds: dependents.map((candidate) => candidate.id).join(","),
        worktreePath: isolation.worktreePath,
        retained: true,
      });
      return session;
    }
    try {
      await closeProcesses(isolation.worktreePath);
    } catch (error) {
      isolationLog("cleanup-failed", {
        sessionId,
        stage: "processes",
        message: error instanceof Error ? error.message : String(error),
      });
      return session;
    }
    // Process shutdown may flush buffered output. Compare only after every
    // Polyth-owned writer is closed, immediately before managed deletion.
    if (!alreadyGone && isolation.sourceSnapshotSha
      && !(await git.workingTreeMatches(isolation.worktreePath, isolation.sourceSnapshotSha))) {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        reason: "source-changed-after-snapshot",
        worktreePath: isolation.worktreePath,
        retained: true,
      });
      return session;
    }
    // Preserve the session-lifetime chat media its history references before
    // the worktree is deleted: a project-relative image path that only lived
    // in this checkout would otherwise 404 once the session reads from the
    // destination.
    if (!alreadyGone) {
      const dest = await destinationFor(session, isolation).catch(() => null);
      // The parent plus every descendant that actually ran in this checkout
      // (the ones `relocateCompletedChildren` just rebound): their chat images
      // are project-relative too, and they now read from the destination.
      if (dest) await preserveReferencedMedia([session.id, ...relocatedChildren], session.projectId, isolation.worktreePath, dest.path);
    }
    const result = await managed.removeOwned(project.path, ownedRef(session.id, isolation));
    if (result.status === "unowned") {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        reason: result.reason,
        worktreePath: isolation.worktreePath,
      });
      return persist(session.id, transitionIsolation(isolation, {
        phase: "cleanup-pending",
        ...(isolation.resultCommit ? { resultCommit: isolation.resultCommit } : {}),
        ...(isolation.sourceSnapshotSha ? { sourceSnapshotSha: isolation.sourceSnapshotSha } : {}),
      }));
    }
    await managed.pruneIntegrationsForSession(project.path, session.id).catch((error: unknown) => {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        stage: "integrations",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    isolationLog("cleanup", { sessionId: session.id, projectId: session.projectId, done: true });
    const released = await persist(session.id, null);
    await releaseIsolationRefs(session.id, isolation);
    return released;
  };

  const rebindToTarget = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    nextIsolation: SessionIsolation,
  ): Promise<SessionProjection> => {
    if (!deps.sessions.rebindWorkspace) {
      throw err("unsupported", "session workspace rebind is unavailable");
    }
    const dest = await destinationFor(session, isolation);
    isolationLog("session-rebind", {
      sessionId: session.id,
      projectId: session.projectId,
      from: isolation.worktreePath,
      to: dest.path,
      branch: dest.branch,
    });
    return deps.sessions.rebindWorkspace(session.id, {
      expectedWorkspaceRevision: session.workspace?.revision ?? 0,
      worktreePath: dest.isProjectRoot ? null : dest.path,
      branch: dest.branch,
      isolation: nextIsolation,
    });
  };

  const notice = async (sessionId: string, type: string, data: JsonObject) => {
    try {
      await deps.append(sessionId, type, data);
    } catch (error) {
      isolationLog("notice-failed", {
        sessionId,
        type,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const continueAfterPublish = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    resultCommit: string,
    sourceSnapshotSha: string,
  ): Promise<SessionProjection> => {
    const pending = transitionIsolation(isolation, { phase: "rebind-pending", resultCommit, sourceSnapshotSha });
    let current = await persist(session.id, pending);
    try {
      const cleanup = transitionIsolation(pending, { phase: "cleanup-pending", resultCommit, sourceSnapshotSha });
      current = await rebindToTarget(current, isolation, cleanup);
    } catch (error) {
      isolationLog("session-rebind-failed", {
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
      });
      return deps.sessions.snapshot(session.id);
    }
    await notice(session.id, "isolation/merged", {
      targetBranch: isolation.targetBranch,
      commit: resultCommit,
      ...(isolation.targetRepair
        ? { targetRepair: true, backupSha: isolation.targetRepair.snapshotSha, backupRef: repairRef(session.id) }
        : {}),
    });
    return finishCleanup(session.id);
  };

  const publicationBindingError = (
    session: SessionProjection,
    isolation: SessionIsolation,
  ): string | null => {
    const intent = isolation.publish;
    if (!intent?.receiptRef) return null;
    if (intent.receiptRef !== receiptRefName(session.id)) {
      return "publication receipt does not belong to this session";
    }
    if (isolation.originPath && !samePath(intent.checkoutPath!, isolation.originPath)) {
      return "publication checkout does not match the immutable origin";
    }
    return null;
  };

  const publicationState = async (
    sessionId: string,
    isolation: SessionIsolation,
    intent: IsolationPublishIntent,
  ) => {
    if (intent.receiptRef) {
      if (intent.receiptRef !== receiptRefName(sessionId)) return "unknown" as const;
      try {
        const receipt = await git.readRef(isolation.targetPath, intent.receiptRef);
        if (receipt === null) return "unpublished" as const;
        return receipt === intent.resultCommit ? "published" as const : "unknown" as const;
      } catch {
        return "unknown" as const;
      }
    }
    let live: string;
    try {
      live = await git.revParse(isolation.targetPath, isolation.targetBranch);
    } catch {
      return "unknown" as const;
    }
    if (live === intent.resultCommit) return "published" as const;
    if (await git.isAncestor(isolation.targetPath, intent.resultCommit, live)) return "published" as const;
    // Legacy records have no atomic receipt, so a target reset to the old SHA
    // is indistinguishable from a publication that never happened.
    if (live === intent.expectedTargetSha) return "unknown" as const;
    return "target-moved" as const;
  };

  const assertPublicationBinding = async (
    session: SessionProjection,
    isolation: SessionIsolation,
  ): Promise<void> => {
    const intent = isolation.publish;
    if (!intent?.receiptRef) return;
    const bindingError = publicationBindingError(session, isolation);
    if (bindingError) throw err("corrupt-isolation", bindingError);
    const destination = await destinationFor(session, isolation);
    if (!samePath(intent.checkoutPath!, destination.path)) {
      throw err("corrupt-isolation", "publication checkout does not match the verified destination");
    }
  };

  const recoverMerging = async (session: SessionProjection, isolation: SessionIsolation): Promise<SessionProjection> => {
    await assertPublicationBinding(session, isolation);
    await managed.pruneIntegrationsForSession(isolation.targetPath, session.id).catch((error: unknown) => {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        stage: "integrations",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!isolation.publish) {
      isolationLog("recovery", { sessionId: session.id, merging: "abandoned-before-publish" });
      return persist(session.id, transitionIsolation(isolation, { phase: "merge-ready" }));
    }
    const reality = await publicationState(session.id, isolation, isolation.publish);
    isolationLog("recovery", { sessionId: session.id, merging: reality, resultCommit: isolation.publish.resultCommit });
    if (reality === "published") {
      if (isolation.publish.receiptRef && isolation.publish.checkoutPath) {
        if (isolation.targetRepair) {
          await git.replacePublishedCheckout(isolation.publish.checkoutPath, {
            branch: isolation.targetBranch,
            expectedHead: isolation.publish.expectedTargetSha,
            resultCommit: isolation.publish.resultCommit,
            expectedFingerprint: isolation.targetRepair.targetFingerprint,
          });
        } else {
          await git.syncPublishedCheckout(isolation.publish.checkoutPath, {
            branch: isolation.targetBranch,
            expectedHead: isolation.publish.expectedTargetSha,
            resultCommit: isolation.publish.resultCommit,
          });
        }
      }
      return continueAfterPublish(session, isolation, isolation.publish.resultCommit, isolation.publish.snapshotSha);
    }
    if (reality === "unknown") return session;
    return persist(session.id, transitionIsolation(isolation, { phase: "merge-ready" }));
  };

  const recoverCleanup = async (session: SessionProjection, isolation: SessionIsolation): Promise<SessionProjection> => {
    if (isolation.state === "cleanup-pending") return finishCleanup(session.id);
    try {
      const cleanup = transitionIsolation(isolation, {
        phase: "cleanup-pending",
        ...(isolation.resultCommit ? { resultCommit: isolation.resultCommit } : {}),
        ...(isolation.sourceSnapshotSha ? { sourceSnapshotSha: isolation.sourceSnapshotSha } : {}),
      });
      const rebound = await rebindToTarget(session, isolation, cleanup);
      return finishCleanup(rebound.id);
    } catch (error) {
      isolationLog("session-rebind-failed", {
        sessionId: session.id,
        recovery: true,
        message: error instanceof Error ? error.message : String(error),
      });
      return deps.sessions.snapshot(session.id);
    }
  };

  const recoverSessionLocked = async (session: SessionProjection): Promise<SessionProjection> => {
    let isolation = isolationOf(session);
    if (!isolation) return session;
    // Existing merge/rebind state is scalar. Never finalize only the execution
    // row of a multi-repository session; the per-repository operation contract
    // must supply independent publication and rebind receipts first.
    if (isolationWorkspaceRows(session).length > 1) return session;
    // Corruption may encode ambiguous publication evidence. Never rewrite or
    // activate it merely because the source workspace still looks healthy.
    if (isolation.state === "corrupt") return session;
    if (JSON.stringify(session.isolation) !== JSON.stringify(isolation)) {
      session = await persist(session.id, isolation);
      isolation = isolationOf(session)!;
    }
    isolationLog("recovery", {
      sessionId: session.id,
      projectId: session.projectId,
      state: isolation.state,
    });
    if (isolation.state === "merging" || isolation.state === "publishing") {
      return recoverMerging(session, isolation);
    }
    if (isolation.state === "rebind-pending" || isolation.state === "cleanup-pending") return recoverCleanup(session, isolation);
    const ownership = await inspectSource(session.id, isolation).catch(() => ({ status: "missing" as const }));
    // Resource health is observational. Persisting it would overwrite the
    // durable lifecycle (especially conflict details) with filesystem state.
    if (ownership.status === "missing" || ownership.status === "unowned") return session;
    if (isolation.state === "missing" || isolation.state === "unowned") {
      return persist(session.id, transitionIsolation(isolation, { phase: "active" }));
    }
    if (readsTurnFacts && (isolation.state === "active" || isolation.state === "conflict")) {
      const suggestion = await suggestionFor(session, await readTurnFacts(session.id, isolation));
      if (suggestion?.eligible) {
        return persist(session.id, transitionIsolation(isolation, { phase: "merge-ready" }));
      }
    }
    return session;
  };

  const materializeRepositories = async (
    sessionId: string,
    repositoryIds?: readonly string[],
  ): Promise<SessionProjection> => withSession(sessionId, async () => {
    if (!deps.sessions.patchWorkspace) throw err("unsupported", "session workspace patching is unavailable");
    const session = await deps.sessions.snapshot(sessionId);
    assertNotBusy(session);
    if (!session.workspace || isolationWorkspaceRows(session).length === 0) {
      throw err("unsupported", "repository checkout materialization requires an isolated workspace snapshot");
    }
    const project = await projectOf(session.projectId);
    const selected = selectIsolationRepositories(project, repositoryIds);
    const existing = new Set(session.workspace.repositories.map((row) => row.repositoryId));
    const additions = selected.repositories.filter((repository) => !existing.has(repository.id));
    if (additions.length === 0) return session;
    const allocations: IsolationAllocation[] = [];
    try {
      for (const repository of additions) {
        if (!(await git.isRepo(repository.path))) throw err("invalid-input", `repository is not a git repository: ${repository.alias}`);
        const origin = await resolveOriginForRepository(project, repository, {} as CreateIsolatedSessionInput);
        const worktree = await managed.create({
          root: repository.path,
          sessionId,
          targetBranch: origin.branch,
          targetPath: repository.path,
          base: origin.startPoint,
        });
        const isolation: SessionIsolation = {
          kind: "git-worktree",
          state: "active",
          createdAt: worktree.meta.createdAt,
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
          targetPath: resolve(repository.path),
          targetBranch: origin.branch,
          originPath: origin.originPath,
          baseCommit: origin.head,
        };
        allocations.push({ repositoryId: repository.id, alias: repository.alias, path: worktree.path, branch: origin.branch, isolation });
      }
      const workspace: SessionWorkspace = {
        ...session.workspace,
        revision: session.workspace.revision ?? 0,
        repositories: [
          ...session.workspace.repositories,
          ...allocations.map((allocation) => ({
            repositoryId: allocation.repositoryId,
            alias: allocation.alias,
            path: allocation.path,
            state: "ready" as const,
            branch: allocation.branch,
            isolation: allocation.isolation,
          })),
        ],
      };
      return await deps.sessions.patchWorkspace(sessionId, workspace, session.workspace.revision ?? 0);
    } catch (error) {
      let current: SessionProjection | undefined;
      let lookupError: unknown;
      try { current = await deps.sessions.snapshot(sessionId); }
      catch (snapshotError) {
        if ((snapshotError as { code?: unknown })?.code !== "not-found") lookupError = snapshotError;
      }
      const persisted = current?.workspace?.repositories.some((row) => allocations.some((allocation) => row.repositoryId === allocation.repositoryId));
      if (persisted || lookupError) {
        isolationLog("materialization-rollback-deferred", { sessionId, reason: persisted ? "workspace-committed" : "workspace-lookup-uncertain" });
        throw error;
      }
      const rollbackErrors: Error[] = [];
      for (const allocation of [...allocations].reverse()) {
        try {
          const result = await managed.removeOwned(allocation.isolation.targetPath, ownedRef(sessionId, allocation.isolation));
          if (result.status === "unowned") rollbackErrors.push(err("conflict", `materialization rollback ownership is unproven (${result.reason})`));
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
        }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "repository materialization rollback failed");
      throw error;
    }
  });

  /** Membership update used by the canonical session workspace patch route.
   * Additions are allocated lazily; managed rows omitted by a selection stay
   * durable until an explicit repository lifecycle operation disposes them. */
  const updateIsolatedWorkspace = async (
    sessionId: string,
    selection: { repositoryIds?: readonly string[]; expectedRevision?: number },
  ): Promise<SessionProjection> => {
    const session = await deps.sessions.snapshot(sessionId);
    if (!session.workspace) throw err("unsupported", "session has no isolated workspace");
    const revision = session.workspace.revision ?? 0;
    if (selection.expectedRevision !== undefined && revision !== selection.expectedRevision) throw err("conflict", "workspace changed since it was loaded");
    const project = await projectOf(session.projectId);
    const selected = selectIsolationRepositories(project, selection.repositoryIds);
    const ids = selected.repositories.map((repository) => repository.id);
    const selectedIds = new Set(ids);
    const removedManaged = session.workspace.repositories.filter((row) => row.isolation && !selectedIds.has(row.repositoryId));
    if (removedManaged.length) throw err("conflict", "finish keep, merge, or discard for each managed repository before removing it from the session");
    const next = await materializeRepositories(sessionId, ids);
    if (!next.workspace || !deps.sessions.patchWorkspace) return next;
    const workspace: SessionWorkspace = {
      ...next.workspace,
      // Ordinary checkout rows are membership projections and may be removed
      // by a selection update. Managed rows were checked above and remain
      // until their explicit lifecycle action has completed.
      repositories: next.workspace.repositories.filter((row) => selectedIds.has(row.repositoryId) || row.isolation !== undefined),
      mode: selected.explicit ? "subset" : "all",
      revision: next.workspace.revision ?? revision,
    };
    return deps.sessions.patchWorkspace(sessionId, workspace, workspace.revision ?? revision);
  };

  const repositoryLifecycle = async (sessionId: string, repositoryId: string, operation: "keep" | "discard"): Promise<SessionProjection> => {
    if (!deps.sessions.withWorkspaceMutation) throw err("unsupported", "canonical workspace mutation is unavailable");
    const before = await deps.sessions.snapshot(sessionId);
    const revision = before.workspace?.revision ?? 0;
    return deps.sessions.withWorkspaceMutation(sessionId, revision, async (scope) => {
      const session = await scope.snapshot();
      assertNotBusy(session);
      const workspace = session.workspace;
      const row = workspace?.repositories.find((candidate) => candidate.repositoryId === repositoryId);
      if (!workspace || !row?.isolation) throw err("not-found", "repository isolation row is unavailable");
      const executionId = workspace.executionRepositoryId ?? repositoryId;
      if (operation === "keep") {
        const revision = await git.fingerprint(row.isolation.worktreePath);
        return scope.commit({ ...workspace, revision: workspace.revision ?? 0, repositories: workspace.repositories.map((candidate) => candidate.repositoryId === repositoryId
          ? { ...candidate, isolation: transitionIsolation(withoutTargetRepair(row.isolation!), { phase: "active", dismissedRevision: revision }) } : candidate) });
      }
    const ownership = await managed.inspectOwned(row.isolation.targetPath, ownedRef(sessionId, row.isolation));
    if (ownership.status === "unowned") throw err("conflict", `refusing to discard an unowned repository checkout (${ownership.reason})`);
    if (ownership.status === "owned") {
      const dependents = await sourceDependentsAt(sessionId, row.isolation.worktreePath);
      if (dependents.length) throw err("conflict", "another session still depends on this repository checkout");
    }
      if (repositoryId === executionId) {
        const replacement = workspace.repositories.find((candidate) => candidate.repositoryId !== repositoryId && candidate.state !== "missing" && candidate.isolation);
        if (!replacement) throw err("conflict", "the execution repository cannot be discarded without a ready replacement");
        await closeProcesses(row.isolation.worktreePath);
        const pendingWorkspace: SessionWorkspace = { ...workspace, revision: workspace.revision ?? 0, executionRepositoryId: replacement.repositoryId, repositories: workspace.repositories.map((candidate) => candidate.repositoryId === repositoryId ? { ...candidate, state: "missing" as const, isolation: transitionIsolation(withoutTargetRepair(row.isolation!), { phase: "cleanup-pending" }) } : candidate) };
        await scope.commit(pendingWorkspace, { worktreePath: replacement.path, branch: replacement.branch ?? null, isolation: replacement.isolation ?? null });
        // Media preservation is single-repository only (see docs/dev/workspace.md):
        // a multi-repository history path is relative to the execution row, not
        // to this row's target, so copying into `targetPath` could land it in
        // the wrong repository.
        const result = await managed.removeOwned(row.isolation.targetPath, ownedRef(sessionId, row.isolation));
        if (result.status === "unowned") throw err("conflict", `repository discard ownership is unproven (${result.reason})`);
        const nextWorkspace: SessionWorkspace = { ...pendingWorkspace, repositories: pendingWorkspace.repositories.filter((candidate) => candidate.repositoryId !== repositoryId) };
        const committed = await scope.commit(nextWorkspace);
        await releaseIsolationRefs(sessionId, withoutTargetRepair(row.isolation));
        return committed;
      }
      if (ownership.status === "owned") {
        await closeProcesses(row.isolation.worktreePath);
        const pendingWorkspace: SessionWorkspace = { ...workspace, revision: workspace.revision ?? 0, repositories: workspace.repositories.map((candidate) => candidate.repositoryId === repositoryId ? { ...candidate, state: "missing" as const, isolation: transitionIsolation(withoutTargetRepair(row.isolation!), { phase: "cleanup-pending" }) } : candidate) };
        await scope.commit(pendingWorkspace);
        // Single-repository preservation only; see the execution-row note above.
        const result = await managed.removeOwned(row.isolation.targetPath, ownedRef(sessionId, row.isolation));
        if (result.status === "unowned") throw err("conflict", `repository discard ownership is unproven (${result.reason})`);
      }
      const committed = await scope.commit({ ...workspace, revision: workspace.revision ?? 0, repositories: workspace.repositories.filter((candidate) => candidate.repositoryId !== repositoryId) });
      await releaseIsolationRefs(sessionId, withoutTargetRepair(row.isolation));
      return committed;
    });
  };

  const publish = async (
    sessionId: string,
    isolation: SessionIsolation,
    intent: IsolationPublishIntent,
    allowTargetRepair: boolean,
  ): Promise<"published" | "target-moved"> => {
    const target = await inspectTarget(isolation);
    if (target.liveHead !== intent.expectedTargetSha) return "target-moved";
    if (!intent.receiptRef) throw err("corrupt-isolation", "publication receipt is missing");
    const repair = isolation.targetRepair;
    try {
      if (repair) {
        await anchorTargetRepair(sessionId, isolation, repair);
        const sourceHead = await git.revParse(isolation.worktreePath, "HEAD");
        if (!await git.isAncestor(isolation.worktreePath, repair.snapshotSha, sourceHead)) {
          throw err("conflict", "the AI repair is no longer present in the isolated workspace; resolve it again");
        }
        // The AI repair already merged the backed-up destination snapshot into
        // the isolated branch. Do not ask Git to carry the old dirty tree
        // across the publication; verify its exact identity instead.
        await assertTargetRepairUnchanged(isolation, repair);
      } else {
        // A real Git dry-run replaces the blanket dirty-tree block. Compatible
        // staged, unstaged, and untracked work is carried forward; overlapping
        // work remains untouched because this happens before the ref CAS.
        await git.syncPublishedCheckout(target.path, {
          branch: isolation.targetBranch,
          expectedHead: intent.expectedTargetSha,
          resultCommit: intent.resultCommit,
          checkOnly: true,
        });
      }
    } catch (error) {
      const after = await inspectTarget(isolation).catch(() => null);
      if (after && after.liveHead !== intent.expectedTargetSha) return "target-moved";
      if (!after) throw error;
      if (repair) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { targetRepair: repair });
      }
      const status = await git.status(after.path).catch(() => undefined);
      if (status && !status.clean && !allowTargetRepair) {
        // A delegating agent owns that checkout and can commit its own work;
        // an AI repair would race its next edit. Keep everything and refuse.
        throw Object.assign(
          err(
            "conflict",
            `${isolation.targetBranch} has uncommitted changes that overlap this merge. They were kept; commit or move them, then merge again.`,
          ),
          { reason: "target-overlap", files: repairFiles(status) },
        );
      }
      if (status && !status.clean) {
        const targetRepair = await captureTargetRepair(sessionId, isolation, after, repairFiles(status), false);
        throw Object.assign(
          err(
            "conflict",
            `${isolation.targetBranch} has local changes that overlap this integration. The local changes were kept and backed up; use “Resolve with AI and proceed” to reconcile them. The resolved combination will be committed, with the original snapshot retained for recovery.`,
          ),
          { targetRepair },
        );
      }
      throw err(
        "conflict",
        `${isolation.targetBranch} has local changes that overlap this integration. The local changes were kept; move or resolve the overlap and try again.`,
      );
    }
    const updated = await git.publishRef(isolation.targetPath, {
      targetRef: intent.targetRef,
      expectedHead: intent.expectedTargetSha,
      newSha: intent.resultCommit,
      receiptRef: intent.receiptRef,
    });
    if (!updated) return "target-moved";
    isolationLog("published", {
      targetBranch: isolation.targetBranch,
      commit: intent.resultCommit,
      mode: repair ? "atomic-ref-with-ai-repair" : "atomic-ref-with-receipt",
    });
    return "published";
  };

  const commitMessageFor = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    integrationPath: string,
  ): Promise<string> => {
    const fallback = session.title?.trim() && session.title !== "New session"
      ? session.title.trim()
      : `Merge isolated session into ${isolation.targetBranch}`;
    if (!deps.generateCommitMessage) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), deps.commitMessageWaitMs ?? COMMIT_MESSAGE_WAIT_MS);
    });
    try {
      const generated = await Promise.race([deps.generateCommitMessage(session, integrationPath), timedOut]);
      if (generated === "timeout") {
        isolationLog("commit-message-fallback", { sessionId: session.id, reason: "timeout" });
        return fallback;
      }
      return generated.trim() || fallback;
    } catch (error) {
      isolationLog("commit-message-fallback", {
        sessionId: session.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  };

  const integrateOnce = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    isolatedHead: string,
    sourceRevision: string,
    allowTargetRepair: boolean,
  ): Promise<
    | { kind: "merged"; sha: string; expectedHead: string }
    | { kind: "conflict"; files: string[]; message: string }
    | { kind: "empty" }
    | { kind: "retry" }
  > => {
    const target = await inspectTarget(isolation);
    const targetHead = target.liveHead;
    // The AI repair reconciled the local work against one target head. A
    // publication intent for any other head fails normalization as corrupt,
    // so a moved target sends the session back to resolve instead.
    if (isolation.targetRepair && isolation.targetRepair.targetHead !== targetHead) {
      return {
        kind: "conflict",
        files: isolation.targetRepair.files,
        message: `${isolation.targetBranch} moved after its local changes were backed up; resolve them again.`,
      };
    }
    isolationLog("integration-started", {
      sessionId: session.id,
      projectId: session.projectId,
      targetBranch: isolation.targetBranch,
      targetHead,
      isolatedHead,
    });
    const integrationPath = await managed.createIntegrationWorkspace({
      root: isolation.targetPath,
      sessionId: session.id,
      startPoint: targetHead,
    });
    try {
      if (deps.testHooks?.afterIntegrationCreated) {
        await deps.testHooks.afterIntegrationCreated(session.id);
      }
      const merged = await git.mergeSquash(integrationPath, isolatedHead);
      if (!merged.ok) {
        isolationLog("conflict", {
          sessionId: session.id,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
          files: merged.conflicted,
        });
        await git.abortMerge(integrationPath).catch((error: unknown) => {
          isolationLog("cleanup-failed", {
            sessionId: session.id,
            stage: "abort-merge",
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return {
          kind: "conflict",
          files: merged.conflicted,
          message: `${isolation.targetBranch} changed in conflicting areas.`,
        };
      }
      const staged = await git.diff(integrationPath, { staged: true });
      if (!staged.diff.trim()) return { kind: "empty" };
      const baseMessage = await commitMessageFor(session, isolation, integrationPath);
      const message = isolation.targetRepair ? `${baseMessage} (AI target repair)` : baseMessage;
      const identity = await commitIdentityFor(isolation.targetPath);
      const committed = await git.commitStagedTree(integrationPath, message, identity);
      const intent: IsolationPublishIntent = {
        expectedTargetSha: targetHead,
        resultCommit: committed.sha,
        snapshotSha: isolatedHead,
        targetRef: targetRefName(isolation.targetBranch),
        receiptRef: receiptRefName(session.id),
        checkoutPath: (await destinationFor(session, isolation)).path,
        sourceRevision,
      };
      await persist(session.id, transitionIsolation(isolation, { phase: "publishing", publish: intent }));
      if (deps.testHooks?.beforePublish) await deps.testHooks.beforePublish();
      if (!(await git.workingTreeMatches(isolation.worktreePath, isolatedHead))) {
        await persist(session.id, transitionIsolation(isolation, { phase: "merge-ready" }));
        throw err("conflict", "isolated workspace changed after its merge snapshot; review and merge again");
      }
      const outcome = await publish(session.id, isolation, intent, allowTargetRepair);
      if (deps.testHooks?.afterPublish) await deps.testHooks.afterPublish();
      if (outcome === "published") {
        if (isolation.targetRepair) {
          // The ref CAS is the commit point. Only after it succeeds do we
          // replace the old dirty checkout, and the fingerprint fence above
          // ensures no user edit can be silently overwritten in the gap.
          await git.replacePublishedCheckout(intent.checkoutPath!, {
            branch: isolation.targetBranch,
            expectedHead: intent.expectedTargetSha,
            resultCommit: intent.resultCommit,
            expectedFingerprint: isolation.targetRepair.targetFingerprint,
          });
        } else {
          await git.syncPublishedCheckout(intent.checkoutPath!, {
            branch: isolation.targetBranch,
            expectedHead: intent.expectedTargetSha,
            resultCommit: intent.resultCommit,
          });
        }
      }
      if (outcome === "target-moved") {
        isolationLog("target-changed", {
          sessionId: session.id,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
          expected: targetHead,
        });
        return { kind: "retry" };
      }
      return { kind: "merged", sha: committed.sha, expectedHead: targetHead };
    } finally {
      await managed.discardIntegration(isolation.targetPath, integrationPath, session.id);
    }
  };

  const applyTargetRepair = async (
    session: SessionProjection,
    isolation: SessionIsolation,
  ): Promise<{ isolation: SessionIsolation; files: string[] }> => {
    const repair = isolation.targetRepair;
    if (!repair) return { isolation, files: isolation.conflict?.files ?? [] };
    await anchorTargetRepair(session.id, isolation, repair);
    await assertTargetRepairUnchanged(isolation, repair);
    let incorporated = repair.applied === true;
    if (!incorporated) {
      const head = await git.revParse(isolation.worktreePath, "HEAD");
      incorporated = await git.isAncestor(isolation.worktreePath, repair.snapshotSha, head).catch(() => false);
    }
    if (!incorporated) {
      const before = await git.status(isolation.worktreePath);
      if (before.branch !== isolation.worktreeBranch) {
        throw err("conflict", "the isolated workspace branch changed while preparing the target repair");
      }
      if (before.conflicted.length > 0) {
        throw err("conflict", "the isolated workspace already has unresolved conflicts; resolve them before applying the target repair");
      }
      if (!before.clean) {
        // A private checkpoint makes the repair merge operate on a stable
        // source tree without discarding the session's uncommitted work. Use
        // commit-tree + CAS rather than `git commit`, so hooks and signing
        // cannot mutate or block the repair boundary.
        const beforeHead = await git.revParse(isolation.worktreePath, "HEAD");
        await git.stageAll(isolation.worktreePath);
        const identity = await commitIdentityFor(isolation.worktreePath);
        const checkpoint = await git.commitStagedTree(
          isolation.worktreePath,
          "polyth: checkpoint before target-local AI repair",
          identity,
        );
        if (!await git.updateRef(
          isolation.worktreePath,
          `refs/heads/${localBranchName(isolation.worktreeBranch)}`,
          checkpoint.sha,
          beforeHead,
        )) {
          throw err("conflict", "the isolated workspace changed while preparing the target repair");
        }
      }
      const merged = await git.merge(isolation.worktreePath, repair.snapshotSha);
      if (!merged.ok) {
        isolationLog("target-repair-conflict", {
          sessionId: session.id,
          targetBranch: isolation.targetBranch,
          files: merged.conflicted,
        });
      }
    }
    const after = await git.status(isolation.worktreePath);
    const head = await git.revParse(isolation.worktreePath, "HEAD");
    const ancestor = await git.isAncestor(isolation.worktreePath, repair.snapshotSha, head).catch(() => false);
    if (!ancestor && after.conflicted.length === 0) {
      throw err("conflict", "the target repair could not be incorporated into the isolated workspace");
    }
    const files = after.conflicted.length ? repairFiles(after) : repair.files;
    const nextIsolation = transitionIsolation(isolation, {
      phase: "conflict",
      conflict: {
        message: `${isolation.targetBranch} has local changes that were safely backed up. Resolve the combined changes in this isolated workspace; proceeding commits the combination while the original snapshot remains available for recovery.`,
        files,
      },
      targetRepair: { ...repair, applied: true },
    });
    await persist(session.id, nextIsolation);
    isolationLog("target-repair-prepared", {
      sessionId: session.id,
      targetBranch: isolation.targetBranch,
      snapshotSha: repair.snapshotSha,
      conflictedFiles: files,
    });
    return { isolation: nextIsolation, files };
  };

  // Validation, managed checkout allocation and canonical create for one
  // session id. Callers hold withSession(sessionId).
  const createIsolatedSessionLocked = async (
    input: CreateIsolatedSessionInput,
    sessionId: string,
    delegatedBy?: SessionProjection,
    requester: IsolationRequesterSessions = deps.sessions,
  ): Promise<SessionRef> => {
    if (input.purpose !== undefined && (typeof input.purpose !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(input.purpose))) {
      throw err("invalid-input", "purpose must be a short lowercase id");
    }
    const project = await projectOf(input.projectId);
    assertLocalProject(project);
    const selected = selectIsolationRepositories(project, input.repositoryIds);
    for (const repository of selected.repositories) {
      if (!(await git.isRepo(repository.path))) {
        throw err("invalid-input", `repository is not a git repository: ${repository.alias}`);
      }
    }
    let source: SessionProjection | undefined;
    if (delegatedBy) {
      // Delegation is the one sanctioned nesting: the child's origin is the
      // parent's own checkout, proven by resolveDelegatedOrigin below.
      if (delegatedBy.projectId !== project.id) throw err("invalid-input", "delegating session does not belong to this project");
    } else if (input.sourceSessionId) {
      source = await requester.snapshot(input.sourceSessionId).catch(() => undefined);
      if (!source) throw err("not-found", "source session was not found");
      if (source.projectId !== project.id) throw err("invalid-input", "source session does not belong to this project");
      if (isolationWorkspaceRows(source).length > 0) throw err("invalid-input", "nested session isolation is not supported");
    }
    const allocations: IsolationAllocation[] = [];
    try {
      for (const repository of selected.repositories) {
        // A scalar branch choice belongs to the execution repository only.
        // Secondary repositories preserve their own source/current checkout
        // so unrelated repos are never forced to share a branch name.
        const origin = delegatedBy
          ? { ...await resolveDelegatedOrigin(project, repository, delegatedBy), sourceSessionId: delegatedBy.id }
          : await resolveOriginForRepository(
            project,
            repository,
            input,
            source,
            repository.id === selected.executionRepositoryId ? input.targetBranch : undefined,
          );
        const worktree = await managed.create({
          root: repository.path,
          sessionId,
          targetBranch: origin.branch,
          targetPath: repository.path,
          base: origin.startPoint,
          ...("nested" in origin && origin.nested ? { nested: true } : {}),
        });
        const isolation: SessionIsolation = {
          kind: "git-worktree",
          state: "active",
          createdAt: worktree.meta.createdAt,
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
          targetPath: resolve(repository.path),
          targetBranch: origin.branch,
          originPath: origin.originPath,
          baseCommit: origin.head,
          ...(origin.sourceSessionId ? { sourceSessionId: origin.sourceSessionId } : {}),
        };
        allocations.push({
          repositoryId: repository.id,
          alias: repository.alias,
          path: worktree.path,
          branch: origin.branch,
          isolation,
        });
      }
      const workspace = workspaceForIsolationAllocations(selected, allocations);
      const execution = allocations.find((allocation) => allocation.repositoryId === selected.executionRepositoryId)!;
      const created = await requester.create({
        id: sessionId,
        projectId: project.id,
        ...(delegatedBy ? { parentId: delegatedBy.id } : {}),
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        worktreePath: execution.path,
        workspace,
        // Keep the scalar projection bound to the canonical execution
        // repository until all consumers understand workspace rows.
        isolation: execution.isolation,
      });
      if (created.id !== sessionId) {
        throw err("conflict", "session identity does not match the managed workspace");
      }
      isolationLog("created", {
        sessionId: created.id,
        projectId: project.id,
        repositories: allocations.map((allocation) => allocation.repositoryId).join(","),
        executionRepositoryId: selected.executionRepositoryId,
      });
      return created;
    } catch (error) {
      // A rejected create can be an uncertain runtime admission. Only
      // roll back when the canonical row is proven absent; otherwise the
      // owner must recover the durable session and its checkouts.
      let canonical: SessionProjection | undefined;
      let lookupError: unknown;
      try { canonical = await deps.sessions.snapshot(sessionId); }
      catch (snapshotError) {
        if ((snapshotError as { code?: unknown })?.code !== "not-found") lookupError = snapshotError;
      }
      if (canonical || lookupError) {
        isolationLog("create-rollback-deferred", {
          sessionId,
          reason: canonical ? "canonical-session-exists" : "session-lookup-uncertain",
        });
        throw error;
      }
      const rollbackErrors: Error[] = [];
      for (const allocation of [...allocations].reverse()) {
        try {
          const result = await managed.removeOwned(
            allocation.isolation.targetPath,
            ownedRef(sessionId, allocation.isolation),
          );
          if (result.status === "unowned") {
            rollbackErrors.push(err("conflict", `isolation rollback ownership is unproven (${result.reason})`));
          }
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
        }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "isolated workspace creation rollback failed");
      throw error;
    }
  };
  const createIsolatedSessionUnderLock = (
    input: CreateIsolatedSessionInput,
    sessionId: string,
    requester?: IsolationRequesterSessions,
  ): Promise<SessionRef> =>
    withSession(sessionId, () => createIsolatedSessionLocked(input, sessionId, undefined, requester));

  // Callers hold withSession(sessionId).
  const discardLocked = async (sessionId: string, options: { returned?: boolean } = {}): Promise<SessionProjection> => {
    const { session, isolation } = await load(sessionId);
    if (isolation.state === "cleanup-pending" || isolation.state === "rebind-pending") return recoverCleanup(session, isolation);
    assertNotBusy(session);
    assertOp(isolation.state, "discard");
    await assertNoPendingDelegations(session, isolation);
    isolationLog("discard", { sessionId, projectId: session.projectId });
    const pending = transitionIsolation(withoutTargetRepair(isolation), { phase: "rebind-pending" });
    const pendingSession = await persist(sessionId, pending);
    try {
      const cleanup = transitionIsolation(pending, { phase: "cleanup-pending" });
      await rebindToTarget(pendingSession, pending, cleanup);
    } catch (error) {
      isolationLog("session-rebind-failed", {
        sessionId,
        discard: true,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    await notice(sessionId, "isolation/discarded", {
      targetBranch: isolation.targetBranch,
      ...(options.returned ? { returned: true } : {}),
    });
    return finishCleanup(sessionId);
  };

  /** Cheap Git view of one delegated child: no event reads, so a parent with
   * many children can be summarized on every status refresh. */
  const delegatedSummary = async (child: SessionProjection): Promise<DelegatedIsolationDto> => {
    const isolation = isolationOf(child) ?? isolationWorkspaceRows(child)[0]!.isolation;
    let state: IsolationState = isolation.state;
    let hasChanges = false;
    let revision = "";
    // A running child's checkout is still changing: its result is unknown.
    const running = isolationBlocksUserMutation(child.status) && child.status !== "archived";
    if (!isolationNeedsRecovery(state) && state !== "corrupt" && !running) {
      try {
        const source = await inspectSource(child.id, isolation);
        if (source.status === "missing") state = "missing";
        else if (source.status === "unowned") state = source.reason === "marker-corrupt" ? "corrupt" : "unowned";
        else {
          revision = await git.fingerprint(isolation.worktreePath);
          let targetHead = isolation.baseCommit;
          try { targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch); } catch { /* keep base */ }
          hasChanges = await git.hasUniqueChanges(isolation.worktreePath, targetHead);
          if (state === "merge-ready" && !hasChanges) state = "active";
        }
      } catch {
        state = "unowned";
      }
    }
    return {
      sessionId: child.id,
      title: child.title,
      status: child.status,
      state,
      hasChanges,
      revision,
      worktreePath: isolation.worktreePath,
      worktreeBranch: isolation.worktreeBranch,
      targetBranch: isolation.targetBranch,
      ...(isolation.state === "conflict" && isolation.conflict.files.length
        ? { conflictFiles: isolation.conflict.files.slice(0, 50) }
        : {}),
    };
  };

  /** The children a parent delegated into isolated checkouts and still owes a
   * merge or discard decision. */
  const delegatedChildrenOf = async (parent: SessionProjection): Promise<SessionProjection[]> =>
    (await deps.sessions.list(parent.projectId)).filter((candidate) =>
      candidate.parentId === parent.id
      && candidate.projectId === parent.projectId
      && isolationWorkspaceRows(candidate).some((row) => row.isolation.sourceSessionId === parent.id));

  const service = {
    /** `options.sessionId` is a caller-derived canonical id (keyed HTTP
     *  create: account+Space+clientOperationId). Requests for one id are
     *  serialized; a repeat returns the session — and the managed checkouts —
     *  the first request made instead of allocating a second worktree.
     *  `options.sessions` is the requesting person's scoped session service:
     *  the chat is theirs and starts with the Space's default audience. */
    async createIsolatedSession(
      input: CreateIsolatedSessionInput,
      options: { sessionId?: string; sessions?: IsolationRequesterSessions } = {},
    ): Promise<SessionRef> {
      if (options.sessionId === undefined) return createIsolatedSessionUnderLock(input, randomUUID(), options.sessions);
      const sessionId = options.sessionId;
      if (!UUID_RE.test(sessionId)) throw err("invalid-input", "session id is invalid");
      return withSession(sessionId, async () => {
        let prior: SessionProjection | undefined;
        try { prior = await deps.sessions.snapshot(sessionId); }
        catch (error) {
          if ((error as { code?: unknown })?.code !== "not-found") throw error;
        }
        if (!prior) return createIsolatedSessionLocked(input, sessionId, undefined, options.sessions);
        if (prior.projectId !== input.projectId || !isolationOf(prior)) {
          throw err("conflict", "clientOperationId was already used for another session");
        }
        if (prior.status === "failed") {
          throw Object.assign(err("session-create-failed", "session creation failed"), {
            status: 409,
            mutationOutcome: "rejected",
            sessionId,
          });
        }
        return { id: sessionId };
      });
    },

    /** Polyth delegation into an isolated checkout. The child is a canonical
     *  subagent of `parentSessionId`, branched from the parent's last commit
     *  in the parent's own checkout, and its merge-back returns there. Only
     *  the parent's execution repository is isolated. */
    async createDelegatedSession(input: ServerDelegatedSessionInput): Promise<ServerDelegatedSessionCreated> {
      const parent = await deps.sessions.snapshot(input.parentSessionId);
      if (parent.status === "archived") throw err("conflict", "an archived session cannot delegate work");
      const project = await projectOf(parent.projectId);
      const registered = projectRepositories({ ...project, name: project.id });
      const repositoryIds = registered.length > 1
        ? [parent.workspace?.executionRepositoryId ?? selectIsolationRepositories(project).executionRepositoryId]
        : undefined;
      const sessionId = randomUUID();
      await withSession(sessionId, () => createIsolatedSessionLocked({
        projectId: parent.projectId,
        ...(repositoryIds ? { repositoryIds } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.harness ? { harness: input.harness } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      }, sessionId, parent));
      const isolation = isolationOf(await deps.sessions.snapshot(sessionId));
      if (!isolation) throw err("conflict", "the delegated session has no isolation record");
      const origin = await git.status(isolation.originPath ?? isolation.targetPath).catch(() => undefined);
      return { id: sessionId, isolation, originUncommitted: origin ? repairFiles(origin).length : 0 };
    },

    /** Move an existing ordinary session into its own managed checkouts: one
     *  per member repository, branched from the HEAD of the checkout it works
     *  in now, which is also where merge-back returns. The canonical runtime
     *  rebind releases its execution there and starts a fresh epoch in the
     *  isolated checkout; history and parent links stay. Uncommitted work is
     *  left where it is (it may belong to other chats sharing that checkout).
     *  `options.sessions` is the requester's scoped session service, so the
     *  Space and the right to manage the chat are checked there. A retry
     *  after an unconfirmed epoch finishes the same isolation. */
    async isolateSession(
      sessionId: string,
      options: { sessions?: IsolationExistingSessions } = {},
    ): Promise<IsolateSessionResultDto> {
      const requester = options.sessions ?? deps.sessions;
      if (!requester.rebindWorkspace) throw err("unsupported", "session workspace rebind is unavailable");
      const rebind = requester.rebindWorkspace.bind(requester);
      return withSession(sessionId, async () => {
        const session = await requester.snapshot(sessionId);
        if (session.status === "archived") throw err("conflict", "an archived session cannot be isolated");
        // A conversation has no agent and no runtime workspace to move.
        if (session.purpose === SESSION_PURPOSE_CONVERSATION) {
          throw err("invalid-input", "a conversation cannot be isolated; start a session from its messages");
        }
        assertNotBusy(session);
        const project = await projectOf(session.projectId);
        assertLocalProject(project);
        const source = { ...project, name: project.id };
        const executionPath = resolve(workspaceExecutionPath(source, session));
        const owned = isolationWorkspaceRows(session);
        if (owned.length > 0) {
          // An earlier request published the isolated workspace but its
          // runtime epoch was not confirmed: the scalar record is still
          // missing. Finishing that rebind is the only thing left to do.
          const execution = owned.find((row) => samePath(row.path, executionPath));
          if (session.isolation || !execution || !session.workspace
            || execution.isolation.worktreeBranch !== isolateBranchName(sessionId)
            || !samePath(execution.isolation.worktreePath, execution.path)) {
            throw err("conflict", "session is already isolated");
          }
          const finished = await rebind(sessionId, {
            workspace: session.workspace,
            expectedWorkspaceRevision: session.workspace.revision ?? 0,
            worktreePath: execution.path,
            branch: execution.isolation.targetBranch,
            isolation: execution.isolation,
          });
          return { ok: true, session: finished, targetBranch: execution.isolation.targetBranch, originUncommitted: 0 };
        }
        const members = resolveWorkspaceContext(source, session).repositories;
        const unavailable = members.find((row) => row.state !== "ready");
        if (unavailable) throw err("conflict", `repository checkout is unavailable: ${unavailable.alias}`);
        const executionRepositoryId = members.find((row) => samePath(row.path, executionPath))?.repositoryId;
        if (!executionRepositoryId) throw err("conflict", "session execution checkout is not a workspace member");
        const registered = new Map(projectRepositories(source).map((repository) => [repository.id, repository]));
        const parent = session.parentId
          ? await deps.sessions.snapshot(session.parentId).catch(() => undefined)
          : undefined;
        const parentCheckout = (repositoryId: string): string | undefined => {
          if (!parent || parent.projectId !== session.projectId) return undefined;
          try {
            return resolveWorkspaceContext(source, parent).repositories
              .find((row) => row.repositoryId === repositoryId && row.state === "ready")?.path;
          } catch { return undefined; }
        };
        const allocations: IsolationAllocation[] = [];
        let originUncommitted = 0;
        try {
          for (const member of members) {
            const repository = registered.get(member.repositoryId);
            if (!repository) throw err("conflict", `repository is no longer registered: ${member.alias}`);
            if (!(await git.isRepo(repository.path))) {
              throw err("invalid-input", `repository is not a git repository: ${repository.alias}`);
            }
            // The session is its own delegator: it branches from, and later
            // returns to, exactly the checkout it works in. A shared child of
            // an isolated parent nests into that parent's managed checkout.
            const origin = await resolveDelegatedOrigin(project, repository, session, { path: member.path });
            const parentPath = parentCheckout(repository.id);
            const worktree = await managed.create({
              root: repository.path,
              sessionId,
              targetBranch: origin.branch,
              targetPath: repository.path,
              base: origin.startPoint,
              ...(origin.nested ? { nested: true } : {}),
            });
            const isolation: SessionIsolation = {
              kind: "git-worktree",
              state: "active",
              createdAt: worktree.meta.createdAt,
              worktreePath: worktree.path,
              worktreeBranch: worktree.branch,
              targetPath: resolve(repository.path),
              targetBranch: origin.branch,
              originPath: origin.originPath,
              baseCommit: origin.head,
              // A parent that executes in the origin checkout is the
              // delegator: it lists this child and merges it like its own.
              ...(parent && parentPath && samePath(parentPath, origin.originPath) ? { sourceSessionId: parent.id } : {}),
            };
            allocations.push({ repositoryId: repository.id, alias: member.alias, path: worktree.path, branch: origin.branch, isolation });
            const status = await git.status(origin.originPath).catch(() => undefined);
            if (status) originUncommitted += repairFiles(status).length;
          }
          const execution = allocations.find((allocation) => allocation.repositoryId === executionRepositoryId)!;
          const workspace: SessionWorkspace = {
            mode: session.workspace?.mode ?? (members.length === registered.size ? "all" : "subset"),
            revision: session.workspace?.revision ?? 0,
            executionRepositoryId,
            repositories: allocations.map((allocation) => ({
              repositoryId: allocation.repositoryId,
              alias: allocation.alias,
              path: allocation.path,
              state: "ready" as const,
              branch: allocation.branch,
              isolation: allocation.isolation,
            })),
          };
          isolationLog("isolate-existing", {
            sessionId,
            projectId: session.projectId,
            from: executionPath,
            to: execution.path,
            repositories: allocations.map((allocation) => allocation.repositoryId).join(","),
          });
          const rebound = await rebind(sessionId, {
            workspace,
            expectedWorkspaceRevision: session.workspace?.revision ?? 0,
            worktreePath: execution.path,
            branch: execution.branch,
            isolation: execution.isolation,
          });
          await notice(sessionId, "isolation/started", {
            targetBranch: execution.isolation.targetBranch,
            ...(originUncommitted ? { originUncommitted } : {}),
          });
          return { ok: true, session: rebound, targetBranch: execution.isolation.targetBranch, originUncommitted };
        } catch (error) {
          // The rebind publishes the isolated workspace before it confirms
          // the new runtime epoch. Once any checkout is recorded (or the
          // record cannot be read) the checkouts are the session's evidence:
          // keep them for the retry above instead of guessing.
          let current: SessionProjection | undefined;
          let lookupError: unknown;
          try { current = await deps.sessions.snapshot(sessionId); }
          catch (snapshotError) { lookupError = snapshotError; }
          const recorded = current && isolationWorkspaceRows(current).some((row) =>
            allocations.some((allocation) => samePath(allocation.path, row.isolation.worktreePath)));
          if (recorded || lookupError) {
            isolationLog("isolate-existing-rollback-deferred", {
              sessionId,
              reason: recorded ? "workspace-committed" : "session-lookup-uncertain",
            });
            throw error;
          }
          const rollbackErrors: Error[] = [];
          for (const allocation of [...allocations].reverse()) {
            try {
              const result = await managed.removeOwned(allocation.isolation.targetPath, ownedRef(sessionId, allocation.isolation));
              if (result.status === "unowned") rollbackErrors.push(err("conflict", `isolation rollback ownership is unproven (${result.reason})`));
            } catch (cleanupError) {
              rollbackErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
            }
          }
          if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "session isolation rollback failed");
          throw error;
        }
      });
    },

    async delegatedChildren(parentSessionId: string): Promise<DelegatedIsolationDto[]> {
      const parent = await deps.sessions.snapshot(parentSessionId);
      return Promise.all((await delegatedChildrenOf(parent)).map(delegatedSummary));
    },

    /** Merge a delegated child into its parent's checkout and release the
     *  child's checkout. A child without changes is only released. Overlapping
     *  uncommitted parent work is refused, never AI-repaired: the parent agent
     *  can commit its own work and merge again. */
    async mergeDelegated(sessionId: string): Promise<ServerDelegatedMergeResult> {
      const released = await withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        if ((isolation.state !== "active" && isolation.state !== "merge-ready") || isolation.targetRepair
          || isolationBlocksUserMutation(session.status) || !existsSync(isolation.worktreePath)) return null;
        let targetHead = isolation.baseCommit;
        try { targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch); } catch { /* keep base */ }
        if (await git.hasUniqueChanges(isolation.worktreePath, targetHead)) return null;
        return { session: await discardLocked(sessionId), targetBranch: isolation.targetBranch };
      });
      if (released) {
        return {
          merged: false,
          targetBranch: released.targetBranch,
          finalized: !isolationOf(released.session),
          session: released.session,
        };
      }
      const result = await service.mergeBack(sessionId, { allowTargetRepair: false });
      return {
        merged: true,
        ...(result.commit ? { commit: result.commit } : {}),
        targetBranch: result.targetBranch,
        finalized: result.finalized,
        session: result.session,
      };
    },

    /** Lazily add managed checkouts after an idle isolated session's runtime
     * remains bound to its existing execution repository. The canonical
     * workspace patch is the commit point; uncertain persistence preserves
     * owned checkouts for recovery instead of guessing. */
    materializeRepositories,
    updateIsolatedWorkspace,
    keepRepository: (sessionId: string, repositoryId: string) => repositoryLifecycle(sessionId, repositoryId, "keep"),
    discardRepository: (sessionId: string, repositoryId: string) => repositoryLifecycle(sessionId, repositoryId, "discard"),
    async mergeRepository(sessionId: string, repositoryId: string, options: { requester?: GitActor } = {}): Promise<IsolationMergeResultDto> {
      if (!deps.sessions.withWorkspaceMutation) throw err("unsupported", "canonical workspace mutation is unavailable");
      const original = await deps.sessions.snapshot(sessionId);
      const initialRow = original.workspace?.repositories.find((candidate) => candidate.repositoryId === repositoryId);
      if (!initialRow?.isolation) throw err("not-found", "repository isolation row is unavailable");
      const revision = original.workspace?.revision ?? 0;
      const result = await deps.sessions.withWorkspaceMutation(sessionId, revision, async (scope) => {
        const rowSessions: IsolationSessionApi = {
          create: deps.sessions.create,
          list: deps.sessions.list,
          send: deps.sessions.send,
          snapshot: async (id) => {
          const current = await scope.snapshot();
          const currentRow = current.workspace?.repositories.find((candidate) => candidate.repositoryId === repositoryId);
          if (!currentRow) throw err("not-found", "repository isolation row is unavailable");
          return { ...current, worktreePath: currentRow.path, workspace: { mode: "subset", revision: current.workspace?.revision ?? 0, executionRepositoryId: repositoryId, repositories: [currentRow] }, isolation: currentRow.isolation };
          },
          patchIsolation: async (id, next) => {
          const current = await scope.snapshot();
          const workspace = current.workspace;
          if (!workspace) throw err("conflict", "session workspace is unavailable");
          const selectedRow = workspace.repositories.find((candidate) => candidate.repositoryId === repositoryId);
          if (!selectedRow?.isolation) throw err("not-found", "repository isolation row is unavailable");
          const nextRows = next
            ? workspace.repositories.map((candidate) => candidate.repositoryId === repositoryId ? { ...candidate, isolation: next } : candidate)
            : workspace.repositories.map((candidate) => candidate.repositoryId === repositoryId
              ? { ...candidate, path: selectedRow.isolation!.targetPath, state: "ready" as const, branch: selectedRow.isolation!.targetBranch, isolation: undefined }
              : candidate);
          const isExecutionRow = workspace.executionRepositoryId === repositoryId;
          await scope.commit(
            { ...workspace, revision: workspace.revision ?? 0, repositories: nextRows },
            isExecutionRow ? { isolation: next } : undefined,
          );
          return rowSessions.snapshot(sessionId);
          },
          rebindWorkspace: async (id, input) => {
          const current = await scope.snapshot();
          const workspace = current.workspace;
          if (!workspace) throw err("conflict", "session workspace is unavailable");
          const destination = input.worktreePath === null ? initialRow.isolation!.targetPath : input.worktreePath;
          const nextRows = workspace.repositories.map((candidate) => candidate.repositoryId === repositoryId
            ? { ...candidate, ...(destination ? { path: destination } : {}), ...(input.branch ? { branch: input.branch } : {}), ...(input.isolation ? { isolation: input.isolation } : {}) }
            : candidate);
          // A secondary row publishes through the canonical workspace while
          // the session runtime remains anchored to its original execution
          // repository. Only an operation on that actual anchor may update
          // the scalar runtime binding.
          const isExecutionRow = workspace.executionRepositoryId === repositoryId;
          await scope.commit(
            { ...workspace, revision: workspace.revision ?? 0, repositories: nextRows },
            isExecutionRow
              ? { worktreePath: input.worktreePath, branch: input.branch, isolation: input.isolation }
              : undefined,
          );
          return rowSessions.snapshot(sessionId);
          },
        };
        const rowProjectApi: IsolationProjectApi = {
          get: async (id) => {
            const project = await deps.projects.get(id);
            return project ? { ...project, path: initialRow.isolation!.targetPath } : undefined;
          },
          ...(deps.projects.list ? { list: async () => (await deps.projects.list!()).map((project) => ({ ...project, path: project.id === original.projectId ? initialRow.isolation!.targetPath : project.path })) } : {}),
        };
        const rowService = createIsolationService({ ...deps, sessions: rowSessions, projects: rowProjectApi });
        return rowService.mergeBack(sessionId, options.requester ? { requester: options.requester } : {});
      });
      return { ...result, session: await deps.sessions.snapshot(sessionId) };
    },

    /** Recover one repository row without allowing a multi-repository session
     * to fall through the scalar recovery state machine. The row adapter used
     * by mergeRepository binds the operation to the canonical mutation seam,
     * so publication receipts and cleanup are checked while the real runtime
     * is released and sibling rows remain intact. */
    async recoverRepository(sessionId: string, repositoryId: string): Promise<SessionProjection> {
      const current = await deps.sessions.snapshot(sessionId);
      const row = current.workspace?.repositories.find((candidate) => candidate.repositoryId === repositoryId);
      if (!row?.isolation) throw err("not-found", "repository isolation row is unavailable");
      if (!isolationNeedsRecovery(row.isolation.state)) return current;
      // Cleanup is a row-owned deletion intent. Recover it directly under the
      // canonical mutation seam instead of routing a synthetic one-row
      // session through scalar finishCleanup (which would mistake the row's
      // source checkout for the session's execution anchor).
      if ((row.isolation.state === "cleanup-pending" || row.isolation.state === "rebind-pending") && row.isolation.resultCommit) {
        // A published merge keeps the repository row as a registered target;
        // finish it in-place rather than routing a synthetic row session whose
        // scalar cwd cannot represent the real multi-repository anchor.
        if (!deps.sessions.withWorkspaceMutation) throw err("unsupported", "canonical workspace mutation is unavailable");
        const revision = current.workspace?.revision ?? 0;
        return deps.sessions.withWorkspaceMutation(sessionId, revision, async (scope) => {
          const snapshot = await scope.snapshot();
          const workspace = snapshot.workspace;
          const pending = workspace?.repositories.find((candidate) => candidate.repositoryId === repositoryId);
          if (!workspace || !pending?.isolation) throw err("not-found", "repository isolation row is unavailable");
          const isolation = pending.isolation;
          const receiptRef = isolation.publish?.receiptRef ?? receiptRefName(sessionId);
          const receipt = await git.readRef(isolation.targetPath, receiptRef).catch(() => null);
          if (receipt !== isolation.resultCommit) return snapshot;
          const ownership = await managed.inspectOwned(isolation.targetPath, ownedRef(sessionId, isolation));
          if (ownership.status === "unowned") throw err("conflict", `isolation ownership is unproven (${ownership.reason})`);
          if (ownership.status === "owned") {
            const dependents = await sourceDependentsAt(sessionId, isolation.worktreePath);
            if (dependents.length) throw err("conflict", "another session still depends on this repository checkout");
            await closeProcesses(isolation.worktreePath);
            if (isolation.sourceSnapshotSha && !(await git.workingTreeMatches(isolation.worktreePath, isolation.sourceSnapshotSha))) {
              throw err("conflict", "repository checkout changed after the publication snapshot");
            }
            // Multi-repository rows have no single execution anchor for a
            // project-relative history path; preservation is single-repository
            // only (see docs/dev/workspace.md).
            const removed = await managed.removeOwned(isolation.targetPath, ownedRef(sessionId, isolation));
            if (removed.status === "unowned") throw err("conflict", `isolation ownership changed during recovery (${removed.reason})`);
          }
          const nextWorkspace: SessionWorkspace = {
            ...workspace,
            repositories: workspace.repositories.map((candidate) => candidate.repositoryId === repositoryId
              ? { ...candidate, path: isolation.targetPath, branch: isolation.targetBranch, state: "ready" as const, isolation: undefined }
              : candidate),
          };
          const isExecutionRow = workspace.executionRepositoryId === repositoryId;
          const project = await projectOf(snapshot.projectId);
          const committed = await scope.commit(nextWorkspace, isExecutionRow
            ? { worktreePath: samePath(isolation.targetPath, project.path) ? null : isolation.targetPath, branch: isolation.targetBranch, isolation: null }
            : undefined);
          await releaseIsolationRefs(sessionId, isolation);
          return committed;
        });
      }
      if (row.isolation.state === "cleanup-pending" || row.isolation.state === "rebind-pending") {
        if (!deps.sessions.withWorkspaceMutation) throw err("unsupported", "canonical workspace mutation is unavailable");
        const revision = current.workspace?.revision ?? 0;
        return deps.sessions.withWorkspaceMutation(sessionId, revision, async (scope) => {
          const snapshot = await scope.snapshot();
          const workspace = snapshot.workspace;
          const pending = workspace?.repositories.find((candidate) => candidate.repositoryId === repositoryId);
          if (!workspace || !pending?.isolation) throw err("not-found", "repository isolation row is unavailable");
          if (workspace.executionRepositoryId === repositoryId) {
            const replacement = workspace.repositories.find((candidate) => candidate.repositoryId !== repositoryId && candidate.state !== "missing" && candidate.isolation);
            if (!replacement) throw err("conflict", "cannot recover discarded execution repository without a ready replacement");
          }
          const ownership = await managed.inspectOwned(pending.isolation.targetPath, ownedRef(sessionId, pending.isolation));
          if (ownership.status === "unowned") throw err("conflict", `isolation ownership is unproven (${ownership.reason})`);
          if (ownership.status === "owned") {
            if (workspace.executionRepositoryId === repositoryId) {
              throw err("conflict", "cannot recover discarded execution repository without a replacement anchor");
            }
            const dependents = await sourceDependentsAt(sessionId, pending.isolation.worktreePath);
            if (dependents.length) throw err("conflict", "another session still depends on this repository checkout");
            await closeProcesses(pending.isolation.worktreePath);
            if (pending.isolation.sourceSnapshotSha
              && !(await git.workingTreeMatches(pending.isolation.worktreePath, pending.isolation.sourceSnapshotSha))) {
              throw err("conflict", "repository checkout changed after the cleanup snapshot");
            }
            const removed = await managed.removeOwned(pending.isolation.targetPath, ownedRef(sessionId, pending.isolation));
            if (removed.status === "unowned") throw err("conflict", `isolation ownership changed during recovery (${removed.reason})`);
          }
          const committed = await scope.commit({ ...workspace, repositories: workspace.repositories.filter((candidate) => candidate.repositoryId !== repositoryId) });
          await releaseIsolationRefs(sessionId, pending.isolation);
          return committed;
        });
      }
      // Publication recovery is admitted only with a positive receipt. A
      // missing or mismatched receipt is ambiguous and must remain durable for
      // human recovery; it must never enter merge admission and republish.
      if ((row.isolation.state === "merging" || row.isolation.state === "publishing") && row.isolation.publish) {
        const intent = row.isolation.publish;
        const receipt = intent.receiptRef ? await git.readRef(row.isolation.targetPath, intent.receiptRef).catch(() => null) : null;
        if (receipt !== intent.resultCommit) return current;
      }
      const recovered = await this.mergeRepository(sessionId, repositoryId);
      return recovered.session;
    },

    /** Destructive half of canonical session deletion. The caller holds the
     * session mutation lock, already authorized the delete, and supplies both
     * the locked projection and the runtime-owner release fence; this package
     * proves Git ownership before removing any filesystem resource. The
     * projection is passed in rather than re-read through the governed session
     * facade: during canonical deletion the resource is already `deleting`, and
     * a facade read of that lifecycle fails closed as not-found. */
    async cleanupForSessionDelete(
      session: SessionProjection,
      releaseExecution: (cwd: string) => Promise<void>,
    ): Promise<void> {
      return withSession(session.id, async () => {
        const rows = isolationWorkspaceRows(session);
        if (rows.length === 0) throw err("invalid-input", "session is not isolated");
        // An absent path is enough to prove that there is no filesystem
        // resource left to release. If a path still exists, Git inspection
        // must succeed and prove ownership; a transient Git error is never
        // downgraded to "missing". Inspect every repository before deleting
        // any one so a foreign or replaced checkout cannot cause a partial
        // destructive cleanup.
        const inspected = await Promise.all(rows.map(async (row) => ({
          row,
          source: await filesystemPathExists(row.isolation.worktreePath)
            ? await managed.inspectOwned(row.isolation.targetPath, ownedRef(session.id, row.isolation))
            : { status: "missing" as const },
        })));
        const unowned = inspected.find((entry) => entry.source.status === "unowned");
        if (unowned && unowned.source.status === "unowned") {
          throw err(
            "conflict",
            `refusing to delete an isolation workspace whose ownership is not proven (${unowned.source.reason})`,
          );
        }
        for (const entry of inspected) {
          const dependents = await sourceDependentsAt(session.id, entry.row.isolation.worktreePath);
          if (dependents.length > 0) {
            throw err("conflict", "another session still depends on an isolated workspace; delete or move it first");
          }
        }
        // Runtime authority is the canonical session binding, not the health
        // of the recorded execution checkout. Release it even when that row's
        // filesystem disappeared; otherwise a live runtime can still access
        // sibling owned repositories while deletion proceeds.
        await releaseExecution(session.worktreePath ?? (await projectOf(session.projectId)).path);
        const closed = new Set<string>();
        for (const entry of inspected) {
          // A checkout that is already gone can still have utility runtimes
          // and terminals whose cwd points at it.
          if (closed.has(entry.row.isolation.worktreePath)) continue;
          await closeProcesses(entry.row.isolation.worktreePath);
          closed.add(entry.row.isolation.worktreePath);
        }
        // Integration worktrees are also Polyth-owned resources for this
        // session. Remove them before the sources so a later failure never
        // leaves a live canonical session pointing at an already-deleted cwd.
        const roots = new Set(rows.map((row) => row.isolation.targetPath));
        for (const root of roots) await managed.pruneIntegrationsForSession(root, session.id);
        for (const entry of inspected) {
          if (entry.source.status !== "owned") continue;
          const removed = await managed.removeOwned(entry.row.isolation.targetPath, ownedRef(session.id, entry.row.isolation));
          if (removed.status === "unowned") {
            throw err("conflict", `isolation ownership changed during deletion (${removed.reason})`);
          }
        }
        for (const row of rows) await releaseIsolationRefs(session.id, row.isolation);
        isolationLog("session-delete-cleanup", {
          sessionId: session.id,
          projectId: session.projectId,
          repositories: rows.map((row) => row.repositoryId).join(","),
          status: inspected.some((entry) => entry.source.status === "owned") ? "removed" : "already-gone",
        });
      });
    },

    async getStatus(sessionId: string, events?: readonly SessionEvent[]): Promise<IsolationStatusDto> {
      const session = await deps.sessions.snapshot(sessionId);
      const isolation = isolationOf(session);
      if (!isolation) return { isolation: null, suggestion: null, effectiveState: null, actions: NO_ACTIONS };
      if (isolationWorkspaceRows(session).length > 1) {
        return {
          isolation,
          suggestion: null,
          effectiveState: isolation.state,
          actions: NO_ACTIONS,
        };
      }
      if (isolationNeedsRecovery(isolation.state)) {
        if ((isolation.state === "merging" || isolation.state === "publishing")
          && publicationBindingError(session, isolation)) {
          return { isolation, suggestion: null, effectiveState: "corrupt", actions: NO_ACTIONS };
        }
        let canAbandon = false;
        if (isolation.state === "cleanup-pending") {
          const source = await inspectSource(session.id, isolation).catch(() => ({ status: "missing" as const }));
          const hasDependents = (await sourceDependents(session.id, isolation)).length > 0;
          try {
            const project = await projectOf(session.projectId);
            const destination = await destinationFor(session, isolation);
            const cwd = session.worktreePath ?? project.path;
            canAbandon = samePath(cwd, destination.path)
              && !hasDependents
              && await sourceRequiresPreservation(isolation, source);
          } catch { /* destination is not safe */ }
        }
        return {
          isolation,
          suggestion: null,
          effectiveState: isolation.state,
          actions: { ...NO_ACTIONS, canRecover: true, canAbandon },
        };
      }
      // Independent reads start together: the destination checkout and the
      // delegated children do not depend on the suggestion. Each carries its
      // own handler, so an early return leaves no unhandled rejection.
      const destinationRead = destinationFor(session, isolation).then(() => true, () => false);
      const delegatedRead = deps.sessions.list(session.projectId).then(async (candidates) => {
        const pending = nestedIsolationsAt(candidates, session.id, isolation.worktreePath);
        return pending.length ? Promise.all(pending.map(delegatedSummary)) : undefined;
      });
      delegatedRead.catch(() => undefined);
      const durableEvents = events ?? await readTurnFacts(sessionId, isolation);
      let suggestion: IsolationSuggestionDto | null;
      try {
        suggestion = await suggestionFor(session, durableEvents);
      } catch {
        return {
          isolation,
          suggestion: {
            eligible: false,
            hasChanges: false,
            targetBranch: isolation.targetBranch,
            targetDirty: false,
            revision: "",
            reason: "unowned",
          },
          effectiveState: "unowned",
          actions: NO_ACTIONS,
        };
      }
      const effectiveState = derivedState(isolation, suggestion);
      const destinationReady = await destinationRead;
      if (!destinationReady && suggestion?.eligible) {
        suggestion = { ...suggestion, eligible: false, reason: "destination-unavailable" };
      }
      const blocked = isolationBlocksUserMutation(session.status);
      const sourceReady = effectiveState !== "missing" && effectiveState !== "unowned" && effectiveState !== "corrupt";
      const hasChanges = suggestion?.hasChanges === true;
      // A conflict a later completed turn settled merges again (merge-back
      // accepts the conflict state); an open one only offers resolution.
      const conflict = isolation.state === "conflict" && suggestion?.eligible !== true;
      const delegated = await delegatedRead;
      // Another target is a way out of a vanished destination or a conflict
      // too, so it does not wait on either; it waits on the work being at rest.
      const choosable = !blocked && sourceReady && hasChanges && !delegated
        && suggestion?.reason !== "runtime-recovering"
        && USER_OPS.merge.has(isolation.state);
      const targets = choosable ? await targetsFor(isolation).catch(() => []) : [];
      return {
        isolation,
        suggestion,
        ...(delegated ? { delegated } : {}),
        effectiveState,
        ...(targets.length ? { targets } : {}),
        actions: {
          ...(targets.some((target) => !target.current) ? { canChooseTarget: true } : {}),
          canReview: sourceReady,
          canMerge: !blocked && sourceReady && destinationReady && hasChanges
            && !conflict && suggestion?.reason !== "target-overlap" && !delegated,
          canKeep: !blocked && sourceReady && USER_OPS.keep.has(isolation.state),
          canResolve: !blocked && sourceReady
            && (isolation.state === "conflict" || suggestion?.reason === "target-overlap"),
          canDiscard: !blocked && destinationReady && !delegated
            && (effectiveState === "missing" || (sourceReady && USER_OPS.discard.has(effectiveState))),
          canRecover: false,
          canAbandon: false,
        },
      };
    },

    /** What merging this session's work into its target branch would conflict
     *  on now. Uncommitted edits count: the workspace is snapshotted into an
     *  unreferenced commit exactly as Merge does, and the merge is previewed
     *  without touching either checkout, the index or any ref. */
    async conflictPreview(sessionId: string): Promise<IsolationConflictPreview> {
      const { isolation } = await load(sessionId);
      if (isolation.state !== "active" && isolation.state !== "merge-ready" && isolation.state !== "conflict") {
        throw err("conflict", `isolation cannot preview a merge from ${isolation.state}`);
      }
      if (!existsSync(isolation.worktreePath)) {
        throw err("not-found", "the isolated workspace is no longer available");
      }
      await assertOwnedSource(sessionId, isolation);
      const target = await git.revParse(isolation.targetPath, isolation.targetBranch);
      const snapshot = await git.snapshotCommit(isolation.worktreePath, `${SNAPSHOT_MESSAGE} (${sessionId.slice(0, 8)})`);
      const preview = await git.mergeConflicts(isolation.worktreePath, { target, source: snapshot.sha });
      const recorded = isolation.conflict?.files ?? [];
      const reported = new Set(recorded);
      // The preview does not follow renames, so a path one side renamed reads
      // as deleted there. Merge does follow them: such a row is kept only when
      // the last merge attempt reported that path as well.
      const files = preview.files.filter((file) =>
        (file.kind !== "deleted-in-target" && file.kind !== "deleted-in-source") || reported.has(file.path));
      return { ...preview, files, targetBranch: isolation.targetBranch, recorded };
    },

    async keepIsolated(sessionId: string): Promise<SessionProjection> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        assertOp(isolation.state, "keep");
        if (!existsSync(isolation.worktreePath)) {
          throw err("not-found", "the isolated workspace is no longer available");
        }
        await assertOwnedSource(sessionId, isolation);
        const revision = await git.fingerprint(isolation.worktreePath);
        isolationLog("keep-isolated", { sessionId, revision });
        return persist(sessionId, transitionIsolation(withoutTargetRepair(isolation), {
          phase: "active",
          dismissedRevision: revision,
        }));
      });
    },

    async onTurnCompleted(sessionId: string, events: readonly SessionEvent[]): Promise<SessionProjection | null> {
      return withSession(sessionId, async () => {
        const session = await deps.sessions.snapshot(sessionId).catch(() => undefined);
        if (!session) return null;
        const isolation = isolationOf(session);
        if (!isolation || isolationNeedsRecovery(isolation.state)) return session;
        if (isolation.state === "missing") return session;
        const suggestion = await suggestionFor(session, events);
        if (suggestion?.reason === "missing") return session;
        if (suggestion?.eligible && isolation.state !== "merge-ready") {
          return persist(sessionId, transitionIsolation(isolation, { phase: "merge-ready" }));
        }
        if (!suggestion?.eligible && isolation.state === "merge-ready" && suggestion?.reason === "no-changes") {
          return persist(sessionId, transitionIsolation(isolation, { phase: "active" }));
        }
        return session;
      });
    },

    /** `allowTargetRepair: false` refuses overlapping uncommitted work in the
     *  destination instead of preparing an AI repair receipt for it. */
    async mergeBack(
      sessionId: string,
      options: {
        allowTargetRepair?: boolean;
        requester?: GitActor;
        /** Integrate into this checked-out branch instead of the recorded one. */
        target?: { branch: string; path: string };
        /** Push the target branch once the work is published there. */
        push?: boolean;
      } = {},
    ): Promise<IsolationMergeResultDto> {
      const allowTargetRepair = options.allowTargetRepair !== false;
      const withPush = async (result: IsolationMergeResultDto, session: SessionProjection, isolation: SessionIsolation) =>
        options.push ? { ...result, pushed: await pushTarget(session, isolation, options.requester) } : result;
      return withSession(sessionId, async () => acting(await deps.sessions.snapshot(sessionId), options.requester, async () => {
        const loaded = await load(sessionId);
        let { session, isolation } = loaded;
        if (isolationNeedsRecovery(isolation.state)) {
          session = await recoverSessionLocked(session);
          const recovered = isolationOf(session);
          if (!recovered) {
            return publishedResult(isolation, session);
          }
          isolation = recovered;
        }
        if (isolationNeedsRecovery(isolation.state)) {
          return publishedResult(isolation, session);
        }
        if (isolation.state === "missing" || !existsSync(isolation.worktreePath)) {
          throw err("not-found", "the isolated workspace is no longer available");
        }
        assertNotBusy(session);
        assertOp(isolation.state, "merge");
        if (options.push && isManagedBranch(localBranchName(isolation.targetBranch))) {
          throw unpublished(err("invalid-input", "a delegated isolation merges into its parent's workspace, which is not pushed"));
        }
        if (options.target) {
          await assertOwnedSource(sessionId, isolation);
          ({ session, isolation } = await retargetAtRest(session, isolation, options.target));
        }
        if (isolation.targetRepair && !isolation.targetRepair.applied) {
          throw err("conflict", `${isolation.targetBranch} has local changes that need AI reconciliation before integration`);
        }
        await assertOwnedSource(sessionId, isolation);
        // Publication is only admitted when the canonical session has a
        // concrete, branch-correct return workspace. A later disappearance is
        // still recoverable through cleanup-pending without republishing.
        await destinationFor(session, isolation);
        await assertNoPendingDelegations(session, isolation);
        await assertNestedTargetOpen(session, isolation);
        const targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch);
        if (!(await git.hasUniqueChanges(isolation.worktreePath, targetHead))) {
          throw err("invalid-input", `No isolated changes to merge into ${isolation.targetBranch}.`);
        }
        isolationLog("merge-requested", {
          sessionId,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
        });
        let snap: Awaited<ReturnType<typeof managed.snapshot>>;
        let sourceRevision: string;
        try {
          snap = await managed.snapshot(
            isolation.worktreePath,
            `${SNAPSHOT_MESSAGE} (${sessionId.slice(0, 8)})`,
          );
          sourceRevision = await git.fingerprint(isolation.worktreePath);
        } catch (error) {
          throw unpublished(error);
        }
        isolationLog("snapshot-created", { sessionId, sha: snap.sha, created: snap.created });
        const lockKey = `${resolve(await git.commonDir(isolation.targetPath))}::${targetRefName(isolation.targetBranch)}`;
        const published = await withBranchLock(lockKey, async (): Promise<
          | { kind: "published"; sha: string }
          | { kind: "pending"; result: IsolationMergeResultDto }
        > => {
          ({ session, isolation } = await load(sessionId));
          assertNotBusy(session);
          assertOp(isolation.state, "merge");
          if (isolation.targetRepair && !isolation.targetRepair.applied) {
            throw err("conflict", `${isolation.targetBranch} has local changes that need AI reconciliation before integration`);
          }
          await assertOwnedSource(sessionId, isolation);
          await destinationFor(session, isolation);
          await assertNoPendingDelegations(session, isolation);
          await assertNestedTargetOpen(session, isolation);
          try {
            let attempt = 0;
            while (attempt < MAX_PUBLISH_RETRIES) {
              attempt += 1;
              if (attempt > 1) isolationLog("retry", { sessionId, attempt });
              const result = await integrateOnce(session, isolation, snap.sha, sourceRevision, allowTargetRepair);
              if (result.kind === "retry") continue;
              if (result.kind === "empty") {
                await persist(sessionId, transitionIsolation(isolation, { phase: "active" }));
                throw err("invalid-input", `No isolated changes to merge into ${isolation.targetBranch}.`);
              }
              if (result.kind === "conflict") {
                await persist(sessionId, transitionIsolation(isolation, {
                  phase: "conflict",
                  conflict: { message: result.message, files: result.files },
                  ...(isolation.targetRepair ? { targetRepair: isolation.targetRepair } : {}),
                }));
                await notice(sessionId, "isolation/conflict", {
                  targetBranch: isolation.targetBranch,
                  files: result.files,
                });
                throw Object.assign(err("conflict", result.message), { files: result.files });
              }
              return { kind: "published", sha: result.sha };
            }
            if (isolation.targetRepair) {
              await persist(sessionId, transitionIsolation(isolation, {
                phase: "conflict",
                conflict: {
                  message: `${isolation.targetBranch} changed during AI repair; review it and try again.`,
                  files: isolation.targetRepair.files,
                },
                targetRepair: isolation.targetRepair,
              }));
            } else {
              await persist(sessionId, transitionIsolation(isolation, { phase: "merge-ready" }));
            }
            throw err("conflict", `${isolation.targetBranch} changed during integration; try again.`);
          } catch (error) {
            const fresh = await deps.sessions.snapshot(sessionId).catch(() => null);
            const current = fresh ?? session;
            const iso = isolationOf(current);
            // Without a fresh record a publish intent may have been persisted
            // after `session` was loaded, so only a fresh read can prove it.
            let untouched = fresh !== null && !iso?.publish;
            if (iso?.publish) {
              const reality = await publicationState(current.id, iso, iso.publish);
              if (reality === "published" || reality === "unknown") {
                return { kind: "pending", result: publishedResult(iso, current) };
              }
              untouched = true;
              const repair = iso.targetRepair
                ?? (error && typeof error === "object" && "targetRepair" in error
                  ? (error as { targetRepair?: IsolationTargetRepair }).targetRepair
                  : undefined);
              if (repair) {
                await persist(sessionId, transitionIsolation(iso, {
                  phase: "conflict",
                  conflict: {
                    message: `${isolation.targetBranch} has local changes that need AI reconciliation before integration.`,
                    files: repair.files,
                  },
                  targetRepair: repair,
                }));
                await anchorTargetRepair(sessionId, iso, repair);
              } else {
                await persist(sessionId, transitionIsolation(iso, { phase: "merge-ready" }));
              }
            }
            if ((iso?.state === "rebind-pending" || iso?.state === "cleanup-pending") && iso.resultCommit) {
              return { kind: "pending", result: publishedResult(iso, current) };
            }
            throw untouched ? unpublished(error) : error;
          }
        });
        if (published.kind === "pending") return published.result;
        let cleaned: SessionProjection;
        try {
          cleaned = await continueAfterPublish(session, isolation, published.sha, snap.sha);
        } catch (error) {
          isolationLog("finalization-failed", {
            sessionId,
            commit: published.sha,
            message: error instanceof Error ? error.message : String(error),
          });
          const current = await deps.sessions.snapshot(sessionId);
          // The target branch already holds the work; only the session's
          // return is unfinished, so the requested push still runs.
          return withPush(publishedResult(isolationOf(current) ?? isolation, current), session, isolation);
        }
        isolationLog("published", {
          sessionId,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
          commit: published.sha,
          finalized: !isolationOf(cleaned),
        });
        return withPush({
          ok: true as const,
          commit: published.sha,
          targetBranch: isolation.targetBranch,
          session: cleaned,
          finalized: !isolationOf(cleaned),
        }, session, isolation);
      }));
    },

    /** Choose the branch this session's work will be integrated into, without
     *  integrating: one of the status's `targets` (a checked-out ordinary
     *  branch). Allowed only while the work rests (`active`, `merge-ready`,
     *  `conflict`: states that by contract carry no publication intent or
     *  result commit), recorded as an `isolation/retargeted` event. Choosing
     *  the current target is a no-op. */
    async retarget(
      sessionId: string,
      target: { branch: string; path: string },
    ): Promise<SessionProjection> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        assertOp(isolation.state, "merge");
        if (!existsSync(isolation.worktreePath)) {
          throw err("not-found", "the isolated workspace is no longer available");
        }
        await assertOwnedSource(sessionId, isolation);
        return (await retargetAtRest(session, isolation, target)).session;
      });
    },

    /** Commit any uncommitted work in the isolated workspace and publish its
     *  branch to a remote branch. Unlike merge-back this is non-destructive:
     *  the isolation, its workspace and its lifecycle stay intact. */
    async push(
      sessionId: string,
      input: { remote?: string; branch?: string; message?: string; requester?: GitActor } = {},
    ): Promise<IsolationPushResultDto> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        if (isolationNeedsRecovery(isolation.state)) {
          throw err("conflict", "isolation recovery must finish before pushing");
        }
        if (isolation.state === "missing" || isolation.state === "unowned" || isolation.state === "corrupt") {
          throw err("conflict", "the isolated workspace is not available to push");
        }
        if (!existsSync(isolation.worktreePath)) {
          throw err("not-found", "the isolated workspace is no longer available");
        }
        await assertOwnedSource(sessionId, isolation);
        const remote = input.remote?.trim() || "origin";
        const branch = input.branch?.trim() || isolation.worktreeBranch;
        if (localBranchName(branch) === localBranchName(isolation.targetBranch)) {
          throw err("invalid-input", `pushing the isolated branch over ${isolation.targetBranch} is not allowed`);
        }
        // Identity and credentials are resolved (or refused) before anything
        // is committed; the push itself runs with the acting person's account.
        return acting(session, input.requester, async () => {
        let commit: string;
        const status = await git.status(isolation.worktreePath);
        if (status.conflicted.length > 0) {
          throw err("invalid-input", "resolve the conflicted files before pushing");
        }
        if (status.clean) {
          commit = await git.revParse(isolation.worktreePath, "HEAD");
        } else {
          await git.stageAll(isolation.worktreePath);
          const message = input.message?.trim() || `Update isolated workspace (${sessionId.slice(0, 8)})`;
          commit = (await git.commitWithIdentity(isolation.worktreePath, message)).sha;
        }
        let targetHead = isolation.baseCommit;
        try { targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch); } catch { /* keep base */ }
        if (!(await git.hasUniqueChanges(isolation.worktreePath, targetHead))) {
          throw err("invalid-input", "there are no isolated changes to push");
        }
        await git.pushBranch(isolation.worktreePath, { remote, branch });
        isolationLog("pushed", {
          sessionId,
          projectId: session.projectId,
          remote,
          branch,
          commit,
        });
        return { ok: true as const, branch, remote, commit };
        }, { root: isolation.worktreePath, remote });
      });
    },

    async resolveWithAgent(sessionId: string, options: { requester?: GitActor } = {}): Promise<{ sessionId: string }> {
      return withSession(sessionId, async () => acting(await deps.sessions.snapshot(sessionId), options.requester, async () => {
        let { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        if (isolation.state !== "conflict" && !(isolation.targetRepair && !isolation.targetRepair.applied)) {
          assertOp(isolation.state, "resolve");
        }
        if (!existsSync(isolation.worktreePath)) {
          throw err("not-found", "the isolated workspace is no longer available");
        }
        await assertOwnedSource(sessionId, isolation);
        let targetHead = isolation.baseCommit;
        try { targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch); } catch { /* keep base */ }
        let files = isolation.conflict?.files ?? [];
        if (isolation.targetRepair) {
          const prepared = await applyTargetRepair(session, isolation);
          isolation = prepared.isolation;
          files = prepared.files;
        }
        const repair = isolation.targetRepair;
        const prompt = repair
          ? [
            `Reconcile the isolated session with local work already present in ${isolation.targetBranch}.`,
            "",
            "The original checkout was not modified. A private snapshot of its local work has been merged into this isolated workspace.",
            `- Merge target branch: ${isolation.targetBranch}`,
            `- Target HEAD: ${repair.targetHead}`,
            `- Backed-up local-work snapshot: ${repair.snapshotSha}`,
            `- Local paths: ${repair.files.slice(0, 50).join(", ") || "none recorded"}`,
            "",
            "Required steps:",
            "- Resolve every conflict in this isolated workspace by understanding the session change and the user's local change.",
            "- Preserve both intents unless the code makes them mutually exclusive; do not silently discard either side.",
            "- Run the repository's relevant checks when available; if validation fails, stop and report it instead of claiming success.",
            "- Do not reset, clean, stash, checkout, or otherwise modify the user's original checkout.",
            "- Do not push or force-update any branch.",
            "- Commit or checkpoint the resolved isolated tree, then stop and wait for Merge back.",
            "",
            buildLocalConflictResolutionPrompt(
              {
                branch: isolation.targetBranch,
                ahead: 0,
                behind: 0,
                conflictedPaths: files,
                diverged: true,
              },
              "Resolve the target-local overlap in this isolated workspace only.",
            ),
          ].join("\n")
          : [
            `Integrate the latest ${isolation.targetBranch} into this isolated workspace and resolve the conflicts.`,
            "",
            "Isolation origin (immutable):",
            `- Merge target branch: ${isolation.targetBranch}`,
            `- Origin workspace: ${isolation.originPath ?? isolation.targetPath}`,
            "- Do not modify the user's original checkout.",
            `- Target HEAD now: ${targetHead}`,
            `- Origin base commit: ${isolation.baseCommit}`,
            files.length
              ? `- Paths that conflicted on the last merge attempt (${files.length}):\n${files.slice(0, 50).map((path) => `  - ${path}`).join("\n")}`
              : `- No stored conflict paths; merge ${isolation.targetBranch} into this workspace.`,
            "",
            "Required steps:",
            `- Merge or rebase ${isolation.targetBranch} INTO this workspace.`,
            "- Resolve every conflict by understanding both sides; explain each non-obvious decision.",
            "- Do not push, force-update, or checkout the user's original workspace.",
            "- When this workspace contains this session's work plus the latest target branch, stop and wait — the user will retry Merge back.",
            "",
            buildLocalConflictResolutionPrompt(
              {
                branch: isolation.targetBranch,
                ahead: 0,
                behind: 0,
                conflictedPaths: files,
                diverged: true,
              },
              "Resolve the isolation merge conflicts in this workspace only.",
            ),
          ].join("\n");
        await notice(sessionId, "isolation/resolve-requested", {
          targetBranch: isolation.targetBranch,
          targetHead,
          conflictCount: files.length,
          ...(repair ? { targetRepair: true, backupSha: repair.snapshotSha, backupRef: repairRef(sessionId) } : {}),
        });
        await deps.sessions.send(sessionId, { text: prompt, githubConflictResolution: true });
        return { sessionId };
      }));
    },

    async discard(sessionId: string): Promise<SessionProjection> {
      return withSession(sessionId, () => discardLocked(sessionId));
    },

    /** Leave an isolation that holds nothing to integrate: the session goes
     *  back to its original workspace and the managed checkout is removed.
     *  Unlike `discard`, it refuses — under the session lock, against the live
     *  checkout — when any commit or uncommitted change exists, so a
     *  stale client view can never throw work away. */
    async returnUnchanged(sessionId: string): Promise<SessionProjection> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        assertOp(isolation.state, "discard");
        if (!existsSync(isolation.worktreePath)) {
          throw unpublished(err("not-found", "the isolated workspace is no longer available"));
        }
        await assertOwnedSource(sessionId, isolation);
        let targetHead = isolation.baseCommit;
        try { targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch); } catch { /* keep base */ }
        if (await git.hasUniqueChanges(isolation.worktreePath, targetHead)) {
          throw unpublished(err("conflict", "the isolated workspace has changes; integrate or delete them instead"));
        }
        isolationLog("return-unchanged", { sessionId, projectId: session.projectId });
        return discardLocked(sessionId, { returned: true });
      });
    },

    async abandonCleanup(sessionId: string): Promise<SessionProjection> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        if (isolation.state !== "cleanup-pending") {
          throw err("conflict", "isolation cleanup is not pending");
        }
        const project = await projectOf(session.projectId);
        const destination = await destinationFor(session, isolation);
        const cwd = session.worktreePath ?? project.path;
        if (!samePath(cwd, destination.path)) {
          throw err("conflict", "session has not completed its destination rebind");
        }
        const source = await inspectSource(session.id, isolation).catch(() => ({ status: "missing" as const }));
        const hasDependents = (await sourceDependents(session.id, isolation)).length > 0;
        if (hasDependents) {
          throw err("conflict", "another session still depends on the isolated workspace; move or delete it before finishing cleanup");
        }
        const preserveSource = await sourceRequiresPreservation(isolation, source);
        if (!preserveSource) {
          throw err("conflict", "isolated workspace ownership is healthy; retry cleanup instead");
        }
        const relinquished = source.status === "owned"
          ? await managed.relinquishOwned(project.path, ownedRef(session.id, isolation))
          : undefined;
        isolationLog("cleanup-abandoned", {
          sessionId,
          worktreePath: isolation.worktreePath,
          reason: source.status === "owned"
            ? "source-changed-after-snapshot"
            : source.status === "missing" ? "missing" : source.reason,
          retained: true,
          ...(relinquished ? { preservedBranch: relinquished.branch } : {}),
        });
        await notice(sessionId, "isolation/cleanup-abandoned", {
          worktreePath: isolation.worktreePath,
          targetBranch: isolation.targetBranch,
          ...(relinquished ? { preservedBranch: relinquished.branch } : {}),
        });
        const released = await persist(sessionId, null);
        await releaseIsolationRefs(sessionId, isolation);
        return released;
      });
    },

    async recover(sessionId: string): Promise<SessionProjection> {
      // A vanished checkout is the one recovery an epoch-pending or archived
      // session can take: nothing runs, and the record names nothing left.
      if (await withSession(sessionId, () => releaseVanished(sessionId))) {
        return deps.sessions.snapshot(sessionId);
      }
      const session = await deps.sessions.snapshot(sessionId);
      assertNotBusy(session);
      return service.recoverSession(session);
    },

    async recoverSession(session: SessionProjection): Promise<SessionProjection> {
      return withSession(session.id, async () => {
        const current = await deps.sessions.snapshot(session.id).catch(() => session);
        return recoverSessionLocked(current);
      });
    },

    async recoverAll(): Promise<void> {
      const sessions = await deps.sessions.list();
      const repos = new Set<string>();
      for (const session of sessions) {
        const isolation = isolationOf(session);
        if (isolation) repos.add(isolation.targetPath);
        const rows = isolationWorkspaceRows(session);
        for (const row of rows) repos.add(row.isolation.targetPath);
        if (!isolation && rows.length === 0) continue;
        try {
          if (session.status === "archived") {
            // Archived sessions are read-only: recovery cannot run for them.
            // Only a record whose checkout is gone and whose branch is gone
            // or merged is released, so nothing it points at can be lost.
            await withSession(session.id, () => releaseVanished(session.id));
            continue;
          }
          if (session.status === "epoch-pending"
            && await withSession(session.id, () => releaseVanished(session.id))) continue;
          const current = await deps.sessions.snapshot(session.id);
          if (rows.length > 1 || !isolationOf(current)) {
            // Scalar recovery deliberately declines multi-row sessions. Route
            // each durable row phase through its repository-scoped state
            // machine so one uncertain row cannot block or mutate siblings.
            for (const row of isolationWorkspaceRows(current)) {
              if (isolationNeedsRecovery(row.isolation.state)) {
                await service.recoverRepository(session.id, row.repositoryId);
              }
            }
          } else {
            await service.recoverSession(current);
          }
        } catch (error) {
          isolationLog("recovery-failed", {
            sessionId: session.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (deps.projects.list) {
        for (const project of await deps.projects.list()) {
          if (await git.isRepo(project.path)) repos.add(project.path);
        }
      }
      for (const root of repos) {
        await managed.recoverCreations(root).catch((error: unknown) => {
          isolationLog("creation-recovery-failed", {
            repository: root,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        const leftovers = await git.worktrees.list(root).catch(() => []);
        for (const wt of leftovers) {
          if (wt.isMain) continue;
          const marker = await readManagedMarker(git, wt.path);
          if (!marker || marker === "corrupt") continue;
          // Isolated checkouts leave only through their session's lifecycle
          // (merge, discard, delete, the vanished-record release above). An
          // unknown marker can belong to another Space or server.
          if (marker.kind !== "integration") continue;
          await withSession(marker.sessionId, async () => {
            const snap = await deps.sessions.snapshot(marker.sessionId).catch(() => undefined);
            // A marker from another server/Space is not our orphan to prune.
            if (!snap) return;
            const iso = isolationOf(snap);
            if (iso && (isolationNeedsRecovery(iso.state) || iso.state === "corrupt")) return;
            await managed.pruneIntegrationsForSession(root, marker.sessionId);
          }).catch((error: unknown) => {
            isolationLog("recovery-failed", {
              sessionId: marker.sessionId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        await sweepReleasedReceipts(root).catch((error: unknown) => {
          isolationLog("receipt-sweep-failed", {
            repository: root,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        await managed.pruneEmptyParents(root);
      }
    },

    isManagedBranch,
    managed,
  };
  return service;
}

export type IsolationService = ReturnType<typeof createIsolationService>;

export function mergeNoticeText(targetBranch: string, commit: string): string {
  return `Merged into ${targetBranch} · ${shortSha(commit)}`;
}
