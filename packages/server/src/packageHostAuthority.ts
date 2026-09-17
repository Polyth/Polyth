import type { SessionService } from "@polyth/contracts";
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

const unavailable = (message: string): Error => Object.assign(new Error(message), { code: "unavailable" });

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

/**
 * Package code is trusted application code, but it is not a tenant authority.
 * Route handlers already receive `rc.space`; background work must derive its
 * Space from the durable project/session it operates on. This wrapper removes
 * the raw unscoped SessionService/event append from discovered packages while
 * preserving the rest of the host contract.
 */
export function governPackageHost(host: ServerPackageHost): ServerPackageHost {
  return {
    ...host,
    sessions: packageSessions(host),
    events: {
      append: (sessionId, type, data, opts) =>
        systemAppendSessionEvent(host, sessionId, type, data, opts),
    },
  };
}
