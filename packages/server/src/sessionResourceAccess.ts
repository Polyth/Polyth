import {
  sessionAccessAtLeast,
  type SessionAccessLevel,
  type SessionProjection,
  type SessionService,
  type SessionSummaryPage,
  type SessionSummaryQuery,
  type SpaceContext,
} from "@polyth/contracts";
import type { ResourceLifecycle } from "@polyth/control-plane/resources";
import { assertNotReprovisioning } from "./personalMcpReprovision.ts";
import { canonicalSecurity } from "./runtimeSecurity.ts";
import { rowForReader, rowsForReader, sessionAccess } from "./sessionSharing.ts";

/**
 * The access each session method needs (Spaces §14.3). Reading, and a
 * person's own draft, read cursor and fork, need `view`; working in the chat
 * needs `collaborate`; settings, workspace and lifecycle need `manage`.
 * A method missing here is not access-checked by this layer, so every method
 * that names a session must be listed.
 */
const METHOD_ACCESS: Readonly<Record<string, SessionAccessLevel>> = {
  snapshot: "view", events: "view", replayPage: "view", activate: "view", debug: "view",
  clientMutationStatus: "view", queueList: "view", autoAcceptGet: "view", memoryPolicyGet: "view",
  runtimeFeatures: "view", saveDraft: "view", markRead: "view", fork: "view",
  postPersonMessage: "view", mentionCandidates: "view", setPersonMute: "view",
  startSessionFromConversation: "collaborate",

  send: "collaborate", abort: "collaborate", pause: "collaborate", continuePaused: "collaborate", replyPermission: "collaborate", replyQuestion: "collaborate",
  replySecret: "collaborate", delegatePermission: "collaborate", cancelResume: "collaborate",
  setResumeCompact: "collaborate", resumeNow: "collaborate", rewind: "collaborate", clearRewind: "collaborate",
  runShell: "collaborate", compact: "collaborate", queueEditStart: "collaborate", queueEdit: "collaborate",
  queueSendNow: "collaborate", queueEditCancel: "collaborate", queueReorder: "collaborate",
  queueRemove: "collaborate", pinContext: "collaborate", unpinContext: "collaborate",
  confirmBorrowedRuntimeEpoch: "collaborate", requestAutomaticTitle: "collaborate",
  switchHarness: "collaborate", cancelHarnessSwitch: "collaborate", restartRuntime: "collaborate",
  organize: "collaborate",

  rename: "manage", archive: "manage", restore: "manage", delete: "manage", autoAcceptSet: "manage",
  memoryPolicySet: "manage", renameWorktreeBranch: "manage", patchIsolation: "manage",
  rebindWorkspace: "manage", updateWorkspace: "manage", patchWorkspace: "manage", withWorkspaceMutation: "manage",
};
/**
 * Methods that start, queue or steer a turn, or answer one. While a shared
 * chat's runtime still carries its owner's personal MCP servers (§14.6) only
 * the owner may use them.
 */
const TURN_METHODS = new Set<PropertyKey>([
  "send", "queueSendNow", "queueEditStart", "queueEdit", "resumeNow", "continuePaused", "compact",
  "replyPermission", "replyQuestion", "replySecret", "delegatePermission",
]);
const RECOVERY_METHODS = new Set<PropertyKey>(["archive", "restore", "delete"]);
const RECOVERY_LIFECYCLES: readonly ResourceLifecycle[] = ["active", "archived", "archiving", "deleting"];
const DELETE_LIFECYCLES: readonly ResourceLifecycle[] = [...RECOVERY_LIFECYCLES, "deleted"];
/** Rows that canonical reconciliation finalizes once the domain projection is durable. */
const PROVISIONING_LIFECYCLES: readonly ResourceLifecycle[] = ["provisioning", "quarantined"];
/** A navigator page is filled from at most this many store pages. */
const SUMMARY_FILL_PAGES = 8;

const notFound = (): Error => Object.assign(new Error("session not found"), { code: "not-found" });
const forbidden = (required: SessionAccessLevel): Error => Object.assign(
  new Error(required === "manage"
    ? "Only people who manage this chat can do that"
    : "You can view this chat but not work in it"),
  { code: "forbidden" },
);

/** A pin change is the reader's own; folders and labels are shared organization. */
const organizeLevel = (patch: unknown): SessionAccessLevel => {
  const keys = patch && typeof patch === "object" ? Object.keys(patch) : [];
  return keys.length > 0 && keys.every((key) => key === "pinned") ? "view" : "collaborate";
};

/** Posting a people message is conversation access (`view`); asking the next
 *  agent prompt to carry it changes what the runtime sees and needs
 *  `collaborate`, exactly like working in the chat. */
const personMessageLevel = (input: unknown): SessionAccessLevel =>
  (input as { carryToAgent?: unknown } | null | undefined)?.carryToAgent === true ? "collaborate" : "view";

/** Final authorization layer after canonical lifecycle reconciliation. */
export function accessControlledSessionService(ctx: SpaceContext, base: SessionService): SessionService {
  const security = canonicalSecurity();
  if (!security) return base;
  if (!security.control.get("SELECT 1 FROM spaces WHERE id=?", ctx.spaceId)) {
    throw Object.assign(new Error("Space authority is inconsistent"), { code: "recovery-required" });
  }

  const require = (sessionId: string, level: SessionAccessLevel, lifecycles?: readonly ResourceLifecycle[]): void => {
    if (typeof sessionId !== "string" || !sessionId) throw notFound();
    const access = sessionAccess(ctx.userId, ctx.spaceId, sessionId, lifecycles);
    if (!access) throw notFound();
    if (!sessionAccessAtLeast(access.level, level)) throw forbidden(level);
  };
  const isNotFound = (cause: unknown): boolean => (cause as { code?: unknown } | null)?.code === "not-found";
  /**
   * A session is announced to clients the moment its projection commits, but
   * its resource stays `provisioning` until create settles (seconds, while the
   * native session starts); a crash mid-create leaves it there. Only a read
   * that reaches canonical reconciliation moves it on, as `snapshot` does
   * first. So a history read of a row the caller could read once it is
   * finalized gives reconciliation one chance before the decision — a session
   * the server just announced must not answer 404. Rows in any other
   * lifecycle, or not visible to this principal, are decided immediately and
   * never trigger reconciliation.
   */
  const requireReadableAfterReconcile = async (sessionId: string): Promise<void> => {
    try {
      require(sessionId, "view");
      return;
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
    require(sessionId, "view", PROVISIONING_LIFECYCLES);
    await base.snapshot(sessionId);
    require(sessionId, "view");
  };
  const mine = (rows: readonly SessionProjection[]): SessionProjection[] => rowsForReader(rows, ctx.userId, ctx.spaceId);

  /** The reader's page of the Space index. The store pages by recency without
   *  knowing who reads; chats this person cannot open are skipped and the page
   *  is refilled from the following store pages, so `next` stays a valid
   *  continuation. */
  const summaries = base.summaries
    ? async (query: SessionSummaryQuery): Promise<SessionSummaryPage> => {
        const limit = Math.min(100, Math.max(1, Number.isSafeInteger(query.limit) ? query.limit! : 50));
        const sessions: SessionProjection[] = [];
        let cursor = query.cursor;
        let page: SessionSummaryPage | undefined;
        for (let round = 0; round < SUMMARY_FILL_PAGES; round += 1) {
          page = await base.summaries!({ ...query, limit, ...(cursor ? { cursor } : {}) });
          sessions.push(...mine(page.sessions));
          if (sessions.length >= limit || page.complete || !page.next) break;
          cursor = page.next;
        }
        if (sessions.length > limit) {
          const kept = sessions.slice(0, limit);
          const last = kept.at(-1)!;
          return { sessions: kept, revision: page!.revision, complete: false, next: { updatedAt: last.updatedAt, id: last.id } };
        }
        return { ...page!, sessions };
      }
    : undefined;

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "list") {
        return async (projectId?: string) => mine(await target.list(projectId));
      }
      if (property === "sync") {
        return async (projectId: string) => mine(await target.sync(projectId));
      }
      if (property === "summaries") return summaries;
      if (property === "create") {
        const create = Reflect.get(target, property, receiver) as SessionService["create"];
        return async (input: Parameters<SessionService["create"]>[0]) => {
          // A delegated subagent works inside its parent chat.
          if (input?.parentId) require(input.parentId, "collaborate");
          return create.call(target, input);
        };
      }
      if (property === "replyDelegatedPermission") {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        return async (delegateSessionId: string, sessionId: string, ...rest: unknown[]) => {
          require(delegateSessionId, "collaborate");
          require(sessionId, "collaborate");
          assertNotReprovisioning(delegateSessionId, ctx.userId);
          assertNotReprovisioning(sessionId, ctx.userId);
          return (value as (...args: unknown[]) => unknown).call(target, delegateSessionId, sessionId, ...rest);
        };
      }
      const required = typeof property === "string" ? METHOD_ACCESS[property] : undefined;
      if (required) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          // Snapshot must let canonical lifecycle reconciliation run before the
          // final access decision. Lifecycle mutations, conversely, authorize
          // the caller against current visibility even when recovering an
          // interrupted archiving/deleting transition.
          if (property === "snapshot") {
            const result = await value.call(target, sessionId, ...rest) as SessionProjection;
            require(sessionId, "view");
            return rowForReader(result, ctx.userId, ctx.spaceId) ?? result;
          }
          if (property === "events" || property === "replayPage") {
            await requireReadableAfterReconcile(sessionId);
          } else {
            require(
              sessionId,
              property === "organize" ? organizeLevel(rest[0])
                : property === "postPersonMessage" ? personMessageLevel(rest[0])
                  : required,
              property === "delete"
                ? DELETE_LIFECYCLES
                : RECOVERY_METHODS.has(property) ? RECOVERY_LIFECYCLES : undefined,
            );
            if (TURN_METHODS.has(property)) assertNotReprovisioning(sessionId, ctx.userId);
          }
          return value.call(target, sessionId, ...rest);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as SessionService;
}
