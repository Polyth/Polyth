import type { SessionPersistence, SessionService } from "@polyth/contracts";
import {
  systemAppendSessionEvent,
  systemSessionsForProject,
  systemSessionsForSession,
  type ServerPackageHost,
} from "@polyth/plugins";

const PROJECT_METHODS = new Set<PropertyKey>([
  "sync", "backendSessions", "importBackendSessions", "markWorktreeMissing",
]);
const SESSION_METHODS = new Set<PropertyKey>([
  "snapshot", "events", "send", "abort", "fork", "archive", "restore", "delete",
  "replyPermission", "replyQuestion", "cancelResume", "resumeNow", "rewind", "clearRewind",
  "runShell", "compact", "replySecret", "rename", "organize", "queueList", "queueEditStart",
  "queueEdit", "queueSendNow", "queueEditCancel", "queueReorder", "queueRemove", "pinContext",
  "unpinContext", "autoAcceptGet", "autoAcceptSet", "confirmBorrowedRuntimeEpoch", "saveDraft",
  "markRead", "runtimeFeatures", "switchHarness", "cancelHarnessSwitch", "debug",
]);
const BLOCKED_STORE_MUTATIONS = new Set<PropertyKey>([
  "appendBatch", "copyTo", "upsertProjection", "publishChildSession",
]);

const unavailable = (message: string): Error => Object.assign(new Error(message), { code: "unavailable" });
const archived = (): Error => Object.assign(new Error("archived sessions are read-only"), { code: "conflict" });

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
          if (!projectId) throw unavailable("package session listing requires an explicit project");
          return (await systemSessionsForProject(host, projectId)).list(projectId);
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
      return Reflect.get(target, property, receiver);
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
          if (!projectId) throw unavailable("package projection listing requires an explicit project");
          return (await systemSessionsForProject(host, projectId)).list(projectId);
        };
      }
      if (property === "hasEventOfType" || property === "latestSeq") {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          await guard(sessionId);
          return value.call(target, sessionId, ...rest);
        };
      }
      if (property === "patchProjection") {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          const projection = await guard(sessionId);
          if (projection.status === "archived") throw archived();
          return value.call(target, sessionId, ...rest);
        };
      }
      if (BLOCKED_STORE_MUTATIONS.has(property)) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function"
          ? () => { throw unavailable(`raw package persistence mutation is unavailable: ${String(property)}`); }
          : value;
      }
      return Reflect.get(target, property, receiver);
    },
  }) as ServerPackageHost["store"];
}

/**
 * Package code is trusted application code, but it is not a tenant authority.
 * Route handlers already receive `rc.space`; background work must derive its
 * Space from the durable project/session it operates on. This wrapper removes
 * raw unscoped session authority from discovered packages while preserving the
 * infrastructure seams that do not address tenant resources.
 */
export function governPackageHost(host: ServerPackageHost): ServerPackageHost {
  return {
    ...host,
    sessions: packageSessions(host),
    store: packageStore(host),
    events: {
      append: (sessionId, type, data, opts) =>
        systemAppendSessionEvent(host, sessionId, type, data, opts),
    },
  };
}
