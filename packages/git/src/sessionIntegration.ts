// Session isolation lifecycle: create, suggest merge, squash-integrate against
// the live target HEAD via a transient worktree, rebind the SAME session, and
// clean up Polyth-owned worktrees. Git details stay in managedWorktrees;
// this module owns session-level state and safety.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CreateIsolatedSessionInput,
  CreateSessionInput,
  IsolationMergeResultDto,
  IsolationStatusDto,
  IsolationSuggestionDto,
  JsonObject,
  SessionEvent,
  SessionIsolation,
  SessionProjection,
  SessionRef,
} from "@polyth/contracts";
import { buildLocalConflictResolutionPrompt, type GitService } from "./index.ts";
import {
  createManagedWorktrees,
  isManagedBranch,
  type ManagedWorktreeService,
} from "./managedWorktrees.ts";

const MAX_PUBLISH_RETRIES = 8;
const SNAPSHOT_MESSAGE = "polyth: snapshot isolated workspace";

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
}

export interface IsolationIntegrationDeps {
  git: GitService;
  managed?: ManagedWorktreeService;
  sessions: IsolationSessionApi;
  projects: IsolationProjectApi;
  append: (sessionId: string, type: string, data: JsonObject) => Promise<unknown>;
  commitMessage?: (root: string) => Promise<string>;
  closeWorkspaceProcesses?: (cwd: string) => Promise<void>;
}

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

const lastCompletedTurn = (events: readonly SessionEvent[]): SessionEvent | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === "turn/stopped") return event;
  }
  return undefined;
};

const isolationOf = (session: SessionProjection): SessionIsolation | null =>
  session.isolation?.kind === "git-worktree" ? session.isolation : null;

const persist = async (
  sessions: IsolationSessionApi,
  sessionId: string,
  isolation: SessionIsolation | null,
): Promise<SessionProjection> => {
  if (!sessions.patchIsolation) throw err("unsupported", "session isolation persistence is unavailable");
  return sessions.patchIsolation(sessionId, isolation);
};

const targetRef = (branch: string): string =>
  branch.startsWith("refs/") ? branch : `refs/heads/${branch.replace(/^refs\/heads\//, "")}`;

const shortSha = (sha: string): string => sha.slice(0, 7);

const branchLocks = new Map<string, Promise<void>>();

export async function withBranchLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = branchLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const next = previous.then(() => held);
  branchLocks.set(key, next.catch(() => undefined).then(() => undefined));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (branchLocks.get(key) === next) branchLocks.delete(key);
  }
}

export function createIsolationService(deps: IsolationIntegrationDeps) {
  const git = deps.git;
  const managed = deps.managed ?? createManagedWorktrees(git);

  const projectOf = async (projectId: string) => {
    const project = await deps.projects.get(projectId);
    if (!project) throw err("not-found", "unknown project");
    return project;
  };

  const resolveTarget = async (root: string, requested?: string): Promise<{ branch: string; head: string }> => {
    if (requested?.trim()) {
      const name = requested.trim();
      const head = await git.revParse(root, name);
      const branch = name.startsWith("origin/") || name.startsWith("refs/remotes/")
        ? name.replace(/^refs\/remotes\//, "").replace(/^[^/]+\//, "")
        : name.replace(/^refs\/heads\//, "");
      return { branch, head };
    }
    const branches = await git.branches(root);
    const current = branches.current;
    if (!current) throw err("invalid-input", "repository has no current branch to isolate from");
    return { branch: current, head: await git.revParse(root, "HEAD") };
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
    if (isolation.state === "merging") {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: false, revision: "", reason: "merging" };
    }
    if (isolation.state === "conflict") {
      return {
        eligible: false,
        hasChanges: true,
        targetBranch,
        targetDirty: false,
        revision: isolation.dismissedRevision ?? "",
        reason: "conflict",
      };
    }
    if (session.status === "working" || session.status === "waiting" || session.status === "reconciling") {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: false, revision: "", reason: "working" };
    }
    if (!existsSync(isolation.worktreePath)) {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty: false, revision: "", reason: "missing" };
    }
    const revision = await git.fingerprint(isolation.worktreePath);
    let targetHead: string;
    try {
      targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch);
    } catch {
      targetHead = isolation.baseCommit;
    }
    const hasChanges = await git.hasUniqueChanges(isolation.worktreePath, targetHead);
    const targetStatus = await git.status(isolation.targetPath).catch(() => null);
    const targetDirty = !!targetStatus
      && targetStatus.branch === isolation.targetBranch
      && !targetStatus.clean;
    if (!hasChanges) {
      return { eligible: false, hasChanges: false, targetBranch, targetDirty, revision, reason: "no-changes" };
    }
    if (isolation.dismissedRevision && isolation.dismissedRevision === revision) {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty, revision, reason: "dismissed" };
    }
    if (targetDirty) {
      return { eligible: false, hasChanges: true, targetBranch, targetDirty: true, revision, reason: "dirty-target" };
    }
    if (events) {
      const stopped = lastCompletedTurn(events);
      const reason = stopped?.data && typeof stopped.data === "object"
        ? (stopped.data as { reason?: unknown }).reason
        : undefined;
      if (stopped?.type !== "turn/stopped" || reason !== "completed") {
        return { eligible: false, hasChanges: true, targetBranch, targetDirty, revision, reason: "no-turn" };
      }
    } else if (isolation.state !== "merge-ready") {
      // GET status has no turn log: only surface a suggestion after
      // onTurnCompleted has already marked the session merge-ready.
      return { eligible: false, hasChanges: true, targetBranch, targetDirty, revision, reason: "no-turn" };
    }
    return { eligible: true, hasChanges: true, targetBranch, targetDirty: false, revision };
  };

  const loadSession = async (sessionId: string): Promise<{ session: SessionProjection; isolation: SessionIsolation }> => {
    const session = await deps.sessions.snapshot(sessionId);
    const isolation = isolationOf(session);
    if (!isolation) throw err("invalid-input", "session is not isolated");
    return { session, isolation };
  };

  const finishCleanup = async (session: SessionProjection, isolation: SessionIsolation): Promise<SessionProjection> => {
    isolationLog("cleanup", {
      sessionId: session.id,
      projectId: session.projectId,
      worktreePath: isolation.worktreePath,
    });
    if (deps.closeWorkspaceProcesses) {
      await deps.closeWorkspaceProcesses(isolation.worktreePath).catch(() => undefined);
    }
    const project = await projectOf(session.projectId);
    try {
      await managed.removeIfOwned(project.path, isolation.worktreePath);
    } catch (error) {
      isolationLog("cleanup-failed", {
        sessionId: session.id,
        message: error instanceof Error ? error.message : String(error),
      });
      const next: SessionIsolation = { ...isolation, state: "cleanup-pending" };
      return persist(deps.sessions, session.id, next);
    }
    isolationLog("cleanup", { sessionId: session.id, projectId: session.projectId, done: true });
    return persist(deps.sessions, session.id, null);
  };

  const publish = async (input: {
    targetPath: string;
    targetBranch: string;
    expectedHead: string;
    newSha: string;
  }): Promise<"published" | "target-moved"> => {
    const status = await git.status(input.targetPath);
    if (status.branch === input.targetBranch) {
      if (!status.clean) {
        throw err(
          "conflict",
          `${input.targetBranch} has local changes. Commit or discard them before integrating this session.`,
        );
      }
      const live = await git.revParse(input.targetPath, "HEAD");
      if (live !== input.expectedHead) return "target-moved";
      await git.mergeFfOnly(input.targetPath, input.newSha);
      isolationLog("published", { targetBranch: input.targetBranch, commit: input.newSha, mode: "ff-only" });
      return "published";
    }
    const updated = await git.updateRef(
      input.targetPath,
      targetRef(input.targetBranch),
      input.newSha,
      input.expectedHead,
    );
    if (!updated) return "target-moved";
    isolationLog("published", { targetBranch: input.targetBranch, commit: input.newSha, mode: "update-ref" });
    return "published";
  };

  const integrateOnce = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    isolatedHead: string,
  ): Promise<{ kind: "merged"; sha: string } | { kind: "conflict"; files: string[]; message: string } | { kind: "retry" }> => {
    const targetHead = await git.revParse(isolation.targetPath, isolation.targetBranch);
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
      const merged = await git.mergeSquash(integrationPath, isolatedHead);
      if (!merged.ok) {
        isolationLog("conflict", {
          sessionId: session.id,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
          files: merged.conflicted,
        });
        await git.abortMerge(integrationPath).catch(() => undefined);
        return {
          kind: "conflict",
          files: merged.conflicted,
          message: `${isolation.targetBranch} changed in conflicting areas.`,
        };
      }
      let message = session.title?.trim() && session.title !== "New session"
        ? session.title.trim()
        : `Merge isolated session into ${isolation.targetBranch}`;
      if (deps.commitMessage) {
        try { message = await deps.commitMessage(integrationPath); } catch { /* keep fallback */ }
      }
      const identity = await git.identity(isolation.targetPath);
      const committed = await git.commitWithIdentity(integrationPath, message, identity);
      const outcome = await publish({
        targetPath: isolation.targetPath,
        targetBranch: isolation.targetBranch,
        expectedHead: targetHead,
        newSha: committed.sha,
      });
      if (outcome === "target-moved") {
        isolationLog("target-changed", {
          sessionId: session.id,
          projectId: session.projectId,
          targetBranch: isolation.targetBranch,
          expected: targetHead,
        });
        return { kind: "retry" };
      }
      return { kind: "merged", sha: committed.sha };
    } finally {
      await managed.discardIntegration(isolation.targetPath, integrationPath);
    }
  };

  const rebindToTarget = async (
    session: SessionProjection,
    isolation: SessionIsolation,
    nextIsolation: SessionIsolation | null,
  ): Promise<SessionProjection> => {
    if (deps.closeWorkspaceProcesses) {
      await deps.closeWorkspaceProcesses(isolation.worktreePath).catch(() => undefined);
    }
    if (!deps.sessions.rebindWorkspace) {
      throw err("unsupported", "session workspace rebind is unavailable");
    }
    isolationLog("session-rebind", {
      sessionId: session.id,
      projectId: session.projectId,
      from: isolation.worktreePath,
      to: isolation.targetPath,
      branch: isolation.targetBranch,
    });
    return deps.sessions.rebindWorkspace(session.id, {
      worktreePath: null,
      branch: isolation.targetBranch,
      isolation: nextIsolation,
    });
  };

  const service = {
    async createIsolatedSession(input: CreateIsolatedSessionInput): Promise<SessionRef> {
      const project = await projectOf(input.projectId);
      if (!(await git.isRepo(project.path))) {
        throw err("invalid-input", "project is not a git repository");
      }
      const origin = await resolveTarget(project.path, input.targetBranch);
      const sessionId = randomUUID();
      const worktree = await managed.create({
        root: project.path,
        sessionId,
        targetBranch: origin.branch,
        targetPath: project.path,
        base: input.targetBranch || origin.branch,
      });
      const isolation: SessionIsolation = {
        kind: "git-worktree",
        state: "active",
        createdAt: worktree.meta.createdAt,
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
        targetPath: project.path,
        targetBranch: origin.branch,
        baseCommit: origin.head,
        ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId } : {}),
      };
      try {
        const created = await deps.sessions.create({
          projectId: project.id,
          ...(input.title ? { title: input.title } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.agent ? { agent: input.agent } : {}),
          worktreePath: worktree.path,
          isolation,
        });
        isolationLog("created", {
          sessionId: created.id,
          projectId: project.id,
          targetBranch: origin.branch,
          baseCommit: origin.head,
        });
        return created;
      } catch (error) {
        await managed.removeIfOwned(project.path, worktree.path).catch(() => undefined);
        throw error;
      }
    },

    async getStatus(sessionId: string, events?: readonly SessionEvent[]): Promise<IsolationStatusDto> {
      const session = await deps.sessions.snapshot(sessionId);
      const isolation = isolationOf(session);
      if (!isolation) return { isolation: null, suggestion: null };
      if (isolation.state === "cleanup-pending") {
        return { isolation, suggestion: null };
      }
      const suggestion = await suggestionFor(session, events);
      return { isolation, suggestion };
    },

    async keepIsolated(sessionId: string): Promise<SessionProjection> {
      const { session, isolation } = await loadSession(sessionId);
      if (!existsSync(isolation.worktreePath)) {
        return persist(deps.sessions, sessionId, { ...isolation, state: "missing" });
      }
      const revision = await git.fingerprint(isolation.worktreePath);
      isolationLog("keep-isolated", { sessionId, projectId: session.projectId, revision });
      return persist(deps.sessions, sessionId, {
        ...isolation,
        state: isolation.state === "conflict" ? "conflict" : "active",
        dismissedRevision: revision,
      });
    },

    async onTurnCompleted(sessionId: string, events: readonly SessionEvent[]): Promise<SessionProjection | null> {
      const session = await deps.sessions.snapshot(sessionId).catch(() => undefined);
      if (!session) return null;
      const isolation = isolationOf(session);
      if (!isolation || isolation.state === "cleanup-pending" || isolation.state === "merging") return null;
      if (isolation.state === "missing") return session;
      const suggestion = await suggestionFor(session, events);
      if (isolation.state === "conflict") return session;
      if (suggestion?.eligible && isolation.state !== "merge-ready") {
        return persist(deps.sessions, sessionId, { ...isolation, state: "merge-ready" });
      }
      if (!suggestion?.eligible && isolation.state === "merge-ready" && suggestion?.reason === "no-changes") {
        return persist(deps.sessions, sessionId, { ...isolation, state: "active" });
      }
      if (suggestion?.reason === "missing") {
        isolationLog("worktree-missing", { sessionId, projectId: session.projectId });
        return persist(deps.sessions, sessionId, { ...isolation, state: "missing" });
      }
      return session;
    },

    async mergeBack(sessionId: string): Promise<IsolationMergeResultDto> {
      const { session, isolation } = await loadSession(sessionId);
      if (session.status === "working") throw err("conflict", "session is still running");
      if (isolation.state === "missing") throw err("not-found", "the isolated workspace is no longer available");
      if (!existsSync(isolation.worktreePath)) {
        await persist(deps.sessions, sessionId, { ...isolation, state: "missing" });
        throw err("not-found", "the isolated workspace is no longer available");
      }
      isolationLog("merge-requested", {
        sessionId,
        projectId: session.projectId,
        targetBranch: isolation.targetBranch,
      });
      const lockKey = `${resolve(isolation.targetPath)}::${isolation.targetBranch}`;
      return withBranchLock(lockKey, async () => {
        await persist(deps.sessions, sessionId, { ...isolation, state: "merging" });
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
            if (result.kind === "conflict") {
              const next: SessionIsolation = {
                ...isolation,
                state: "conflict",
                conflict: { message: result.message, files: result.files },
              };
              await persist(deps.sessions, sessionId, next);
              await deps.append(sessionId, "isolation/conflict", {
                targetBranch: isolation.targetBranch,
                files: result.files,
              });
              throw Object.assign(err("conflict", result.message), { files: result.files });
            }
            const pending: SessionIsolation = {
              ...isolation,
              state: "cleanup-pending",
              resultCommit: result.sha,
            };
            await persist(deps.sessions, sessionId, pending);
            const rebound = await rebindToTarget(session, isolation, pending);
            await deps.append(sessionId, "isolation/merged", {
              targetBranch: isolation.targetBranch,
              commit: result.sha,
            });
            const cleaned = await finishCleanup(rebound, pending);
            isolationLog("published", {
              sessionId,
              projectId: session.projectId,
              targetBranch: isolation.targetBranch,
              commit: result.sha,
            });
            return {
              ok: true as const,
              commit: result.sha,
              targetBranch: isolation.targetBranch,
              session: cleaned,
            };
          }
          throw err("conflict", `${isolation.targetBranch} changed during integration; try again.`);
        } catch (error) {
          const current = await deps.sessions.snapshot(sessionId).catch(() => session);
          if (current.isolation?.state === "merging") {
            await persist(deps.sessions, sessionId, { ...isolation, state: "active" }).catch(() => undefined);
          }
          throw error;
        }
      });
    },

    async resolveWithAgent(sessionId: string): Promise<{ sessionId: string }> {
      const { isolation } = await loadSession(sessionId);
      if (!existsSync(isolation.worktreePath)) {
        await persist(deps.sessions, sessionId, { ...isolation, state: "missing" });
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
      await deps.append(sessionId, "isolation/resolve-requested", {
        targetBranch: isolation.targetBranch,
        targetHead,
        conflictCount: files.length,
      });
      await deps.sessions.send(sessionId, { text: prompt, githubConflictResolution: true });
      return { sessionId };
    },

    async discard(sessionId: string): Promise<SessionProjection> {
      const { session, isolation } = await loadSession(sessionId);
      isolationLog("discard", { sessionId, projectId: session.projectId });
      const pending: SessionIsolation = { ...isolation, state: "cleanup-pending" };
      await persist(deps.sessions, sessionId, pending);
      const rebound = await rebindToTarget(session, isolation, pending);
      await deps.append(sessionId, "isolation/discarded", {
        targetBranch: isolation.targetBranch,
      });
      return finishCleanup(rebound, pending);
    },

    async recoverSession(session: SessionProjection): Promise<SessionProjection> {
      const isolation = isolationOf(session);
      if (!isolation) return session;
      isolationLog("recovery", {
        sessionId: session.id,
        projectId: session.projectId,
        state: isolation.state,
      });
      if (isolation.state === "cleanup-pending") {
        if (session.worktreePath && resolve(session.worktreePath) === resolve(isolation.worktreePath)) {
          try {
            const rebound = await rebindToTarget(session, isolation, isolation);
            return finishCleanup(rebound, isolation);
          } catch {
            return session;
          }
        }
        return finishCleanup(session, isolation);
      }
      if (isolation.state === "merging") {
        return persist(deps.sessions, session.id, { ...isolation, state: "active" });
      }
      if (!existsSync(isolation.worktreePath)) {
        return persist(deps.sessions, session.id, { ...isolation, state: "missing" });
      }
      const owned = await managed.inspect(isolation.targetPath, isolation.worktreePath).catch(() => null);
      if (!owned && isolation.state !== "missing") {
        return persist(deps.sessions, session.id, { ...isolation, state: "missing" });
      }
      return session;
    },

    async recoverAll(): Promise<void> {
      const sessions = await deps.sessions.list();
      for (const session of sessions) {
        if (!isolationOf(session)) continue;
        try {
          await service.recoverSession(session);
        } catch (error) {
          isolationLog("recovery-failed", {
            sessionId: session.id,
            message: error instanceof Error ? error.message : String(error),
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
