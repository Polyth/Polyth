// Server side of "move a chat between checkouts of one project". The route
// closures it needs (busy guard, typed refusals, topology announce) are passed
// in by `gitRoutes`; this module owns only the ordering and the safety checks.
import { basename, resolve } from "node:path";
import type { Project, SessionAccessLevel, SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import { delegatedChildRunning, sessionAccessAtLeast } from "@polyth/contracts";
import type { GitService, Worktree } from "./index.ts";
import { isManagedBranch } from "./managedWorktrees.ts";
import type {
  SessionCheckoutBlock, SessionCheckoutInput, SessionCheckoutPlace, SessionCheckoutPreview,
  SessionCheckoutPreviewInput, SessionCheckoutResult, SessionCheckoutTarget,
} from "./sessionCheckoutMove.ts";

export interface SessionCheckoutMoveDeps {
  sessions: SessionService;
  /** The requester's own scope. Chats resolve through it, so one this person
   *  cannot open is `not-found`; absent in minimal deployments and test fakes. */
  scopedSessions?: (space: SpaceContext) => Pick<SessionService, "snapshot">;
  git: GitService;
  projectOf(projectId: string): Promise<Project>;
  sessionsInCheckout(projectId: string, root: string, space: SpaceContext): Promise<SessionProjection[]>;
  assertCheckoutIdle(projectId: string, root: string, space: SpaceContext): Promise<void>;
  refusalBody(error: unknown, projectId: string, root: string, space: SpaceContext):
    Promise<{ status: number; body: Record<string, unknown> } | null>;
  afterBranchChange(projectId: string, root: string, space: SpaceContext): Promise<void>;
  announceTopology(projectId: string, root: string): Promise<void>;
  ownedBranchForWorktree(sessions: SessionService, projectId: string, worktreePath: string): Promise<string | null>;
}

const coded = (code: string, message: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(message), { code, ...extra });

const notFound = (): Error => coded("not-found", "session not found");

const BLOCK_MESSAGE: Record<SessionCheckoutBlock["reason"], string> = {
  busy: "This chat is working. Stop it or wait until it finishes, then move it.",
  queued: "This chat has queued messages. Wait until they are sent, then move it.",
  archived: "An archived chat cannot be moved.",
  isolated: "An isolated chat's checkout belongs to its isolation.",
  delegated: "This chat is delegated work, or has subagents still running or holding isolated work in this checkout.",
  "missing-target": "That checkout no longer exists.",
  "same-checkout": "The chat is already in this checkout.",
  unsupported: "Only the project's primary repository supports moving between checkouts.",
  "other-machine": "A chat can't move to or from a project on another machine.",
};
const block = (reason: SessionCheckoutBlock["reason"]): SessionCheckoutBlock => ({ reason, message: BLOCK_MESSAGE[reason] });

const dirtyOf = (status: Awaited<ReturnType<GitService["status"]>>): number =>
  status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length;

export function createSessionCheckoutMove(deps: SessionCheckoutMoveDeps) {
  const { git } = deps;

  const dirtyCount = async (root: string): Promise<{ count: number; files: string[]; branch: string | null; readable: boolean }> => {
    try {
      const status = await git.status(root);
      const files = [...status.staged, ...status.unstaged, ...status.untracked, ...status.conflicted].map((entry) => entry.path);
      return { count: files.length, files: files.slice(0, 20), branch: status.branch, readable: true };
    } catch {
      return { count: 0, files: [], branch: null, readable: false };
    }
  };

  /** The chat, resolved through the requester's scope. Any failure, a foreign
   *  Space and an unknown id alike, is the same `not-found`. Previewing needs
   *  `view`; moving changes the chat's workspace and needs `manage`. */
  const loadSession = async (sessionId: string, space: SpaceContext, required: SessionAccessLevel): Promise<SessionProjection> => {
    let session: SessionProjection | undefined;
    try { session = await (deps.scopedSessions?.(space) ?? deps.sessions).snapshot(sessionId); } catch { session = undefined; }
    if (!session || (session.spaceId !== undefined && session.spaceId !== space.spaceId)) throw notFound();
    if (session.sharing && !sessionAccessAtLeast(session.sharing.access, required)) {
      throw coded("forbidden", required === "manage"
        ? "Only people who manage this chat can do that"
        : "You can view this chat but not work in it");
    }
    return session;
  };

  const load = async (input: SessionCheckoutPreviewInput, space: SpaceContext, required: SessionAccessLevel) => {
    if (!input || typeof input.sessionId !== "string" || !input.sessionId) throw coded("invalid-input", "sessionId required");
    const session = await loadSession(input.sessionId, space, required);
    const project = await deps.projectOf(session.projectId);
    if (project.spaceId !== undefined && project.spaceId !== space.spaceId) throw notFound();
    const target = input.target as SessionCheckoutTarget | undefined;
    const wantsMain = !!target && "main" in target && target.main === true;
    const wantsPath = !!target && "worktreePath" in target && typeof target.worktreePath === "string" && target.worktreePath !== "";
    if (wantsMain === wantsPath) throw coded("invalid-input", "target must be { main: true } or { worktreePath }");
    const projectRoot = project.path;
    const listed: Worktree[] = project.remote ? [] : await git.worktrees.list(projectRoot).catch(() => []);
    // Never a raw client path: the target is a row Git lists for this repository.
    const match: Worktree | undefined = wantsMain
      ? undefined
      : listed.find((item) => resolve(item.path) === resolve((target as { worktreePath: string }).worktreePath));
    const toMain = wantsMain || match?.isMain === true;
    const toPath = toMain ? projectRoot : match?.path;
    const toEntry = toMain ? listed.find((item) => item.isMain) : match;
    const fromPath = session.worktreePath ?? projectRoot;
    const fromMain = resolve(fromPath) === resolve(projectRoot);
    return { session, project, projectRoot, listed, toMain, toPath, toEntry, fromPath, fromMain };
  };

  const blockOf = async (state: Awaited<ReturnType<typeof load>>, space: SpaceContext): Promise<SessionCheckoutBlock | undefined> => {
    const { session, project, toPath, toEntry, toMain, fromPath } = state;
    if (project.remote) return block("other-machine");
    if ((session.workspace?.repositories?.length ?? 0) > 1) return block("unsupported");
    if (session.status === "archived") return block("archived");
    if (session.isolation || isManagedBranch(session.branch ?? "")) return block("isolated");
    // The complete list, not the requester's scope: a hidden child still works
    // in this checkout. Finished children stay where they are.
    if (session.parentId && !session.forkOf) return block("delegated");
    const children = (await deps.sessions.list(session.projectId)).filter((row) =>
      row.status !== "archived" && row.parentId === session.id && !row.forkOf
      && (row.spaceId === undefined || row.spaceId === space.spaceId));
    const here = resolve(fromPath);
    if (children.some((row) => delegatedChildRunning(row.status)
      || (row.isolation && [row.isolation.targetPath, row.isolation.originPath].some((path) => path !== undefined && resolve(path) === here)))) {
      return block("delegated");
    }
    if (delegatedChildRunning(session.status)) return block("busy");
    const queued = await deps.sessions.queueList?.(session.id).catch(() => []) ?? [];
    if (queued.length) return block("queued");
    if (!toPath || !toEntry || (!toMain && isManagedBranch(toEntry.branch ?? ""))) return block("missing-target");
    if (resolve(toPath) === resolve(fromPath)) return block("same-checkout");
    return undefined;
  };

  const place = (path: string, branch: string | null, isMain: boolean, project: Project): SessionCheckoutPlace =>
    ({ path, branch, isMain, label: isMain ? project.name : basename(path) });

  const preview = async (input: SessionCheckoutPreviewInput, space: SpaceContext): Promise<SessionCheckoutPreview> => {
    const state = await load(input, space, "view");
    const { session, project, projectRoot, listed, toPath, toEntry, toMain, fromPath, fromMain } = state;
    const blocked = await blockOf(state, space);
    const source = await dirtyCount(fromPath);
    const fromBranch = source.readable ? source.branch : session.branch ?? null;
    const target = toPath ? await dirtyCount(toPath) : { count: 0, files: [], branch: null, readable: false };
    const toBranch = toEntry ? toEntry.branch : null;
    const others = fromMain ? [] : (await deps.sessionsInCheckout(session.projectId, fromPath, space)).filter((row) => row.id !== session.id);
    const owned = fromMain ? null : await deps.ownedBranchForWorktree(deps.sessions, session.projectId, fromPath);
    let merged = false;
    if (owned && toPath) merged = await git.isAncestor(toPath, owned, "HEAD").catch(() => false);
    const branches: SessionCheckoutPreview["branches"] = [];
    if (toPath && target.readable) {
      const inUse = new Map(listed.filter((item) => item.branch && resolve(item.path) !== resolve(toPath)).map((item) => [item.branch!, basename(item.path)]));
      const rows = await git.branches(toPath).catch(() => ({ current: null, branches: [] }));
      for (const row of rows.branches) {
        if (isManagedBranch(row.name)) continue;
        const holder = row.remote ? undefined : inUse.get(row.name);
        branches.push({ name: row.name, ...(row.remote ? { remote: true } : {}), ...(holder ? { inUseBy: holder } : {}) });
      }
    }
    return {
      from: place(fromPath, fromBranch, fromMain, project),
      to: {
        ...place(toPath ?? "", toBranch, toMain, project),
        dirtyCount: target.count,
        ...(toEntry && toEntry.branch === null ? { detached: true } : {}),
      },
      restartsAgent: !!session.runtimeBinding,
      lastSessionInSource: !fromMain && others.length === 0,
      sourceDirtyCount: source.count,
      sourceBranchOwned: !!owned,
      sourceBranchMerged: merged,
      branches,
      expectedWorkspaceRevision: session.workspace?.revision ?? 0,
      ...(blocked ? { blocked } : {}),
    };
  };

  /** Throws the typed refusal for a blocked move: nothing has started. */
  const refuseBlocked = (blocked: SessionCheckoutBlock, sessionId: string): never => {
    switch (blocked.reason) {
      case "busy": case "queued": throw coded("session-busy", blocked.message, { sessionIds: [sessionId] });
      case "missing-target": throw coded("not-found", blocked.message);
      case "unsupported": case "other-machine": throw coded("unsupported", blocked.message);
      default: throw coded("conflict", blocked.message, { reason: blocked.reason });
    }
  };

  const moveInner = async (input: SessionCheckoutInput, space: SpaceContext, onLoaded: (projectId: string) => void): Promise<SessionCheckoutResult> => {
    const state = await load(input, space, "manage");
    const { session, projectRoot, toPath, toMain, toEntry, fromPath, fromMain } = state;
    const projectId = session.projectId;
    onLoaded(projectId);
    // (a) validate
    if (typeof input.expectedWorkspaceRevision !== "number") throw coded("invalid-input", "expectedWorkspaceRevision required");
    if ((session.workspace?.revision ?? 0) !== input.expectedWorkspaceRevision) {
      throw coded("conflict", "The chat changed since the preview. Review it again.");
    }
    const blocked = await blockOf(state, space);
    if (blocked) refuseBlocked(blocked, session.id);
    if (!toPath || !toEntry) throw coded("not-found", BLOCK_MESSAGE["missing-target"]);
    if (!deps.sessions.rebindWorkspace) throw coded("unsupported", "session workspace rebind is unavailable");
    const choice = input.branch ?? { kind: "keep" as const };
    if (choice.kind !== "keep" && (typeof choice.name !== "string" || !choice.name.trim())) {
      throw coded("invalid-input", "branch name required");
    }
    let ownedBranch: string | null = null;
    if (input.removeSource) {
      if (fromMain) throw coded("invalid-input", "the main checkout cannot be removed");
      const others = (await deps.sessionsInCheckout(projectId, fromPath, space)).filter((row) => row.id !== session.id);
      if (others.length) throw coded("conflict", "Another chat still uses this worktree, so it was not removed.");
      const source = await dirtyCount(fromPath);
      if (source.count > 0) {
        throw coded("worktree-dirty", `${source.count} uncommitted changes — the worktree stays so nothing is lost.`, { count: source.count, files: source.files });
      }
      // The scalar is read now: after the rebind nothing names the source.
      ownedBranch = await deps.ownedBranchForWorktree(deps.sessions, projectId, fromPath);
      if (input.removeSource.deleteBranch && choice.kind === "switch" && ownedBranch && choice.name === ownedBranch) {
        throw coded("invalid-input", "cannot delete the branch the target is switching to");
      }
    }
    // (b) rebind: releases the old native execution and bumps the revision.
    await deps.sessions.rebindWorkspace(session.id, {
      expectedWorkspaceRevision: input.expectedWorkspaceRevision,
      worktreePath: toMain ? null : toPath,
      branch: toEntry.branch,
    });
    await deps.announceTopology(projectId, projectRoot);
    const result: Partial<SessionCheckoutResult> = {};
    // (c) remove the freed source, re-checked now that the chat has left it.
    if (input.removeSource) {
      try {
        const others = (await deps.sessionsInCheckout(projectId, fromPath, space)).filter((row) => row.id !== session.id);
        if (others.length) throw coded("conflict", "Another chat now uses this worktree, so it was not removed.");
        const activeIsolation = (await deps.sessions.list(projectId)).some((row) =>
          row.isolation?.kind === "git-worktree" && resolve(row.isolation.worktreePath) === resolve(fromPath));
        if (activeIsolation) throw coded("conflict", "An isolated chat uses this worktree, so it was not removed.");
        const source = await dirtyCount(fromPath);
        if (source.count > 0) throw coded("worktree-dirty", `${source.count} uncommitted changes — the worktree stays so nothing is lost.`);
        const merged = !!ownedBranch && await git.isAncestor(toPath, ownedBranch, "HEAD").catch(() => false);
        const deleteBranch = input.removeSource.deleteBranch === true && !!ownedBranch && merged;
        const cleanup = await git.worktrees.remove(projectRoot, {
          path: fromPath, deleteBranch, force: false, ...(deleteBranch && ownedBranch ? { ownedBranch } : {}),
        }) ?? {};
        await deps.announceTopology(projectId, projectRoot);
        await deps.sessions.markWorktreeMissing?.(projectId, fromPath).catch((error: unknown) => {
          console.error("[polyth] worktree metadata cleanup failed after removal", error);
        });
        result.removed = { path: fromPath, branchDeleted: deleteBranch && !cleanup.branchCleanupFailed };
      } catch (error) {
        const refusal = error as Error & { code?: string };
        result.removeError = { code: refusal.code ?? "other", message: refusal.message };
      }
    }
    // (d) branch change in the target; a refusal leaves the chat moved.
    if (choice.kind !== "keep") {
      try {
        await deps.assertCheckoutIdle(projectId, toPath, space);
        if (choice.kind === "create") {
          await git.createBranch(toPath, choice.name, choice.from, { checkout: true });
        } else {
          const remote = (await git.branches(toPath).catch(() => ({ branches: [] as Array<{ name: string; remote?: string }> })))
            .branches.find((row) => row.remote && row.name === choice.name);
          if (remote) {
            const local = choice.name.slice(choice.name.indexOf("/") + 1);
            const existing = (await git.branches(toPath)).branches.some((row) => !row.remote && row.name === local);
            if (existing) await git.checkout(toPath, local);
            else await git.createBranch(toPath, local, choice.name, { checkout: true });
          } else {
            await git.checkout(toPath, choice.name);
          }
        }
        await deps.afterBranchChange(projectId, toPath, space);
      } catch (error) {
        const refused = await deps.refusalBody(error, projectId, toPath, space).catch(() => null);
        const refusal = error as Error & { code?: string };
        result.branchError = refused
          ? { code: String(refused.body.error), message: String(refused.body.message ?? refusal.message) }
          : { code: refusal.code ?? "other", message: refusal.message };
        // A failed branch change may still have changed nothing; re-announce is cheap.
        await deps.announceTopology(projectId, projectRoot).catch(() => undefined);
      }
    }
    return { session: await deps.sessions.snapshot(session.id), ...result };
  };

  /** The move as a route answers it: a typed Git refusal becomes its 409/404
   *  body, anything else is thrown for the route's generic error mapping. */
  const move = async (input: SessionCheckoutInput, space: SpaceContext): Promise<{ status: number; body: unknown }> => {
    let projectId: string | undefined;
    try {
      return { status: 200, body: await moveInner(input, space, (id) => { projectId = id; }) };
    } catch (error) {
      const refused = projectId
        ? await deps.refusalBody(error, projectId, (await deps.projectOf(projectId)).path, space).catch(() => null)
        : null;
      if (!refused) throw error;
      return refused;
    }
  };

  return { preview, move };
}
