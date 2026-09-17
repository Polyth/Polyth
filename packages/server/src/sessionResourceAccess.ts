import type { SessionProjection, SessionService, SpaceContext } from "@polyth/contracts";
import type { ResourceLifecycle } from "@polyth/control-plane/resources";
import { canonicalSecurity } from "./runtimeSecurity.ts";

const SESSION_METHODS = new Set<PropertyKey>([
  "snapshot", "events", "send", "clientMutationStatus", "abort", "fork", "archive", "restore", "delete",
  "replyPermission", "replyQuestion", "cancelResume", "resumeNow", "rewind", "clearRewind",
  "runShell", "compact", "replySecret", "rename", "organize", "queueList", "queueEditStart",
  "queueEdit", "queueSendNow", "queueEditCancel", "queueReorder", "queueRemove", "pinContext",
  "unpinContext", "autoAcceptGet", "autoAcceptSet", "confirmBorrowedRuntimeEpoch", "saveDraft",
  "markRead", "runtimeFeatures", "renameWorktreeBranch", "patchIsolation", "rebindWorkspace",
  "switchHarness", "cancelHarnessSwitch", "debug",
]);
const RECOVERY_METHODS = new Set<PropertyKey>(["archive", "restore", "delete"]);
const RECOVERY_LIFECYCLES: readonly ResourceLifecycle[] = ["active", "archived", "archiving", "deleting"];

/** Final read-authorization layer after canonical lifecycle reconciliation. */
export function accessControlledSessionService(ctx: SpaceContext, base: SessionService): SessionService {
  const security = canonicalSecurity();
  if (!security) return base;
  const org = security.control.get<{ id: string }>("SELECT org_id AS id FROM spaces WHERE id=?", ctx.spaceId);
  if (!org) throw Object.assign(new Error("Space authority is inconsistent"), { code: "recovery-required" });

  const requireReadable = (sessionId: string, lifecycles?: readonly ResourceLifecycle[]): void => {
    const row = security.resourceAccess.requireReadable({
      resourceId: sessionId,
      principalId: ctx.userId,
      orgId: org.id,
      spaceId: ctx.spaceId,
      ...(lifecycles ? { lifecycles } : {}),
    });
    if (row.kind !== "session") throw Object.assign(new Error("session not found"), { code: "not-found" });
  };
  const readable = (projection: SessionProjection): boolean => {
    try { requireReadable(projection.id); return true; }
    catch (cause) {
      if ((cause as { code?: unknown } | null)?.code === "not-found") return false;
      throw cause;
    }
  };

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "list") {
        return async (projectId?: string) => (await target.list(projectId)).filter(readable);
      }
      if (property === "sync") {
        return async (projectId: string) => (await target.sync(projectId)).filter(readable);
      }
      if (SESSION_METHODS.has(property)) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          // Snapshot must let canonical lifecycle reconciliation run before the
          // final access decision. Lifecycle mutations, conversely, authorize
          // the caller against current visibility even when recovering an
          // interrupted archiving/deleting transition.
          if (property === "snapshot") {
            const result = await value.call(target, sessionId, ...rest);
            requireReadable(sessionId);
            return result;
          }
          requireReadable(sessionId, RECOVERY_METHODS.has(property) ? RECOVERY_LIFECYCLES : undefined);
          return value.call(target, sessionId, ...rest);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as SessionService;
}
