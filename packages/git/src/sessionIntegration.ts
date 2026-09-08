// Session isolation lifecycle. Git details stay in managedWorktrees; this
// module owns session-level state, publication durability, and recovery.
//
// Invariants (enforced, not documentary):
// - one immutable origin: repo + local targetBranch + originPath checkout + baseCommit
// - after merge/discard, session.branch, cwd, runtime cwd, and checked-out branch agree
// - a result commit is never published twice
// - destructive cleanup runs only when durable isolation is cleanup-pending && rebound
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
import { isolationBlocksUserMutation } from "@polyth/contracts";
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
  commitMessage?: (root: string) => Promise<string>;
  closeWorkspaceProcesses?: (cwd: string) => Promise<void>;
  testHooks?: IsolationTestHooks;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

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

const isolationOf = (session: SessionProjection): SessionIsolation | null =>
  session.isolation?.kind === "git-worktree" ? session.isolation : null;

const targetRefName = (branch: string): string =>
  branch.startsWith("refs/") ? branch : `refs/heads/${branch.replace(/^refs\/heads\//, "")}`;

const localBranchName = (branch: string): string =>
  branch.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");

const samePath = (a: string, b: string): boolean => resolve(a) === resolve(b);

const shortSha = (sha: string): string => sha.slice(0, 7);

const cloneIsolation = (isolation: SessionIsolation): SessionIsolation => ({
  ...isolation,
  ...(isolation.conflict ? { conflict: { ...isolation.conflict, files: [...isolation.conflict.files] } } : {}),
  ...(isolation.publish ? { publish: { ...isolation.publish } } : {}),
});

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

  const inspectTarget = async (isolation: SessionIsolation) => {
    const branch = localBranchName(isolation.targetBranch);
    const list = await git.worktrees.list(isolation.targetPath);
    const preferred = isolation.originPath
      ? list.find((item) => samePath(item.path, isolation.originPath!) && item.branch === branch)
      : undefined;
    const checkout = preferred ?? list.find((item) => item.branch === branch) ?? null;
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
      if (origin?.branch === branch) {
        return { path: resolve(origin.path), isProjectRoot: samePath(origin.path, projectRoot) };
      }
      throw err(
        "conflict",
        `origin workspace for ${isolation.targetBranch} is not checked out at ${isolation.originPath}`,
      );
    }
    const checkout = list.find((item) => item.branch === branch);
    if (!checkout) {
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
    if (isolation.state === "merging" || isolation.state === "cleanup-pending") {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: false, revision: "", reason: "merging" };
    }
    if (isolationBlocksUserMutation(session.status)) {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: false, revision: "", reason: "working" };
    }
    if (!existsSync(isolation.worktreePath)) {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: false, revision: "", reason: "missing" };
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
    if (target.dirty) {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: true, revision, reason: "dirty-target" };
    }
    if (isolation.state === "conflict") {
      const stopped = events ? lastCompletedTurn(events) : undefined;
      const reason = stopped?.data && typeof stopped.data === "object"
        ? (stopped.data as { reason?: unknown }).reason
        : undefined;
      if (events && stopped?.type === "turn/stopped" && reason === "completed") {
        return { eligible: true, hasChanges: true, targetBranch, targetDirty: false, revision };
      }
      return {
        eligible: false,
        hasChanges: true,
        targetBranch,
        targetDirty: false,
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
        return { eligible: false, hasChanges: true, targetBranch, targetDirty: false, revision, reason: "no-turn" };
      }
    } else if (isolation.state !== "merge-ready") {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: false, revision, reason: "no-turn" };
    }
    return { eligible: true, hasChanges: true, targetBranch, targetDirty: false, revision };
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
  });

  const finishCleanup = async (sessionId: string): Promise<SessionProjection> => {
    const session = await deps.sessions.snapshot(sessionId);
    const isolation = isolationOf(session);
    if (!isolation) return session;
    if (isolation.state !== "cleanup-pending" || isolation.rebound !== true) {
      isolationLog("cleanup-skipped", {
        sessionId,
        state: isolation.state,
        rebound: isolation.rebound === true,
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
    const result = await managed.removeOwned(project.path, ownedRef(session.id, isolation));
    if (result.status === "unowned") {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        reason: result.reason,
        worktreePath: isolation.worktreePath,
      });
      return persist(session.id, { ...cloneIsolation(isolation), state: "cleanup-pending", rebound: true });
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
  ): Promise<SessionProjection> => {
    const pending: SessionIsolation = {
      ...cloneIsolation(isolation),
      state: "cleanup-pending",
      resultCommit,
      rebound: false,
    };
    delete pending.publish;
    delete pending.conflict;
    let current = await persist(session.id, pending);
    try {
      current = await rebindToTarget(current, isolation, pending);
      current = await persist(session.id, { ...pending, rebound: true });
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

  const publicationState = async (isolation: SessionIsolation, intent: IsolationPublishIntent) => {
    let live: string;
    try {
      live = await git.revParse(isolation.targetPath, isolation.targetBranch);
    } catch {
      return "unknown" as const;
    }
    if (live === intent.resultCommit) return "published" as const;
    if (await git.isAncestor(isolation.targetPath, intent.resultCommit, live)) return "published" as const;
    if (live === intent.expectedTargetSha) return "unpublished" as const;
    return "target-moved" as const;
  };

  const recoverMerging = async (session: SessionProjection, isolation: SessionIsolation): Promise<SessionProjection> => {
    await managed.pruneIntegrationsForSession(isolation.targetPath, session.id).catch((error: unknown) => {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        stage: "integrations",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    if (!isolation.publish) {
      isolationLog("recovery", { sessionId: session.id, merging: "abandoned-before-publish" });
      const next = cloneIsolation(isolation);
      delete next.publish;
      next.state = "merge-ready";
      return persist(session.id, next);
    }
    const reality = await publicationState(isolation, isolation.publish);
    isolationLog("recovery", { sessionId: session.id, merging: reality, resultCommit: isolation.publish.resultCommit });
    if (reality === "published") {
      return continueAfterPublish(session, isolation, isolation.publish.resultCommit);
    }
    if (reality === "unknown") return session;
    const next = cloneIsolation(isolation);
    delete next.publish;
    next.state = "merge-ready";
    return persist(session.id, next);
  };

  const recoverCleanup = async (session: SessionProjection, isolation: SessionIsolation): Promise<SessionProjection> => {
    if (isolation.rebound === true) return finishCleanup(session.id);
    try {
      const rebound = await rebindToTarget(session, isolation, isolation);
      await persist(session.id, { ...cloneIsolation(isolation), rebound: true });
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
    const isolation = isolationOf(session);
    if (!isolation) return session;
    isolationLog("recovery", {
      sessionId: session.id,
      projectId: session.projectId,
      state: isolation.state,
    });
    if (isolation.state === "merging") return recoverMerging(session, isolation);
    if (isolation.state === "cleanup-pending") return recoverCleanup(session, isolation);
    if (!existsSync(isolation.worktreePath)) {
      return persist(session.id, { ...cloneIsolation(isolation), state: "missing" });
    }
    const owned = await managed.inspect(isolation.targetPath, isolation.worktreePath).catch(() => null);
    if (!owned) return persist(session.id, { ...cloneIsolation(isolation), state: "missing" });
    return session;
  };

  const publish = async (input: {
    isolation: SessionIsolation;
    expectedHead: string;
    newSha: string;
  }): Promise<"published" | "target-moved"> => {
    const target = await inspectTarget(input.isolation);
    if (target.dirty) {
      throw err(
        "conflict",
        `${input.isolation.targetBranch} has local changes. Commit or discard them before integrating this session.`,
      );
    }
    if (target.liveHead !== input.expectedHead) return "target-moved";
    if (target.checkout) {
      await git.mergeFfOnly(target.path, input.newSha);
      isolationLog("published", {
        targetBranch: input.isolation.targetBranch,
        commit: input.newSha,
        mode: "ff-only",
        checkout: target.path,
      });
      return "published";
    }
    const updated = await git.updateRef(
      input.isolation.targetPath,
      targetRefName(input.isolation.targetBranch),
      input.newSha,
      input.expectedHead,
    );
    if (!updated) return "target-moved";
    isolationLog("published", {
      targetBranch: input.isolation.targetBranch,
      commit: input.newSha,
      mode: "update-ref",
    });
    return "published";
  };

  const integrateOnce = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    isolatedHead: string,
  ): Promise<
    | { kind: "merged"; sha: string; expectedHead: string }
    | { kind: "conflict"; files: string[]; message: string }
    | { kind: "empty" }
    | { kind: "retry" }
  > => {
    const target = await inspectTarget(isolation);
    if (target.dirty) {
      throw err(
        "conflict",
        `${isolation.targetBranch} has local changes. Commit or discard them before integrating this session.`,
      );
    }
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
      let message = session.title?.trim() && session.title !== "New session"
        ? session.title.trim()
        : `Merge isolated session into ${isolation.targetBranch}`;
      if (deps.commitMessage) {
        try { message = await deps.commitMessage(integrationPath); } catch { /* keep fallback */ }
      }
      const identity = await git.identity(isolation.targetPath);
      const committed = await git.commitWithIdentity(integrationPath, message, identity);
      const intent: IsolationPublishIntent = {
        expectedTargetSha: targetHead,
        resultCommit: committed.sha,
        snapshotSha: isolatedHead,
        targetRef: targetRefName(isolation.targetBranch),
      };
      await persist(session.id, { ...cloneIsolation(isolation), state: "merging", publish: intent });
      if (deps.testHooks?.beforePublish) await deps.testHooks.beforePublish();
      const outcome = await publish({ isolation, expectedHead: targetHead, newSha: committed.sha });
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
      return { kind: "merged", sha: committed.sha, expectedHead: targetHead };
    } finally {
      await managed.discardIntegration(isolation.targetPath, integrationPath);
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
    },

    async getStatus(sessionId: string, events?: readonly SessionEvent[]): Promise<IsolationStatusDto> {
      const session = await deps.sessions.snapshot(sessionId);
      const isolation = isolationOf(session);
      if (!isolation) return { isolation: null, suggestion: null, effectiveState: null };
      if (isolation.state === "merging" || isolation.state === "cleanup-pending") {
        return { isolation, suggestion: null, effectiveState: isolation.state };
      }
      const suggestion = await suggestionFor(session, events);
      return { isolation, suggestion, effectiveState: derivedState(isolation, suggestion) };
    },

    async keepIsolated(sessionId: string): Promise<SessionProjection> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        assertOp(isolation.state, "keep");
        if (!existsSync(isolation.worktreePath)) {
          return persist(sessionId, { ...cloneIsolation(isolation), state: "missing" });
        }
        const revision = await git.fingerprint(isolation.worktreePath);
        isolationLog("keep-isolated", { sessionId, revision });
        return persist(sessionId, {
          ...cloneIsolation(isolation),
          state: isolation.state === "conflict" ? "conflict" : "active",
          dismissedRevision: revision,
        });
      });
    },

    async onTurnCompleted(sessionId: string, events: readonly SessionEvent[]): Promise<SessionProjection | null> {
      return withSession(sessionId, async () => {
        const session = await deps.sessions.snapshot(sessionId).catch(() => undefined);
        if (!session) return null;
        const isolation = isolationOf(session);
        if (!isolation || isolation.state === "cleanup-pending" || isolation.state === "merging") return session;
        if (isolation.state === "missing") return session;
        const suggestion = await suggestionFor(session, events);
        if (suggestion?.reason === "missing") {
          isolationLog("worktree-missing", { sessionId, projectId: session.projectId });
          return persist(sessionId, { ...cloneIsolation(isolation), state: "missing" });
        }
        if (suggestion?.eligible && isolation.state !== "merge-ready") {
          return persist(sessionId, { ...cloneIsolation(isolation), state: "merge-ready" });
        }
        if (!suggestion?.eligible && isolation.state === "merge-ready" && suggestion?.reason === "no-changes") {
          return persist(sessionId, { ...cloneIsolation(isolation), state: "active" });
        }
        return session;
      });
    },

    async mergeBack(sessionId: string): Promise<IsolationMergeResultDto> {
      return withSession(sessionId, async () => {
        const loaded = await load(sessionId);
        let { session, isolation } = loaded;
        if (isolation.state === "merging" || isolation.state === "cleanup-pending") {
          session = await recoverSessionLocked(session);
          const recovered = isolationOf(session);
          if (!recovered) {
            return publishedResult(isolation, session);
          }
          isolation = recovered;
        }
        if (isolation.state === "cleanup-pending" || isolation.state === "merging") {
          return publishedResult(isolation, session);
        }
        if (isolation.state === "missing" || !existsSync(isolation.worktreePath)) {
          if (isolation.state !== "missing") {
            await persist(sessionId, { ...cloneIsolation(isolation), state: "missing" });
          }
          throw err("not-found", "the isolated workspace is no longer available");
        }
        assertNotBusy(session);
        assertOp(isolation.state, "merge");
        const targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch);
        if (!(await git.hasUniqueChanges(isolation.worktreePath, targetHead))) {
          throw err("invalid-input", `No isolated changes to merge into ${isolation.targetBranch}.`);
        }
        const target = await inspectTarget(isolation);
        if (target.dirty) {
          throw err(
            "conflict",
            `${isolation.targetBranch} has local changes. Commit or discard them before integrating this session.`,
          );
        }
        isolationLog("merge-requested", {
          sessionId,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
        });
        const lockKey = `${resolve(isolation.targetPath)}::${localBranchName(isolation.targetBranch)}`;
        return withBranchLock(lockKey, async () => {
          ({ session, isolation } = await load(sessionId));
          assertNotBusy(session);
          assertOp(isolation.state, "merge");
          await persist(sessionId, { ...cloneIsolation(isolation), state: "merging" });
          try {
            const snap = await managed.snapshot(
              isolation.worktreePath,
              `${SNAPSHOT_MESSAGE} (${sessionId.slice(0, 8)})`,
            );
            isolationLog("snapshot-created", { sessionId, sha: snap.sha, created: snap.created });
            let attempt = 0;
            while (attempt < MAX_PUBLISH_RETRIES) {
              attempt += 1;
              if (attempt > 1) isolationLog("retry", { sessionId, attempt });
              const result = await integrateOnce(session, isolation, snap.sha);
              if (result.kind === "retry") continue;
              if (result.kind === "empty") {
                await persist(sessionId, { ...cloneIsolation(isolation), state: "active" });
                throw err("invalid-input", `No isolated changes to merge into ${isolation.targetBranch}.`);
              }
              if (result.kind === "conflict") {
                await persist(sessionId, {
                  ...cloneIsolation(isolation),
                  state: "conflict",
                  conflict: { message: result.message, files: result.files },
                });
                await notice(sessionId, "isolation/conflict", {
                  targetBranch: isolation.targetBranch,
                  files: result.files,
                });
                throw Object.assign(err("conflict", result.message), { files: result.files });
              }
              const cleaned = await continueAfterPublish(session, isolation, result.sha);
              isolationLog("published", {
                sessionId,
                projectId: session.projectId,
                targetBranch: isolation.targetBranch,
                commit: result.sha,
                finalized: !isolationOf(cleaned),
              });
              return {
                ok: true as const,
                commit: result.sha,
                targetBranch: isolation.targetBranch,
                session: cleaned,
                finalized: !isolationOf(cleaned),
              };
            }
            await persist(sessionId, { ...cloneIsolation(isolation), state: "merge-ready" });
            throw err("conflict", `${isolation.targetBranch} changed during integration; try again.`);
          } catch (error) {
            const current = await deps.sessions.snapshot(sessionId).catch(() => session);
            const iso = isolationOf(current);
            if (iso?.publish) {
              const reality = await publicationState(iso, iso.publish);
              if (reality === "published" || reality === "unknown") {
                return publishedResult(iso, current);
              }
            }
            if (iso?.state === "cleanup-pending" && iso.resultCommit) {
              return publishedResult(iso, current);
            }
            if (iso?.state === "merging" && !iso.publish) {
              try {
                await persist(sessionId, { ...cloneIsolation(iso), state: "merge-ready" });
              } catch (persistError) {
                isolationLog("recovery-failed", {
                  sessionId,
                  stage: "revert-merging",
                  message: persistError instanceof Error ? persistError.message : String(persistError),
                });
              }
            }
            throw error;
          }
        });
      });
    },

    async resolveWithAgent(sessionId: string): Promise<{ sessionId: string }> {
      return withSession(sessionId, async () => {
        const { session, isolation } = await load(sessionId);
        assertNotBusy(session);
        assertOp(isolation.state, "resolve");
        if (!existsSync(isolation.worktreePath)) {
          await persist(sessionId, { ...cloneIsolation(isolation), state: "missing" });
          throw err("not-found", "the isolated workspace is no longer available");
        }
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
        if (isolation.state === "cleanup-pending") return recoverCleanup(session, isolation);
        assertNotBusy(session);
        assertOp(isolation.state, "discard");
        isolationLog("discard", { sessionId, projectId: session.projectId });
        const pending: SessionIsolation = { ...cloneIsolation(isolation), state: "cleanup-pending", rebound: false };
        delete pending.publish;
        await persist(sessionId, pending);
        try {
          await rebindToTarget(session, isolation, pending);
          await persist(sessionId, { ...pending, rebound: true });
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
        const leftovers = await git.worktrees.list(root).catch(() => []);
        for (const wt of leftovers) {
          if (wt.isMain) continue;
          const marker = await readManagedMarker(git, wt.path);
          if (!marker || marker === "corrupt" || marker.kind !== "integration") continue;
          await withSession(marker.sessionId, async () => {
            const snap = await deps.sessions.snapshot(marker.sessionId).catch(() => undefined);
            const iso = snap ? isolationOf(snap) : null;
            if (iso?.state === "merging") return;
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
