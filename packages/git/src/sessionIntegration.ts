// Session isolation lifecycle. Git details stay in managedWorktrees; this
// module owns session-level state, publication durability, and recovery.
//
// Invariants (enforced, not documentary):
// - one immutable origin: repo + local targetBranch + originPath checkout + baseCommit
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
  IsolationMergeResultDto,
  IsolationPublishIntent,
  IsolationStatusDto,
  IsolationSuggestionDto,
  JsonObject,
  SessionEvent,
  SessionIsolation,
  IsolationState,
  SessionProjection,
  SessionRef,
} from "@polyth/contracts";
import {
  isolationBlocksUserMutation,
  isolationNeedsRecovery,
  normalizeIsolation as normalizeIsolationContract,
  transitionIsolation as transitionIsolationContract,
} from "@polyth/contracts";
import { buildLocalConflictResolutionPrompt, type GitService } from "./index.ts";
import {
  createManagedWorktrees,
  isolateBranchName,
  isManagedBranch,
  readManagedMarker,
  type ManagedWorktreeService,
} from "./managedWorktrees.ts";

const MAX_PUBLISH_RETRIES = 8;
const SNAPSHOT_MESSAGE = "polyth: snapshot isolated workspace";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  send(sessionId: string, input: { text: string; githubConflictResolution?: boolean }): Promise<unknown>;
  patchIsolation?(sessionId: string, isolation: SessionIsolation | null): Promise<SessionProjection>;
  rebindWorkspace?(sessionId: string, input: {
    worktreePath?: string | null;
    branch?: string | null;
    isolation?: SessionIsolation | null;
  }): Promise<SessionProjection>;
}

export interface IsolationProjectApi {
  get(id: string): Promise<{ id: string; path: string } | undefined>;
  list?: () => Promise<Array<{ id: string; path: string }>>;
}

export interface IsolationTestHooks {
  beforePublish?: () => Promise<void>;
  afterPublish?: () => Promise<void>;
  afterIntegrationCreated?: (sessionId: string) => Promise<void>;
  beforeCleanup?: () => Promise<void>;
}

export interface IsolationIntegrationDeps {
  git: GitService;
  managed?: ManagedWorktreeService;
  sessions: IsolationSessionApi;
  projects: IsolationProjectApi;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  readEvents?: (sessionId: string) => Promise<SessionEvent[]>;
  closeWorkspaceProcesses?: (cwd: string) => Promise<void>;
  testHooks?: IsolationTestHooks;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

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

const isolationOf = (session: SessionProjection): SessionIsolation | null => {
  const value = session.isolation;
  if (!value || typeof value !== "object" || value.kind !== "git-worktree") return null;
  return normalizeIsolationContract(value);
};

const targetRefName = (branch: string): string =>
  branch.startsWith("refs/") ? branch : `refs/heads/${branch.replace(/^refs\/heads\//, "")}`;

const localBranchName = (branch: string): string =>
  branch.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");

const samePath = (a: string, b: string): boolean => resolve(a) === resolve(b);

const shortSha = (sha: string): string => sha.slice(0, 7);

type IsolationTransition =
  | { phase: "active" | "merge-ready" | "missing" | "unowned" | "corrupt"; dismissedRevision?: string }
  | { phase: "conflict"; conflict: { message: string; files: string[] } }
  | { phase: "publishing"; publish: IsolationPublishIntent }
  | { phase: "rebind-pending" | "cleanup-pending"; resultCommit?: string; sourceSnapshotSha?: string };

/** Adapter for the package's phase vocabulary. The contracts helper is the
 * only constructor for newly persisted lifecycle states. */
const transitionIsolation = (
  isolation: SessionIsolation,
  transition: IsolationTransition,
): SessionIsolation => {
  if (transition.phase === "conflict") {
    return transitionIsolationContract(isolation, { state: "conflict", conflict: transition.conflict });
  }
  if (transition.phase === "publishing") {
    return transitionIsolationContract(isolation, { state: "publishing", publish: transition.publish });
  }
  if (transition.phase === "rebind-pending" || transition.phase === "cleanup-pending") {
    return transitionIsolationContract(isolation, {
      state: transition.phase,
      ...(transition.resultCommit ? { resultCommit: transition.resultCommit } : {}),
      ...(transition.sourceSnapshotSha ? { sourceSnapshotSha: transition.sourceSnapshotSha } : {}),
    });
  }
  return transitionIsolationContract(isolation, {
    state: transition.phase,
    ...("dismissedRevision" in transition && transition.dismissedRevision
      ? { dismissedRevision: transition.dismissedRevision }
      : {}),
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

  const persist = async (sessionId: string, isolation: SessionIsolation | null): Promise<SessionProjection> => {
    if (!deps.sessions.patchIsolation) throw err("unsupported", "session isolation persistence is unavailable");
    return deps.sessions.patchIsolation(sessionId, isolation);
  };

  const projectOf = async (projectId: string) => {
    const project = await deps.projects.get(projectId);
    if (!project) throw err("not-found", "unknown project");
    return project;
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
    return { session, isolation };
  };

  const resolveOriginCheckout = async (
    project: { id: string; path: string },
    input: CreateIsolatedSessionInput,
  ): Promise<{ branch: string; originPath: string; head: string; startPoint: string; sourceSessionId?: string }> => {
    let source: SessionProjection | undefined;
    if (input.sourceSessionId) {
      source = await deps.sessions.snapshot(input.sourceSessionId).catch(() => undefined);
      if (!source) throw err("not-found", "source session was not found");
      if (source.projectId !== project.id) {
        throw err("invalid-input", "source session does not belong to this project");
      }
      if (isolationOf(source)) {
        throw err("invalid-input", "nested session isolation is not supported");
      }
    }
    const list = await git.worktrees.list(project.path);
    const requested = input.targetBranch?.trim();
    if (requested?.startsWith("origin/") || requested?.startsWith("refs/remotes/")) {
      throw err(
        "invalid-input",
        "Work in isolation needs a local checkout of that branch. Check it out first.",
      );
    }
    const wanted = requested ? localBranchName(requested) : undefined;
    if (wanted && isManagedBranch(wanted)) {
      throw err("invalid-input", "managed isolation branches cannot be used as an origin");
    }
    const sourceCwd = source?.worktreePath ?? (wanted ? undefined : project.path);
    const fromPath = sourceCwd
      ? list.find((item) => samePath(item.path, sourceCwd))
      : undefined;
    const fromBranch = wanted
      ? list.find((item) => item.branch === wanted)
      : fromPath;
    const checkout = fromBranch ?? fromPath ?? list.find((item) => item.isMain) ?? list[0];
    if (!checkout?.branch) {
      throw err("invalid-input", "Work in isolation needs a checkout of a local branch.");
    }
    if (isManagedBranch(checkout.branch)) {
      throw err("invalid-input", "managed isolation branches cannot be used as an origin");
    }
    if (wanted && checkout.branch !== wanted) {
      throw err(
        "invalid-input",
        `Work in isolation needs a checkout of ${wanted}.`,
      );
    }
    const originPath = resolve(checkout.path);
    const head = await git.revParse(originPath, "HEAD");
    const sourceCwdResolved = source ? resolve(source.worktreePath ?? project.path) : undefined;
    return {
      branch: checkout.branch,
      originPath,
      head,
      startPoint: checkout.branch,
      ...(source && sourceCwdResolved && samePath(sourceCwdResolved, originPath)
        ? { sourceSessionId: source.id }
        : {}),
    };
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
  ): Promise<{ path: string; isProjectRoot: boolean }> => {
    const project = await projectOf(session.projectId);
    const projectRoot = resolve(project.path);
    const list = await git.worktrees.list(isolation.targetPath);
    const branch = localBranchName(isolation.targetBranch);
    if (isolation.originPath) {
      const origin = list.find((item) => samePath(item.path, isolation.originPath!));
      if (origin?.branch === branch
        && await checkoutMatchesTarget(origin.path, branch, isolation)) {
        return { path: resolve(origin.path), isProjectRoot: samePath(origin.path, projectRoot) };
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
    return { path: resolve(checkout.path), isProjectRoot: samePath(checkout.path, projectRoot) };
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
    if (isolationBlocksUserMutation(session.status)) {
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
    const revision = await git.fingerprint(isolation.worktreePath);
    let targetHead = isolation.baseCommit;
    try { targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch); } catch { /* keep base */ }
    const hasChanges = await git.hasUniqueChanges(isolation.worktreePath, targetHead);
    const target = await inspectTarget(isolation).catch(() => ({
      dirty: true,
      liveHead: targetHead,
      checkout: null,
      path: isolation.targetPath,
    }));
    if (!hasChanges) {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: target.dirty, revision, reason: "no-changes" };
    }
    if (isolation.dismissedRevision && isolation.dismissedRevision === revision) {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: target.dirty, revision, reason: "dismissed" };
    }
    if (isolation.state === "conflict") {
      const stopped = events ? lastCompletedTurn(events) : undefined;
      const reason = stopped?.data && typeof stopped.data === "object"
        ? (stopped.data as { reason?: unknown }).reason
        : undefined;
      if (events && stopped?.type === "turn/stopped" && reason === "completed") {
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

  const sourceDependents = async (
    sessionId: string,
    isolation: SessionIsolation,
  ): Promise<SessionProjection[]> => {
    const dependents: SessionProjection[] = [];
    for (const candidate of await deps.sessions.list()) {
      if (candidate.id === sessionId) continue;
      const project = candidate.worktreePath
        ? undefined
        : await deps.projects.get(candidate.projectId);
      const cwd = candidate.worktreePath ?? project?.path;
      if ((cwd && samePath(cwd, isolation.worktreePath))
        || (candidate.runtimeBinding?.location.directory
          && samePath(candidate.runtimeBinding.location.directory, isolation.worktreePath))) {
        dependents.push(candidate);
      }
    }
    return dependents;
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
    const ownership = await inspectSource(session.id, isolation).catch(() => ({ status: "missing" as const }));
    if (ownership.status !== "owned") {
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
      if (!isolation.resultCommit) return persist(session.id, null);
      return session;
    }
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
    if (isolation.sourceSnapshotSha
      && !(await git.workingTreeMatches(isolation.worktreePath, isolation.sourceSnapshotSha))) {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        reason: "source-changed-after-snapshot",
        worktreePath: isolation.worktreePath,
        retained: true,
      });
      return session;
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
    return persist(session.id, null);
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
      branch: isolation.targetBranch,
    });
    return deps.sessions.rebindWorkspace(session.id, {
      worktreePath: dest.isProjectRoot ? null : dest.path,
      branch: isolation.targetBranch,
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
    });
    return finishCleanup(session.id);
  };

  const publicationBindingError = (
    session: SessionProjection,
    isolation: SessionIsolation,
  ): string | null => {
    const intent = isolation.publish;
    if (!intent?.receiptRef) return null;
    if (intent.receiptRef !== `refs/polyth/isolation/${session.id}`) {
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
      if (intent.receiptRef !== `refs/polyth/isolation/${sessionId}`) return "unknown" as const;
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
        await git.syncPublishedCheckout(isolation.publish.checkoutPath, {
          branch: isolation.targetBranch,
          expectedHead: isolation.publish.expectedTargetSha,
          resultCommit: isolation.publish.resultCommit,
        });
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
    if (deps.readEvents && (isolation.state === "active" || isolation.state === "conflict")) {
      const suggestion = await suggestionFor(session, await deps.readEvents(session.id));
      if (suggestion?.eligible) {
        return persist(session.id, transitionIsolation(isolation, { phase: "merge-ready" }));
      }
    }
    return session;
  };

  const publish = async (
    isolation: SessionIsolation,
    intent: IsolationPublishIntent,
  ): Promise<"published" | "target-moved"> => {
    const target = await inspectTarget(isolation);
    if (target.liveHead !== intent.expectedTargetSha) return "target-moved";
    if (!intent.receiptRef) throw err("corrupt-isolation", "publication receipt is missing");
    try {
      // A real Git dry-run replaces the blanket dirty-tree block. Compatible
      // staged, unstaged, and untracked work is carried forward; overlapping
      // work remains untouched because this happens before the ref CAS.
      await git.syncPublishedCheckout(target.path, {
        branch: isolation.targetBranch,
        expectedHead: intent.expectedTargetSha,
        resultCommit: intent.resultCommit,
        checkOnly: true,
      });
    } catch (error) {
      const after = await inspectTarget(isolation).catch(() => null);
      if (after && after.liveHead !== intent.expectedTargetSha) return "target-moved";
      if (!after) throw error;
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
      mode: "atomic-ref-with-receipt",
    });
    return "published";
  };

  const integrateOnce = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    isolatedHead: string,
    sourceRevision: string,
  ): Promise<
    | { kind: "merged"; sha: string; expectedHead: string }
    | { kind: "conflict"; files: string[]; message: string }
    | { kind: "empty" }
    | { kind: "retry" }
  > => {
    const target = await inspectTarget(isolation);
    const targetHead = target.liveHead;
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
      const message = session.title?.trim() && session.title !== "New session"
        ? session.title.trim()
        : `Merge isolated session into ${isolation.targetBranch}`;
      const identity = await git.identity(isolation.targetPath);
      const committed = await git.commitStagedTree(integrationPath, message, identity);
      const intent: IsolationPublishIntent = {
        expectedTargetSha: targetHead,
        resultCommit: committed.sha,
        snapshotSha: isolatedHead,
        targetRef: targetRefName(isolation.targetBranch),
        receiptRef: `refs/polyth/isolation/${session.id}`,
        checkoutPath: (await destinationFor(session, isolation)).path,
        sourceRevision,
      };
      await persist(session.id, transitionIsolation(isolation, { phase: "publishing", publish: intent }));
      if (deps.testHooks?.beforePublish) await deps.testHooks.beforePublish();
      if (!(await git.workingTreeMatches(isolation.worktreePath, isolatedHead))) {
        await persist(session.id, transitionIsolation(isolation, { phase: "merge-ready" }));
        throw err("conflict", "isolated workspace changed after its merge snapshot; review and merge again");
      }
      const outcome = await publish(isolation, intent);
      if (deps.testHooks?.afterPublish) await deps.testHooks.afterPublish();
      if (outcome === "target-moved") {
        isolationLog("target-changed", {
          sessionId: session.id,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
          expected: targetHead,
        });
        return { kind: "retry" };
      }
      await git.syncPublishedCheckout(intent.checkoutPath!, {
        branch: isolation.targetBranch,
        expectedHead: intent.expectedTargetSha,
        resultCommit: intent.resultCommit,
      });
      return { kind: "merged", sha: committed.sha, expectedHead: targetHead };
    } finally {
      await managed.discardIntegration(isolation.targetPath, integrationPath, session.id);
    }
  };

  const service = {
    async createIsolatedSession(input: CreateIsolatedSessionInput): Promise<SessionRef> {
      const project = await projectOf(input.projectId);
      if (!(await git.isRepo(project.path))) {
        throw err("invalid-input", "project is not a git repository");
      }
      const origin = await resolveOriginCheckout(project, input);
      const sessionId = randomUUID();
      if (!UUID_RE.test(sessionId)) throw err("invalid-input", "session id is invalid");
      return withSession(sessionId, async () => {
        const worktree = await managed.create({
          root: project.path,
          sessionId,
          targetBranch: origin.branch,
          targetPath: project.path,
          base: origin.startPoint,
        });
        const isolation: SessionIsolation = {
          kind: "git-worktree",
          state: "active",
          createdAt: worktree.meta.createdAt,
          worktreePath: worktree.path,
          worktreeBranch: worktree.branch,
          targetPath: resolve(project.path),
          targetBranch: origin.branch,
          originPath: origin.originPath,
          baseCommit: origin.head,
          ...(origin.sourceSessionId ? { sourceSessionId: origin.sourceSessionId } : {}),
        };
        try {
          const created = await deps.sessions.create({
            id: sessionId,
            projectId: project.id,
            ...(input.harness ? { harness: input.harness } : {}),
            ...(input.title ? { title: input.title } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.agent ? { agent: input.agent } : {}),
            worktreePath: worktree.path,
            isolation,
          });
          if (created.id !== sessionId) {
            throw err("conflict", "session identity does not match the managed workspace");
          }
          isolationLog("created", {
            sessionId: created.id,
            projectId: project.id,
            targetBranch: origin.branch,
            originPath: origin.originPath,
            baseCommit: origin.head,
          });
          return created;
        } catch (error) {
          await managed.removeOwned(project.path, ownedRef(sessionId, isolation)).catch((cleanupError: unknown) => {
            isolationLog("cleanup-failed", {
              sessionId,
              stage: "create-rollback",
              message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
          });
          throw error;
        }
      });
    },

    /** Destructive half of canonical session deletion. The caller holds the
     * session mutation lock and supplies the runtime-owner release fence; this
     * package proves Git ownership before removing any filesystem resource. */
    async cleanupForSessionDelete(
      sessionId: string,
      releaseExecution: (cwd: string) => Promise<void>,
    ): Promise<void> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        const project = await projectOf(session.projectId);
        // An absent path is enough to prove that there is no filesystem
        // resource left to release. If the path still exists, Git inspection
        // must succeed and prove ownership; a transient Git error is never
        // downgraded to "missing".
        const source = await filesystemPathExists(isolation.worktreePath)
          ? await inspectSource(session.id, isolation)
          : { status: "missing" as const };
        if (source.status === "unowned") {
          throw err(
            "conflict",
            `refusing to delete an isolation workspace whose ownership is not proven (${source.reason})`,
          );
        }
        const dependents = await sourceDependents(session.id, isolation);
        if (dependents.length > 0) {
          throw err(
            "conflict",
            "another session still depends on the isolated workspace; delete or move it first",
          );
        }
        if (source.status === "owned") {
          await releaseExecution(isolation.worktreePath);
          await closeProcesses(isolation.worktreePath);
        }
        // Integration worktrees are also Polyth-owned resources for this
        // session. Remove them before the source so a later failure never
        // leaves a live canonical session pointing at an already-deleted cwd.
        await managed.pruneIntegrationsForSession(project.path, session.id);
        if (source.status === "owned") {
          const removed = await managed.removeOwned(
            project.path,
            ownedRef(session.id, isolation),
          );
          if (removed.status === "unowned") {
            throw err(
              "conflict",
              `isolation ownership changed during deletion (${removed.reason})`,
            );
          }
        }
        isolationLog("session-delete-cleanup", {
          sessionId: session.id,
          projectId: session.projectId,
          worktreePath: isolation.worktreePath,
          status: source.status === "missing" ? "already-gone" : "removed",
        });
      });
    },

    async getStatus(sessionId: string, events?: readonly SessionEvent[]): Promise<IsolationStatusDto> {
      const session = await deps.sessions.snapshot(sessionId);
      const isolation = isolationOf(session);
      if (!isolation) return { isolation: null, suggestion: null, effectiveState: null, actions: NO_ACTIONS };
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
      const durableEvents = events ?? await deps.readEvents?.(sessionId);
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
      let destinationReady = true;
      try { await destinationFor(session, isolation); } catch { destinationReady = false; }
      if (!destinationReady && suggestion?.eligible) {
        suggestion = { ...suggestion, eligible: false, reason: "destination-unavailable" };
      }
      const blocked = isolationBlocksUserMutation(session.status);
      const sourceReady = effectiveState !== "missing" && effectiveState !== "unowned" && effectiveState !== "corrupt";
      const hasChanges = suggestion?.hasChanges === true;
      const conflict = isolation.state === "conflict";
      return {
        isolation,
        suggestion,
        effectiveState,
        actions: {
          canReview: sourceReady,
          canMerge: !blocked && sourceReady && destinationReady && hasChanges && !conflict,
          canKeep: !blocked && sourceReady && USER_OPS.keep.has(isolation.state),
          canResolve: !blocked && sourceReady && isolation.state === "conflict",
          canDiscard: !blocked && destinationReady
            && (effectiveState === "missing" || (sourceReady && USER_OPS.discard.has(effectiveState))),
          canRecover: false,
          canAbandon: false,
        },
      };
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
        return persist(sessionId, transitionIsolation(isolation, {
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

    async mergeBack(sessionId: string): Promise<IsolationMergeResultDto> {
      return withSession(sessionId, async () => {
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
        await assertOwnedSource(sessionId, isolation);
        // Publication is only admitted when the canonical session has a
        // concrete, branch-correct return workspace. A later disappearance is
        // still recoverable through cleanup-pending without republishing.
        await destinationFor(session, isolation);
        const targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch);
        if (!(await git.hasUniqueChanges(isolation.worktreePath, targetHead))) {
          throw err("invalid-input", `No isolated changes to merge into ${isolation.targetBranch}.`);
        }
        isolationLog("merge-requested", {
          sessionId,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
        });
        const snap = await managed.snapshot(
          isolation.worktreePath,
          `${SNAPSHOT_MESSAGE} (${sessionId.slice(0, 8)})`,
        );
        const sourceRevision = await git.fingerprint(isolation.worktreePath);
        isolationLog("snapshot-created", { sessionId, sha: snap.sha, created: snap.created });
        const lockKey = `${resolve(await git.commonDir(isolation.targetPath))}::${targetRefName(isolation.targetBranch)}`;
        const published = await withBranchLock(lockKey, async (): Promise<
          | { kind: "published"; sha: string }
          | { kind: "pending"; result: IsolationMergeResultDto }
        > => {
          ({ session, isolation } = await load(sessionId));
          assertNotBusy(session);
          assertOp(isolation.state, "merge");
          await assertOwnedSource(sessionId, isolation);
          await destinationFor(session, isolation);
          try {
            let attempt = 0;
            while (attempt < MAX_PUBLISH_RETRIES) {
              attempt += 1;
              if (attempt > 1) isolationLog("retry", { sessionId, attempt });
              const result = await integrateOnce(session, isolation, snap.sha, sourceRevision);
              if (result.kind === "retry") continue;
              if (result.kind === "empty") {
                await persist(sessionId, transitionIsolation(isolation, { phase: "active" }));
                throw err("invalid-input", `No isolated changes to merge into ${isolation.targetBranch}.`);
              }
              if (result.kind === "conflict") {
                await persist(sessionId, transitionIsolation(isolation, {
                  phase: "conflict",
                  conflict: { message: result.message, files: result.files },
                }));
                await notice(sessionId, "isolation/conflict", {
                  targetBranch: isolation.targetBranch,
                  files: result.files,
                });
                throw Object.assign(err("conflict", result.message), { files: result.files });
              }
              return { kind: "published", sha: result.sha };
            }
            await persist(sessionId, transitionIsolation(isolation, { phase: "merge-ready" }));
            throw err("conflict", `${isolation.targetBranch} changed during integration; try again.`);
          } catch (error) {
            const current = await deps.sessions.snapshot(sessionId).catch(() => session);
            const iso = isolationOf(current);
            if (iso?.publish) {
              const reality = await publicationState(current.id, iso, iso.publish);
              if (reality === "published" || reality === "unknown") {
                return { kind: "pending", result: publishedResult(iso, current) };
              }
              await persist(sessionId, transitionIsolation(iso, { phase: "merge-ready" }));
            }
            if ((iso?.state === "rebind-pending" || iso?.state === "cleanup-pending") && iso.resultCommit) {
              return { kind: "pending", result: publishedResult(iso, current) };
            }
            throw error;
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
          return publishedResult(isolationOf(current) ?? isolation, current);
        }
        isolationLog("published", {
          sessionId,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
          commit: published.sha,
          finalized: !isolationOf(cleaned),
        });
        return {
          ok: true as const,
          commit: published.sha,
          targetBranch: isolation.targetBranch,
          session: cleaned,
          finalized: !isolationOf(cleaned),
        };
      });
    },

    async resolveWithAgent(sessionId: string): Promise<{ sessionId: string }> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        assertOp(isolation.state, "resolve");
        if (!existsSync(isolation.worktreePath)) {
          throw err("not-found", "the isolated workspace is no longer available");
        }
        await assertOwnedSource(sessionId, isolation);
        let targetHead = isolation.baseCommit;
        try { targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch); } catch { /* keep base */ }
        const files = isolation.conflict?.files ?? [];
        const prompt = [
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
        });
        await deps.sessions.send(sessionId, { text: prompt, githubConflictResolution: true });
        return { sessionId };
      });
    },

    async discard(sessionId: string): Promise<SessionProjection> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        if (isolation.state === "cleanup-pending" || isolation.state === "rebind-pending") return recoverCleanup(session, isolation);
        assertNotBusy(session);
        assertOp(isolation.state, "discard");
        isolationLog("discard", { sessionId, projectId: session.projectId });
        const pending = transitionIsolation(isolation, { phase: "rebind-pending" });
        await persist(sessionId, pending);
        try {
          const cleanup = transitionIsolation(pending, { phase: "cleanup-pending" });
          await rebindToTarget(session, isolation, cleanup);
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
        });
        return finishCleanup(sessionId);
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
        return persist(sessionId, null);
      });
    },

    async recover(sessionId: string): Promise<SessionProjection> {
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
        if (!isolation) continue;
        try {
          await service.recoverSession(await deps.sessions.snapshot(session.id));
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
          if (marker.kind !== "integration") {
            await withSession(marker.sessionId, async () => {
              const fresh = await deps.sessions.snapshot(marker.sessionId).catch(() => undefined);
              // An unknown marker can belong to another Space or server. No
              // durable local tombstone means ownership is not proven here.
              if (!fresh) return;
            });
            continue;
          }
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
