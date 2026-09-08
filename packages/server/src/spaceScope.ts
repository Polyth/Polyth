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
  SessionProjection,
  SessionService,
  SpaceContext,
} from "@polyth/contracts";
import type { ProjectRegistry } from "./projects.ts";

const notFound = (): Error =>
  Object.assign(new Error("session not found"), { code: "not-found" });

/** Everything the guard needs from the durable store. */
export interface SpaceOwnershipSource {
  /** Owning Space of a session id (undefined = unknown or pre-tenancy). */
  spaceOfSession(sessionId: string): string | undefined;
  /** Owning Space of a project id. */
  spaceOfProject(id: string): string | undefined;
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
    // An un-owned row predates tenancy and has not been adopted yet. Refusing
    // it is the safe answer: the boot migration adopts every existing row
    // before the gateway starts serving, so in practice this only fires for
    // rows written by an older process against a live database.
    if (owner !== spaceId) throw notFound();
  };
  return {
    assertSession: (ctx, sessionId) => check(source.spaceOfSession(sessionId), ctx.spaceId),
    assertProject: (ctx, projectId) => check(source.spaceOfProject(projectId), ctx.spaceId),
    owns: (ctx, projection) => projection.spaceId === ctx.spaceId,
  };
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
): SessionService {
  const g = (sessionId: string): string => {
    guard.assertSession(ctx, sessionId);
    return sessionId;
  };
  // Every SessionService method returns a promise, so a denial must REJECT
  // rather than throw synchronously — otherwise a caller's `.catch()` misses
  // it and an ordinary `await` still works only by accident.
  const guarded = <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return run();
    } catch (error) {
      return Promise.reject(error);
    }
  };
  // Wrap an optional method only when the underlying service has it.
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
    (inner) => (projectId, ...rest) => guarded(() => {
      guard.assertProject(ctx, projectId);
      return inner(projectId, ...rest) as Promise<unknown>;
    }) as R,
  );

  const scoped: SessionService = {
    async create(input) {
      // Creating in another Space's project is refused before the session
      // service ever runs, so no half-created row can leak across.
      const project = await projects.get(input.projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      return base.create(input);
    },
    switchHarness: base.switchHarness ? (sessionId, selection, timing) => guarded(() => base.switchHarness!(g(sessionId), selection, timing)) : undefined,
    cancelHarnessSwitch: base.cancelHarnessSwitch ? (sessionId) => guarded(() => base.cancelHarnessSwitch!(g(sessionId))) : undefined,
    send: (sessionId, input) => guarded(() => base.send(g(sessionId), input)),
    abort: (sessionId) => guarded(() => base.abort(g(sessionId))),
    fork: (sessionId, atSeq) => guarded(() => base.fork(g(sessionId), atSeq)),
    archive: (sessionId) => guarded(() => base.archive(g(sessionId))),
    restore: (sessionId) => guarded(() => base.restore(g(sessionId))),
    async list(projectId) {
      if (projectId !== undefined) guard.assertProject(ctx, projectId);
      const rows = await base.list(projectId);
      return rows.filter((p) => guard.owns(ctx, p));
    },
    async sync(projectId) {
      guard.assertProject(ctx, projectId);
      const rows = await base.sync(projectId);
      return rows.filter((p) => guard.owns(ctx, p));
    },
    snapshot: (sessionId) => guarded(() => base.snapshot(g(sessionId))),
    events: (sessionId, afterSeq, page) => guarded(() => base.events(g(sessionId), afterSeq, page)),
    replyPermission: (sessionId, requestId, reply, scope) =>
      guarded(() => base.replyPermission(g(sessionId), requestId, reply, scope)),
    replyQuestion: (sessionId, requestId, answers) =>
      guarded(() => base.replyQuestion(g(sessionId), requestId, answers)),
  };

  const assign = <K extends keyof SessionService>(key: K, value: SessionService[K]): void => {
    if (value !== undefined) scoped[key] = value;
  };

  assign("cancelResume", bySession(base.cancelResume));
  assign("resumeNow", bySession(base.resumeNow));
  assign("rewind", bySession(base.rewind));
  assign("clearRewind", bySession(base.clearRewind));
  assign("runShell", bySession(base.runShell));
  assign("delete", bySession(base.delete));
  assign("debug", bySession(base.debug));
  assign("replySecret", bySession(base.replySecret));
  assign("rename", bySession(base.rename));
  assign("organize", bySession(base.organize));
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
  assign("confirmBorrowedRuntimeEpoch", bySession(base.confirmBorrowedRuntimeEpoch));
  assign("saveDraft", bySession(base.saveDraft));
  assign("markRead", bySession(base.markRead));
  assign("markWorktreeMissing", byProject(base.markWorktreeMissing));
  assign("backendSessions", byProject(base.backendSessions));
  assign("importBackendSessions", byProject(base.importBackendSessions));

  return scoped;
}

/** Both scoped services for one request, built together so a handler cannot
 *  accidentally pair a scoped session service with the unscoped registry. */
export interface SpaceServices {
  ctx: SpaceContext;
  projects: ProjectService;
  sessions: SessionService;
  guard: SpaceGuard;
}

export function createSpaceServices(deps: {
  registry: ProjectRegistry;
  /** A thunk: the session service is composed after packages load, while the
   *  factory is needed while wiring them. */
  sessions: () => SessionService;
  guard: SpaceGuard;
}): (ctx: SpaceContext) => SpaceServices {
  return (ctx) => {
    const projects = deps.registry.forSpace(ctx);
    return {
      ctx,
      projects,
      sessions: scopeSessions(deps.sessions(), ctx, deps.guard, projects),
      guard: deps.guard,
    };
  };
}

/** How every route factory receives tenant-scoped services: it is handed the
 *  resolver, not the services, so it MUST pass a SpaceContext to get anything
 *  at all. Route handlers call `spaces(rc.space)`. */
export type SpaceServicesFor = (ctx: SpaceContext) => SpaceServices;
