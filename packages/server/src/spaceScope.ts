// Space-scoped service facades.
//
// The rule this file exists to enforce: NO request-serving code may hold the
// unscoped session or project service. The gateway resolves a SpaceContext
// first and then hands handlers a facade bound to it, so "load the resource,
// then check the tenant" is not an available mistake — the check happens
// before the underlying service is ever reached.
//
// Cross-tenant access answers `not-found`, never `forbidden`: a distinguishable
// denial would turn any id parameter into an existence oracle for other
// tenants.
import type {
  ProjectService,
  SessionActivateOptions,
  SessionProjection,
  SessionService,
  SpaceContext,
  WorkspaceMutationScope,
} from "@polyth/contracts";
import { roleAtLeast } from "@polyth/contracts";
import { runWithSecureSafeSpace, secretSavePartition } from "@polyth/credential-vault";
import { sessionsForActor } from "./accountGuardrails.ts";
import { limitedProjectsForActor, limitedSessionsForActor } from "./accountLimits.ts";
import { privateHarnessSessionsForActor, type HarnessAccess } from "./accountPermissions.ts";
import { personDefaultSessionsForActor, type PersonHarnessDefault } from "./personHarnessDefault.ts";
import type { ProjectRegistry } from "./projects.ts";
import { canonicalProjectService } from "./projectResourceAuthority.ts";
import { admittedAuthor, contextPerson, type SessionPeople } from "./sessionPeople.ts";
import { accessControlledSessionService } from "./sessionResourceAccess.ts";
import { canonicalSessionService } from "./sessionResourceAuthority.ts";
import { canonicalSecurity } from "./runtimeSecurity.ts";

const notFound = (): Error =>
  Object.assign(new Error("session not found"), { code: "not-found" });

/** Everything the guard needs from the durable store. */
export interface SpaceOwnershipSource {
  /** Owning Space of a session id (undefined = unknown or pre-tenancy). */
  spaceOfSession(sessionId: string): string | undefined;
  /** Owning Space of a project id. */
  spaceOfProject(id: string): string | undefined;
}

/** Closing a project removes the chats inside it first. A canonical resource
 *  cannot enter `deleting` while a durable child still depends on it, and a
 *  chat is unreachable once its project row is gone anyway — so the cascade
 *  loses nothing the close could have kept. Only this Space's chats go: a
 *  project id never crosses a Space, and the store list is not Space-scoped. */
function closeRemovesChats(
  ctx: SpaceContext,
  projects: ProjectService,
  sessions: SessionService,
): ProjectService {
  const drop = sessions.delete?.bind(sessions);
  if (!drop) return projects;
  const remove = projects.remove.bind(projects);
  return {
    ...projects,
    async remove(id) {
      for (const session of await sessions.list(id)) {
        if (session.spaceId && session.spaceId !== ctx.spaceId) continue;
        await drop(session.id);
      }
      await remove(id);
    },
  };
}

export interface SpaceGuard {
  /** Throws `not-found` unless the session belongs to `ctx`. */
  assertSession(ctx: Pick<SpaceContext, "spaceId">, sessionId: string): void;
  assertProject(ctx: Pick<SpaceContext, "spaceId">, projectId: string): void;
  /** Filter a projection list down to one Space. */
  owns(ctx: Pick<SpaceContext, "spaceId">, projection: SessionProjection): boolean;
}

export function createSpaceGuard(source: SpaceOwnershipSource): SpaceGuard {
  const check = (owner: string | undefined, spaceId: string): void => {
    if (owner !== spaceId) throw notFound();
  };
  const assertSession = (ctx: Pick<SpaceContext, "spaceId">, sessionId: string): void => {
    const owner = source.spaceOfSession(sessionId);
    if (owner === ctx.spaceId) return;
    // A committed hard delete can remove the projection before the resource
    // tombstone advances deleting -> deleted. Admit only that exact canonical
    // lifecycle in the same Space so retry/reconciliation can finish; every
    // other missing row remains indistinguishable from a foreign id.
    const row = canonicalSecurity()?.resources.resource(sessionId);
    if (row?.kind === "session" && row.spaceId === ctx.spaceId
      && (row.lifecycle === "deleting" || row.lifecycle === "deleted")) return;
    throw notFound();
  };
  return {
    assertSession,
    assertProject: (ctx, projectId) => check(source.spaceOfProject(projectId), ctx.spaceId),
    owns: (ctx, projection) => projection.spaceId === ctx.spaceId,
  };
}

/**
 * Return one session subtree in deepest-first lifecycle order.
 *
 * The input intentionally includes archived projections. A delegated child can
 * itself be archived while still owning live descendants, so pruning archived
 * intermediates would strand grandchildren during parent archive/delete.
 * `visited` also makes corrupted/cyclic ancestry fail closed instead of looping.
 */
export function sessionTreePostOrder(
  rootId: string,
  projections: readonly SessionProjection[],
): string[] {
  const children = new Map<string, string[]>();
  for (const projection of projections) {
    if (!projection.parentId) continue;
    const siblings = children.get(projection.parentId);
    if (siblings) siblings.push(projection.id);
    else children.set(projection.parentId, [projection.id]);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const stack: Array<{ id: string; expanded: boolean }> = [
    { id: rootId, expanded: false },
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.expanded) {
      order.push(current.id);
      continue;
    }
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    stack.push({ id: current.id, expanded: true });
    const descendants = children.get(current.id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      stack.push({ id: descendants[index]!, expanded: false });
    }
  }

  return order;
}

/**
 * A SessionService that can only see one Space.
 *
 * Every method that names a session asserts ownership before delegating, and
 * every listing is filtered at the store's indexed `space_id` column. Optional
 * methods stay optional: a facade must never make an unsupported operation
 * look supported, so an absent underlying method stays absent here.
 */
function scopeSessions(
  base: SessionService,
  ctx: SpaceContext,
  guard: SpaceGuard,
  projects: ProjectService,
  people?: SessionPeople,
): SessionService {
  const g = (sessionId: string): string => {
    guard.assertSession(ctx, sessionId);
    return sessionId;
  };
  // The signed-in person behind this context. Messages are stamped with it
  // and per-person state (draft, read cursor, pin) is theirs; system work has
  // none and sees the shared projection.
  const person = contextPerson(ctx, people?.directory);
  const personScope = person ? { userId: person.userId } : undefined;
  const mine = (rows: SessionProjection[]): SessionProjection[] =>
    person && people ? people.personalize(rows, person.userId) : rows;
  const mineOne = (row: SessionProjection): SessionProjection => mine([row])[0]!;
  const withoutPrivatePreset = <T extends { agentProfileId?: string | null }>(input: T): T => {
    if (input.agentProfileId === undefined) return input;
    const { agentProfileId: _privatePresetId, ...rest } = input;
    return rest as T;
  };
  const guarded = <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return runWithSecureSafeSpace(ctx, run);
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const opt = <A extends unknown[], R>(
    fn: ((...args: A) => R) | undefined,
    wrap: (fn: (...args: A) => R) => (...args: A) => R,
  ): ((...args: A) => R) | undefined => (fn ? wrap(fn.bind(base)) : undefined);

  const bySession = <A extends unknown[], R>(
    fn: ((sessionId: string, ...rest: A) => R) | undefined,
  ) => opt<[string, ...A], R>(
    fn as ((...args: [string, ...A]) => R) | undefined,
    (inner) => (sessionId, ...rest) => guarded(() => inner(g(sessionId), ...rest) as Promise<unknown>) as R,
  );

  const byProject = <A extends unknown[], R>(
    fn: ((projectId: string, ...rest: A) => R) | undefined,
  ) => opt<[string, ...A], R>(
    fn as ((...args: [string, ...A]) => R) | undefined,
    (inner) => (projectId, ...rest) => guarded(async () => {
      guard.assertProject(ctx, projectId);
      if (!await projects.get(projectId)) throw Object.assign(new Error("project not found"), { code: "not-found" });
      return inner(projectId, ...rest) as Promise<unknown>;
    }) as R,
  );

  const lifecycleOrder = async (sessionId: string): Promise<string[]> => {
    const root = await base.snapshot(g(sessionId));
    const rows = await base.list(root.projectId);
    return sessionTreePostOrder(
      sessionId,
      rows.filter((projection) => guard.owns(ctx, projection)),
    );
  };

  const scoped: SessionService = {
    ...(base.summaries ? { summaries: (input: import("@polyth/contracts").SessionSummaryQuery) => guarded(async () => {
      if (input.projectId) guard.assertProject(ctx, input.projectId);
      const { personId: _callerPerson, ...query } = input;
      const page = await base.summaries!({ ...query, spaceId: ctx.spaceId, ...(personScope ? { personId: personScope.userId } : {}) });
      return { ...page, sessions: mine(page.sessions) };
    }) } : {}),
    async create(input) {
      const project = await projects.get(input.projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      return runWithSecureSafeSpace(ctx, () => base.create(input));
    },
    switchHarness: base.switchHarness ? (sessionId, selection, timing, launch) => guarded(() => base.switchHarness!(g(sessionId), selection, timing, launch)) : undefined,
    cancelHarnessSwitch: base.cancelHarnessSwitch ? (sessionId) => guarded(() => base.cancelHarnessSwitch!(g(sessionId))) : undefined,
    restartRuntime: base.restartRuntime ? (sessionId) => guarded(() => base.restartRuntime!(g(sessionId))) : undefined,
    send: (sessionId, input, admission) => guarded(async () => {
      const author = admittedAuthor(ctx, admission?.author, people?.directory);
      return base.send(g(sessionId), withoutPrivatePreset(input), author ? { author } : {});
    }),
    abort: (sessionId, options) => guarded(() => base.abort(g(sessionId), options)),
    fork: (sessionId, atSeq) => guarded(() => base.fork(g(sessionId), atSeq)),
    archive: (sessionId) => guarded(async () => {
      for (const id of await lifecycleOrder(sessionId)) await base.archive(id);
    }),
    restore: (sessionId) => guarded(() => base.restore(g(sessionId))),
    async list(projectId) {
      return runWithSecureSafeSpace(ctx, async () => {
        if (projectId !== undefined) {
          guard.assertProject(ctx, projectId);
          if (!await projects.get(projectId)) throw Object.assign(new Error("project not found"), { code: "not-found" });
        }
        const rows = await base.list(projectId);
        return mine(rows.filter((p) => guard.owns(ctx, p)));
      });
    },
    async sync(projectId) {
      return runWithSecureSafeSpace(ctx, async () => {
        guard.assertProject(ctx, projectId);
        if (!await projects.get(projectId)) throw Object.assign(new Error("project not found"), { code: "not-found" });
        const rows = await base.sync(projectId);
        return mine(rows.filter((p) => guard.owns(ctx, p)));
      });
    },
    snapshot: (sessionId) => guarded(async () => mineOne(await base.snapshot(g(sessionId)))),
    events: (sessionId, afterSeq, page) => guarded(() => base.events(g(sessionId), afterSeq, page)),
    ...(base.replayPage ? { replayPage: (sessionId: string, afterSeq: number, highWater?: number) => guarded(() => base.replayPage!(g(sessionId), afterSeq, highWater)) } : {}),
    ...(base.activate ? { activate: (sessionId: string, options?: SessionActivateOptions) => guarded(() => base.activate!(g(sessionId), options)) } : {}),
    replyPermission: (sessionId, requestId, reply, scope) =>
      guarded(() => base.replyPermission(g(sessionId), requestId, reply, scope)),
    replyQuestion: (sessionId, requestId, answers) =>
      guarded(() => base.replyQuestion(g(sessionId), requestId, answers)),
  };

  const assign = <K extends keyof SessionService>(key: K, value: SessionService[K]): void => {
    if (value !== undefined) scoped[key] = value;
  };

  assign("pause", bySession(base.pause));
  assign("continuePaused", bySession(base.continuePaused));
  assign("cancelResume", bySession(base.cancelResume));
  assign("setResumeCompact", bySession(base.setResumeCompact));
  assign("resumeNow", bySession(base.resumeNow));
  assign("rewind", bySession(base.rewind));
  assign("clearRewind", bySession(base.clearRewind));
  if (base.runShell) {
    const runShell = base.runShell.bind(base);
    // The signed-in person runs it: their own Credential Vault entries
    // resolve first. System work passes nobody and sees Space entries only.
    scoped.runShell = (sessionId, command) => guarded(() => runShell(g(sessionId), command, personScope));
  }
  if (base.delete) {
    const remove = base.delete.bind(base);
    assign("delete", (sessionId) => guarded(async () => {
      let order: string[];
      try {
        order = await lifecycleOrder(sessionId);
      } catch (cause) {
        if ((cause as { code?: unknown } | null)?.code !== "not-found") throw cause;
        // The canonical delete facade can finish a deleting tombstone even
        // after its domain projection is already gone.
        await remove(g(sessionId));
        return;
      }
      for (const id of order) await remove(id);
    }));
  }
  assign("debug", bySession(base.debug));
  assign("runtimeFeatures", bySession(base.runtimeFeatures));
  assign("compact", bySession(base.compact));
  if (base.replySecret) {
    const replySecret = base.replySecret.bind(base);
    // Where a saved secret lands is decided here, from the trusted context:
    // the person's own partition unless an admin explicitly picks the Space
    // (secretSavePartition). The reply's `partition` is only a request.
    scoped.replySecret = (sessionId, requestId, reply) => guarded(async () => {
      g(sessionId);
      if (reply.action !== "save") return replySecret(sessionId, requestId, reply);
      const sharing = person ? mineOne(await base.snapshot(sessionId)).sharing : undefined;
      const partition = secretSavePartition({
        requested: reply.partition,
        person: person?.userId,
        spaceAdmin: roleAtLeast(ctx.role, "admin"),
        privateChat: Boolean(sharing && !sharing.shared && !sharing.owner),
      });
      return replySecret(sessionId, requestId, reply, partition === "personal" && person
        ? { partition: "personal", userId: person.userId }
        : { partition: "space" });
    });
  }
  assign("rename", bySession(base.rename));
  assign("requestAutomaticTitle", bySession(base.requestAutomaticTitle));
  if (base.organize) {
    const organize = base.organize.bind(base);
    scoped.organize = (sessionId, patch) => guarded(() => organize(g(sessionId), patch, personScope));
  }
  assign("queueList", bySession(base.queueList));
  assign("queueEditStart", bySession(base.queueEditStart));
  assign("queueEdit", bySession(base.queueEdit));
  assign("queueSendNow", bySession(base.queueSendNow));
  assign("queueEditCancel", bySession(base.queueEditCancel));
  assign("queueReorder", bySession(base.queueReorder));
  assign("queueRemove", bySession(base.queueRemove));
  assign("pinContext", bySession(base.pinContext));
  assign("unpinContext", bySession(base.unpinContext));
  assign("autoAcceptGet", bySession(base.autoAcceptGet));
  assign("autoAcceptSet", bySession(base.autoAcceptSet));
  assign("delegatePermission", bySession(base.delegatePermission));
  if (base.replyDelegatedPermission) {
    const replyDelegated = base.replyDelegatedPermission.bind(base);
    // Both the deciding parent and the subagent must belong to this Space.
    scoped.replyDelegatedPermission = (delegateSessionId, sessionId, requestId, reply) =>
      guarded(() => replyDelegated(g(delegateSessionId), g(sessionId), requestId, reply));
  }
  assign("confirmBorrowedRuntimeEpoch", bySession(base.confirmBorrowedRuntimeEpoch));
  if (base.saveDraft) {
    const saveDraft = base.saveDraft.bind(base);
    scoped.saveDraft = (sessionId, text, expected) => guarded(() => saveDraft(g(sessionId), text, expected, personScope));
  }
  if (base.markRead) {
    const markRead = base.markRead.bind(base);
    scoped.markRead = (sessionId, seq) => guarded(() => markRead(g(sessionId), seq, personScope));
  }
  if (base.postPersonMessage) {
    const postPersonMessage = base.postPersonMessage.bind(base);
    // The author is stamped from the authenticated context exactly like send;
    // HTTP body and admission never choose who speaks.
    scoped.postPersonMessage = (sessionId, message, admission) => guarded(async () => {
      const author = admittedAuthor(ctx, admission?.author, people?.directory);
      return postPersonMessage(g(sessionId), message, author ? { author } : {});
    });
  }
  if (base.createConversation) {
    const createConversation = base.createConversation.bind(base);
    // The conversation creator and every participant are resolved from the
    // authenticated Space context, never from the body.
    scoped.createConversation = (input, admission) => guarded(async () => {
      const project = await projects.get(input.projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      const author = admittedAuthor(ctx, admission?.author, people?.directory);
      return createConversation(input, author ? { author } : {});
    });
  }
  if (base.startSessionFromConversation) {
    const startSession = base.startSessionFromConversation.bind(base);
    // The caller becomes the owner of the new session; a view-only participant
    // is refused by the access layer (METHOD_ACCESS) before reaching here.
    scoped.startSessionFromConversation = (conversationId, input, admission) => guarded(async () => {
      const author = admittedAuthor(ctx, admission?.author, people?.directory);
      return startSession(g(conversationId), input, author ? { author } : {});
    });
  }
  if (base.mentionCandidates) {
    const mentionCandidates = base.mentionCandidates.bind(base);
    scoped.mentionCandidates = (sessionId) => guarded(() => mentionCandidates(g(sessionId), personScope));
  }
  if (base.setPersonMute) {
    const setPersonMute = base.setPersonMute.bind(base);
    scoped.setPersonMute = (sessionId, muted) => guarded(() => setPersonMute(g(sessionId), muted, personScope));
  }
  assign("memoryPolicyGet", bySession(base.memoryPolicyGet));
  assign("memoryPolicySet", bySession(base.memoryPolicySet));
  // Isolation and worktree lifecycle methods are required by the governed
  // package host (see packageHostAuthority SESSION_METHODS). Dropping them
  // here made every package-owned isolation merge fail closed as
  // "session method unavailable: patchIsolation" -> 503.
  assign("clientMutationStatus", bySession(base.clientMutationStatus));
  assign("renameWorktreeBranch", bySession(base.renameWorktreeBranch));
  assign("patchIsolation", bySession(base.patchIsolation));
  assign("rebindWorkspace", bySession(base.rebindWorkspace));
  assign("updateWorkspace", bySession(base.updateWorkspace));
  assign("patchWorkspace", bySession(base.patchWorkspace));
  if (base.withWorkspaceMutation) {
    const mutateWorkspace = base.withWorkspaceMutation.bind(base);
    scoped.withWorkspaceMutation = <T>(sessionId: string, expectedRevision: number, mutate: (scope: WorkspaceMutationScope) => Promise<T>): Promise<T> =>
      guarded(() => mutateWorkspace(g(sessionId), expectedRevision, mutate));
  }
  assign("markWorktreeMissing", byProject(base.markWorktreeMissing));
  assign("backendSessions", byProject(base.backendSessions));
  assign("importBackendSessions", byProject(base.importBackendSessions));

  return scoped;
}

export interface SpaceServices {
  ctx: SpaceContext;
  projects: ProjectService;
  sessions: SessionService;
  guard: SpaceGuard;
}

export function createSpaceServices(deps: {
  registry: ProjectRegistry;
  sessions: () => SessionService;
  guard: SpaceGuard;
  /** Who may use each restricted harness account; absent on legacy installs. */
  harnessAccess?: HarnessAccess;
  /** The acting person's own default harness for chats that pin none. */
  personHarnessDefault?: PersonHarnessDefault;
  /** Message authors and per-person session state; absent in test doubles. */
  people?: SessionPeople;
}): (ctx: SpaceContext) => SpaceServices {
  return (ctx) => {
    const projects = canonicalProjectService(ctx, deps.registry);
    const canonicalSessions = canonicalSessionService(ctx, deps.sessions(), projects);
    const sessions = accessControlledSessionService(ctx, canonicalSessions);
    return {
      ctx,
      projects: limitedProjectsForActor(ctx, closeRemovesChats(ctx, projects, canonicalSessions)),
      // Account limits, then Protected mode, narrow last, above every
      // ownership/visibility check; Protected mode's choice is limit-checked,
      // and every resulting harness choice is checked against restricted
      // accounts. The person's own default pins a chat that names no harness
      // before the limits pick their first entry.
      sessions: sessionsForActor(ctx, personDefaultSessionsForActor(ctx, limitedSessionsForActor(ctx, privateHarnessSessionsForActor(
        ctx,
        scopeSessions(sessions, ctx, deps.guard, projects, deps.people),
        deps.harnessAccess,
      ), undefined, deps.harnessAccess), deps.personHarnessDefault)),
      guard: deps.guard,
    };
  };
}

export type SpaceServicesFor = (ctx: SpaceContext) => SpaceServices;
