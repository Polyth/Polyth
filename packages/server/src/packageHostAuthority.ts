import type { ProjectService, SessionPersistence, SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import {
  RUNTIME_SYSTEM_PRINCIPAL_ID,
  systemAppendSessionEvent,
  systemSessionsForProject,
  systemSessionsForSession,
  type ServerPackageHost,
} from "@polyth/plugins";

const PROJECT_METHODS = new Set<PropertyKey>([
  "sync", "backendSessions", "importBackendSessions", "markWorktreeMissing",
]);
const SESSION_METHODS = new Set<PropertyKey>([
  "snapshot", "events", "send", "clientMutationStatus", "abort", "fork", "archive", "restore", "delete",
  "replyPermission", "replyQuestion", "cancelResume", "resumeNow", "rewind", "clearRewind",
  "runShell", "compact", "replySecret", "rename", "organize", "queueList", "queueEditStart",
  "queueEdit", "queueSendNow", "queueEditCancel", "queueReorder", "queueRemove", "pinContext",
  "unpinContext", "autoAcceptGet", "autoAcceptSet", "confirmBorrowedRuntimeEpoch", "saveDraft",
  "markRead", "runtimeFeatures", "renameWorktreeBranch", "patchIsolation", "rebindWorkspace",
  "switchHarness", "cancelHarnessSwitch", "debug",
]);
const BLOCKED_STORE_MUTATIONS = new Set<PropertyKey>([
  "appendBatch", "copyTo", "upsertProjection", "publishChildSession", "deleteSession",
  "setReadCursor", "close", "prepareOperation", "operations", "claimOperation", "settleOperation",
]);

const unavailable = (message: string): Error => Object.assign(new Error(message), { code: "unavailable" });
const archived = (): Error => Object.assign(new Error("archived sessions are read-only"), { code: "conflict" });

async function systemProjectsForProject(host: ServerPackageHost, projectId: string): Promise<ProjectService> {
  if (host.deployment !== "local-trusted") {
    throw unavailable("global package project access requires an explicit Space context");
  }
  const project = await host.projects.get(projectId);
  if (!project?.spaceId) throw Object.assign(new Error("project not found"), { code: "not-found" });
  const ctx: SpaceContext = {
    spaceId: project.spaceId,
    spaceSlug: project.spaceId,
    userId: RUNTIME_SYSTEM_PRINCIPAL_ID,
    role: "owner",
    deployment: host.deployment,
    storageDir: "",
  };
  return host.forSpace(ctx).projects;
}

function packageProjects(host: ServerPackageHost): ProjectService {
  const raw = host.projects;
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === "get") {
        return async (projectId: string) => {
          try { return await (await systemProjectsForProject(host, projectId)).get(projectId); }
          catch (cause) {
            if ((cause as { code?: unknown } | null)?.code === "not-found") return undefined;
            throw cause;
          }
        };
      }
      if (property === "list") {
        return async () => {
          if (host.deployment !== "local-trusted") {
            throw unavailable("global package project listing requires an explicit Space context");
          }
          const result = [];
          for (const project of await raw.list()) {
            const governed = await (await systemProjectsForProject(host, project.id)).get(project.id);
            if (governed) result.push(governed);
          }
          return result;
        };
      }
      if (property === "update" || property === "remove") {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (projectId: string, ...rest: unknown[]) => {
          const scoped = await systemProjectsForProject(host, projectId);
          const method = Reflect.get(scoped, property) as ((...args: unknown[]) => unknown) | undefined;
          if (typeof method !== "function") throw unavailable(`project method unavailable: ${String(property)}`);
          return method.call(scoped, projectId, ...rest);
        };
      }
      if (property === "add" || property === "create" || property === "clone" || property === "addRemote") {
        return () => { throw unavailable("package project creation requires an explicit Space context"); };
      }
      if (property === "ensurePackageWorkspace") {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (input: { spaceId: string; packageId: string; path: string }) => {
          if (!input?.spaceId) throw unavailable("package workspace creation requires an explicit Space context");
          if (input.packageId !== host.pluginId) {
            throw unavailable("package workspace creation is bound to the calling package");
          }
          return value.call(target, input);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? () => { throw unavailable(`raw package project method is unavailable: ${String(property)}`); }
        : value;
    },
  }) as ProjectService;
}

/** Unscoped background listing stays whole-installation, but every row is still
 * admitted through its own project's canonical Space service. */
async function everyProjectSession(host: ServerPackageHost, label: string): Promise<SessionProjection[]> {
  if (host.deployment !== "local-trusted") {
    throw unavailable(`${label} requires an explicit project`);
  }
  const result: SessionProjection[] = [];
  for (const project of await host.projects.list()) {
    result.push(...await (await systemSessionsForProject(host, project.id)).list(project.id));
  }
  return result;
}

function packageSessions(host: ServerPackageHost): SessionService {
  const raw = host.sessions;
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === "create") {
        return async (input: Parameters<SessionService["create"]>[0]) =>
          (await systemSessionsForProject(host, input.projectId)).create(input);
      }
      if (property === "list") {
        return async (projectId?: string) => {
          if (projectId) return (await systemSessionsForProject(host, projectId)).list(projectId);
          return everyProjectSession(host, "package session listing");
        };
      }
      if (PROJECT_METHODS.has(property)) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (projectId: string, ...rest: unknown[]) => {
          const scoped = await systemSessionsForProject(host, projectId);
          const method = Reflect.get(scoped, property) as ((...args: unknown[]) => unknown) | undefined;
          if (typeof method !== "function") throw unavailable(`session method unavailable: ${String(property)}`);
          return method.call(scoped, projectId, ...rest);
        };
      }
      if (SESSION_METHODS.has(property)) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          const scoped = await systemSessionsForSession(host, sessionId);
          const method = Reflect.get(scoped, property) as ((...args: unknown[]) => unknown) | undefined;
          if (typeof method !== "function") throw unavailable(`session method unavailable: ${String(property)}`);
          return method.call(scoped, sessionId, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? () => { throw unavailable(`raw package session method is unavailable: ${String(property)}`); }
        : value;
    },
  }) as SessionService;
}

function packageStore(host: ServerPackageHost): ServerPackageHost["store"] {
  const raw = host.store;
  const guard = async (sessionId: string) => (await systemSessionsForSession(host, sessionId)).snapshot(sessionId);
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === "projection") {
        return async (sessionId: string) => {
          try { return await guard(sessionId); }
          catch (cause) {
            if ((cause as { code?: unknown } | null)?.code === "not-found") return undefined;
            throw cause;
          }
        };
      }
      if (property === "events") {
        return async (sessionId: string, ...rest: unknown[]) => {
          const scoped = await systemSessionsForSession(host, sessionId);
          return (scoped.events as (...args: unknown[]) => unknown).call(scoped, sessionId, ...rest);
        };
      }
      if (property === "append") {
        return (sessionId: string, type: string, data: Parameters<SessionPersistence["append"]>[2], opts?: Parameters<SessionPersistence["append"]>[3]) =>
          systemAppendSessionEvent(host, sessionId, type, data, opts);
      }
      if (property === "projections") {
        return async (projectId?: string) => {
          if (projectId) return (await systemSessionsForProject(host, projectId)).list(projectId);
          return everyProjectSession(host, "package projection listing");
        };
      }
      if (property === "hasEventOfType" || property === "latestSeq") {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          await guard(sessionId);
          const method = value as (sessionId: string, ...args: unknown[]) => unknown;
          return method.call(target, sessionId, ...rest);
        };
      }
      if (property === "patchProjection") {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          const projection = await guard(sessionId);
          if (projection.status === "archived") throw archived();
          const method = value as (sessionId: string, ...args: unknown[]) => unknown;
          return method.call(target, sessionId, ...rest);
        };
      }
      if (BLOCKED_STORE_MUTATIONS.has(property)) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? () => { throw unavailable(`raw package persistence mutation is unavailable: ${String(property)}`); }
          : value;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function"
        ? () => { throw unavailable(`raw package persistence method is unavailable: ${String(property)}`); }
        : value;
    },
  }) as ServerPackageHost["store"];
}

export function governPackageHost(host: ServerPackageHost): ServerPackageHost {
  return {
    ...host,
    projects: packageProjects(host),
    sessions: packageSessions(host),
    store: packageStore(host),
    events: {
      append: (sessionId, type, data, opts) =>
        systemAppendSessionEvent(host, sessionId, type, data, opts),
    },
  };
}
