import { randomUUID } from "node:crypto";
import {
  roleAtLeast,
  type CreateConversationInput,
  type ForkResult,
  type ProjectService,
  type SessionProjection,
  type SessionRef,
  type SessionService,
  type StartSessionFromConversationInput,
  type StartSessionFromConversationResult,
  type SpaceContext,
  type TurnAdmission,
} from "@polyth/contracts";
import type { CanonicalResource } from "@polyth/control-plane/resources";
import { canonicalSecurity } from "./runtimeSecurity.ts";
import { defaultSessionVisibility } from "./sessionSharing.ts";

const recovery = (): Error => Object.assign(
  new Error("Session domain state does not match the canonical resource authority"),
  { code: "recovery-required" },
);
const notFound = (): Error => Object.assign(new Error("session not found"), { code: "not-found" });
const forbidden = (): Error => Object.assign(
  new Error("Space member access is required to modify sessions"),
  { code: "forbidden" },
);
const archived = (): Error => Object.assign(
  new Error("Archived sessions are read-only until restored"),
  { code: "conflict" },
);

const receipt = (projection: SessionProjection): string => JSON.stringify({
  id: projection.id,
  projectId: projection.projectId,
  spaceId: projection.spaceId ?? null,
  parentId: projection.parentId ?? null,
});

type CanonicalLifecycle = CanonicalResource["lifecycle"];

export function canonicalSessionService(
  ctx: SpaceContext,
  base: SessionService,
  projects: ProjectService,
): SessionService {
  const security = canonicalSecurity();
  if (!security) return base;
  const org = security.control.get<{ id: string }>(
    "SELECT org_id AS id FROM spaces WHERE id=?",
    ctx.spaceId,
  );
  if (!org) throw recovery();
  const scope = { orgId: org.id, spaceId: ctx.spaceId };

  const requireMutation = (): void => {
    if (!roleAtLeast(ctx.role, "member")) throw forbidden();
  };
  const resource = (id: string): CanonicalResource | undefined => security.resources.resource(id);
  const assertScope = (row: CanonicalResource, projection?: Pick<SessionProjection, "projectId" | "spaceId">): void => {
    if (row.kind !== "session" || row.orgId !== org.id || row.spaceId !== ctx.spaceId) throw recovery();
    if (projection && (projection.spaceId !== ctx.spaceId || row.parentId !== projection.projectId)) throw recovery();
  };
  const transition = (
    id: string,
    from: readonly CanonicalLifecycle[],
    to: CanonicalLifecycle,
    expectedRevision: number,
    action: string,
    bumpAccess: boolean,
    actor = ctx.userId,
  ): CanonicalResource => security.resourceLifecycle.transition({
    resourceId: id,
    kind: "session",
    orgId: org.id,
    spaceId: ctx.spaceId,
    from,
    to,
    expectedRevision,
    actor,
    action,
    bumpAccess,
  });

  const projectionIfPresent = async (id: string): Promise<SessionProjection | undefined> => {
    try { return await base.snapshot(id); }
    catch (cause) {
      if ((cause as { code?: unknown } | null)?.code === "not-found") return undefined;
      throw cause;
    }
  };

  const finalizeProvisioning = (projection: SessionProjection, row: CanonicalResource): CanonicalResource => {
    assertScope(row, projection);
    const saga = security.resources.pending().find((candidate) => candidate.resourceId === projection.id);
    if (!saga) throw recovery();
    security.resources.recordDomainReady(saga.operationId, receipt(projection));
    const current = resource(projection.id);
    if (!current) throw recovery();
    return security.resources.activate(saga.operationId, current.revision);
  };

  const reconcileReadable = (projection: SessionProjection): CanonicalResource => {
    let row = resource(projection.id);
    if (!row) throw recovery();
    assertScope(row, projection);
    if (row.lifecycle === "provisioning" || row.lifecycle === "quarantined") {
      row = finalizeProvisioning(projection, row);
    }
    if (row.lifecycle === "archiving") {
      row = projection.status === "archived"
        ? transition(row.id, ["archiving"], "archived", row.revision, "resource.archived", true)
        : transition(row.id, ["archiving"], "active", row.revision, "resource.archive-rolled-back", true);
    } else if (row.lifecycle === "archived" && projection.status !== "archived") {
      row = transition(row.id, ["archived"], "active", row.revision, "resource.restored", true);
    }
    // A delete removes the domain projection before it settles its runtime
    // tombstone. A concurrent list/read can therefore observe this row while
    // the original delete is still in flight. Do not roll it back merely
    // because the projection is still present: that turns a harmless
    // duplicate observation into "Resource lifecycle changed" after the
    // original delete has already removed its durable rows. Boot recovery
    // (when no in-process delete can still be running) handles interrupted
    // deletes explicitly.
    if (row.lifecycle === "deleted" || (row.lifecycle === "active" && projection.status === "archived")) throw recovery();
    return row;
  };

  /** Adopt a domain row that has no canonical resource yet. Rows that
   *  predate sharing keep following their project; a delegated child follows
   *  its parent chat; a new chat a person makes (a fork, an import) starts
   *  with the Space's default audience. */
  const adoptCreated = (
    projection: SessionProjection,
    actor = ctx.userId,
    sharing: { visibility?: "private" | "inherit"; accessParentId?: string } = {},
  ): CanonicalResource => {
    const project = security.resources.active(projection.projectId, scope);
    if (!project || project.kind !== "project") throw recovery();
    const existing = resource(projection.id);
    if (existing) return reconcileReadable(projection);
    const operationId = randomUUID();
    security.resources.begin({
      operationId,
      resourceId: projection.id,
      kind: "session",
      orgId: org.id,
      spaceId: ctx.spaceId,
      parentId: projection.projectId,
      ...(sharing.accessParentId ? { accessParentId: sharing.accessParentId } : {}),
      ownerPrincipalId: actor,
      createdBy: actor,
      visibility: sharing.accessParentId ? "inherit" : sharing.visibility ?? "inherit",
    });
    security.resources.recordDomainReady(operationId, receipt(projection));
    const current = resource(projection.id);
    if (!current) throw recovery();
    return security.resources.activate(operationId, current.revision);
  };

  const adoptDerivedImportedChild = async (projection: SessionProjection): Promise<void> => {
    if (resource(projection.id)) return;
    if (!projection.parentId) {
      // Top-level domain rows from before canonical resources, or leftovers
      // whose project left this Space, must not fail closed the whole list.
      const project = security.resources.active(projection.projectId, scope);
      if (!project || project.kind !== "project") throw notFound();
      adoptCreated(projection);
      return;
    }
    const parent = resource(projection.parentId);
    if (!parent || parent.kind !== "session" || parent.orgId !== org.id || parent.spaceId !== ctx.spaceId
      || (parent.lifecycle !== "active" && parent.lifecycle !== "archived")) throw recovery();
    const events = await base.events(projection.id);
    if (!events.some((event) => event.type === "session/imported")) throw recovery();
    adoptCreated(projection, parent.ownerPrincipalId, { accessParentId: parent.id });
  };

  const admitProjection = async (projection: SessionProjection): Promise<SessionProjection | undefined> => {
    if (projection.spaceId !== undefined && projection.spaceId !== ctx.spaceId) return undefined;
    try {
      await adoptDerivedImportedChild(projection);
      reconcileReadable(projection);
      return projection;
    } catch (cause) {
      if ((cause as { code?: unknown } | null)?.code === "not-found") return undefined;
      throw cause;
    }
  };

  const readProjection = async (id: string): Promise<SessionProjection> => {
    const projection = await base.snapshot(id);
    const admitted = await admitProjection(projection);
    if (!admitted) throw notFound();
    return admitted;
  };

  const reconcileMissingDeletes = async (): Promise<void> => {
    const rows = security.control.all<{ id: string; revision: number }>(
      "SELECT id,revision FROM resources WHERE kind='session' AND org_id=? AND space_id=? AND lifecycle='deleting' ORDER BY id",
      org.id, ctx.spaceId,
    );
    for (const row of rows) {
      if (await projectionIfPresent(row.id)) continue;
      const current = resource(row.id);
      if (current?.lifecycle === "deleting") {
        transition(
          row.id,
          ["deleting"],
          "deleted",
          current.revision,
          "resource.delete-reconciled",
          false,
          "system:resource-reconciler",
        );
      }
    }
  };

  const requireActive = async (id: string): Promise<SessionProjection> => {
    const projection = await readProjection(id);
    const row = reconcileReadable(projection);
    if (row.lifecycle !== "active" || projection.status === "archived") throw archived();
    return projection;
  };

  const create: SessionService["create"] = async (input): Promise<SessionRef> => {
    requireMutation();
    const project = await projects.get(input.projectId);
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    // Isolation allocates the session id before creating its managed worktree.
    // Preserve that internal identity so the resource row, projection, marker,
    // and branch all describe the same canonical session.
    const sessionId = input.id?.trim() || randomUUID();
    const operationId = randomUUID();
    // A delegated subagent follows its parent chat's sharing; any other new
    // chat starts with the Space's default audience (Spaces §14.3).
    security.resources.begin({
      operationId,
      resourceId: sessionId,
      kind: "session",
      orgId: org.id,
      spaceId: ctx.spaceId,
      parentId: project.id,
      ...(input.parentId ? { accessParentId: input.parentId } : {}),
      ownerPrincipalId: ctx.userId,
      createdBy: ctx.userId,
      visibility: input.parentId ? "inherit" : defaultSessionVisibility(ctx),
    });
    try {
      const result = await base.create({ ...input, id: sessionId });
      const projection = await base.snapshot(result.id);
      if (result.id !== sessionId) throw recovery();
      security.resources.recordDomainReady(operationId, receipt(projection));
      const current = resource(sessionId);
      if (!current) throw recovery();
      security.resources.activate(operationId, current.revision);
      return result;
    } catch (cause) {
      const projection = await projectionIfPresent(sessionId).catch(() => undefined);
      if (projection) {
        try {
          security.resources.recordDomainReady(operationId, receipt(projection));
          const current = resource(sessionId);
          if (current && (current.lifecycle === "provisioning" || current.lifecycle === "quarantined")) {
            security.resources.activate(operationId, current.revision);
          }
        } catch { /* fail closed on original error; next read enters recovery */ }
      } else {
        const current = resource(sessionId);
        if (current && (current.lifecycle === "provisioning" || current.lifecycle === "quarantined")) {
          try { security.resources.abortMissingDomain(operationId, current.revision); } catch { /* preserve original */ }
        }
      }
      throw cause;
    }
  };

  const conversationBase = base as SessionService & {
    createConversation?(
      input: CreateConversationInput,
      admission?: TurnAdmission,
      options?: { id?: string; deferOpeningMessage?: boolean },
    ): Promise<SessionRef>;
    startSessionFromConversation?(
      conversationId: string,
      input: StartSessionFromConversationInput,
      admission?: TurnAdmission,
      options?: { id?: string },
    ): Promise<StartSessionFromConversationResult>;
    conversationForClientOperation?(clientOperationId: string): Promise<string | undefined>;
    conversationSessionStart?(
      conversationId: string,
      clientOperationId: string,
    ): Promise<StartSessionFromConversationResult | undefined>;
  };

  /** A conversation is a canonical resource too, but its creation never
   *  acquires a runtime. The resource row is opened before the durable domain
   *  create so a crash leaves a reconcilable provisioning row, and sharing is
   *  applied only after activation (the sharing authority refuses provisioning
   *  rows). The opening message is posted last so mention resolution sees the
   *  participant grants. */
  const createConversation: NonNullable<SessionService["createConversation"]> = async (input, admission) => {
    requireMutation();
    const project = await projects.get(input.projectId);
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    const clientOperationId = typeof input.clientOperationId === "string" && input.clientOperationId.trim()
      ? input.clientOperationId.trim()
      : undefined;
    if (clientOperationId) {
      const prior = await conversationBase.conversationForClientOperation?.(clientOperationId);
      if (prior) return { id: prior };
    }
    const sessionId = randomUUID();
    const operationId = randomUUID();
    security.resources.begin({
      operationId,
      resourceId: sessionId,
      kind: "session",
      orgId: org.id,
      spaceId: ctx.spaceId,
      parentId: project.id,
      ownerPrincipalId: ctx.userId,
      createdBy: ctx.userId,
      visibility: "restricted",
    });
    let activated = false;
    try {
      const result = await conversationBase.createConversation!(input, admission, { id: sessionId, deferOpeningMessage: true });
      if (result.id !== sessionId) {
        const raced = resource(sessionId);
        if (raced && (raced.lifecycle === "provisioning" || raced.lifecycle === "quarantined")) {
          try { security.resources.abortMissingDomain(operationId, raced.revision); } catch { /* prior row wins */ }
        }
        return result;
      }
      const projection = await base.snapshot(sessionId);
      security.resources.recordDomainReady(operationId, receipt(projection));
      const current = resource(sessionId);
      if (!current) throw recovery();
      security.resources.activate(operationId, current.revision);
      activated = true;
      // The creator was dropped by the domain method; validate again here so
      // one person is never both owner and grantee.
      const participants: string[] = [];
      const seen = new Set<string>([ctx.userId]);
      for (const raw of Array.isArray(input.participants) ? input.participants : []) {
        if (typeof raw !== "string" || !raw || seen.has(raw)) continue;
        seen.add(raw);
        participants.push(raw);
      }
      security.sharing.share({
        resourceId: sessionId,
        orgId: org.id,
        spaceId: ctx.spaceId,
        actor: ctx.userId,
        visibility: "restricted",
        grants: participants.map((principalId) => ({ principalId, access: "collaborate" as const })),
      });
      await base.postPersonMessage!(sessionId, {
        text: input.text,
        mentions: participants,
        ...(clientOperationId ? { clientOperationId } : {}),
      }, admission);
      return { id: sessionId };
    } catch (cause) {
      if (!activated) {
        const projection = await projectionIfPresent(sessionId).catch(() => undefined);
        const current = resource(sessionId);
        if (projection && current && (current.lifecycle === "provisioning" || current.lifecycle === "quarantined")) {
          try {
            security.resources.recordDomainReady(operationId, receipt(projection));
            const latest = resource(sessionId);
            if (latest && (latest.lifecycle === "provisioning" || latest.lifecycle === "quarantined")) {
              security.resources.activate(operationId, latest.revision);
            }
          } catch { /* fail closed on the original error */ }
        } else if (current && (current.lifecycle === "provisioning" || current.lifecycle === "quarantined")) {
          try { security.resources.abortMissingDomain(operationId, current.revision); } catch { /* preserve original */ }
        }
      }
      throw cause;
    }
  };

  const startSessionFromConversation: NonNullable<SessionService["startSessionFromConversation"]> = async (
    conversationId,
    input,
    admission,
  ) => {
    requireMutation();
    const conversation = await requireActive(conversationId);
    if (conversation.purpose !== "conversation") {
      throw Object.assign(new Error("this session is not a conversation"), { code: "invalid-input" });
    }
    const clientOperationId = typeof input.clientOperationId === "string" && input.clientOperationId.trim()
      ? input.clientOperationId.trim()
      : undefined;
    if (clientOperationId) {
      const prior = await conversationBase.conversationSessionStart?.(conversationId, clientOperationId);
      if (prior) return prior;
    }
    const sessionId = randomUUID();
    const operationId = randomUUID();
    const grantById = new Map<string, "view" | "collaborate" | "manage">();
    for (const participant of Array.isArray(input.participants) ? input.participants : []) {
      if (!participant || typeof participant.userId !== "string" || participant.userId === ctx.userId) continue;
      if (participant.access !== "view" && participant.access !== "collaborate" && participant.access !== "manage") continue;
      if (!grantById.has(participant.userId)) grantById.set(participant.userId, participant.access);
    }
    const grants = [...grantById].map(([userId, access]) => ({ userId, access }));
    security.resources.begin({
      operationId,
      resourceId: sessionId,
      kind: "session",
      orgId: org.id,
      spaceId: ctx.spaceId,
      parentId: conversation.projectId,
      ownerPrincipalId: ctx.userId,
      createdBy: ctx.userId,
      visibility: grants.length > 0 ? "restricted" : "private",
    });
    let activated = false;
    try {
      const result = await conversationBase.startSessionFromConversation!(conversationId, input, admission, { id: sessionId });
      if (result.sessionId !== sessionId) {
        const raced = resource(sessionId);
        if (raced && (raced.lifecycle === "provisioning" || raced.lifecycle === "quarantined")) {
          try { security.resources.abortMissingDomain(operationId, raced.revision); } catch { /* prior row wins */ }
        }
        return result;
      }
      const projection = await base.snapshot(sessionId);
      security.resources.recordDomainReady(operationId, receipt(projection));
      const current = resource(sessionId);
      if (!current) throw recovery();
      security.resources.activate(operationId, current.revision);
      activated = true;
      security.sharing.share({
        resourceId: sessionId,
        orgId: org.id,
        spaceId: ctx.spaceId,
        actor: ctx.userId,
        visibility: grants.length > 0 ? "restricted" : "private",
        grants: grants.map((participant) => ({ principalId: participant.userId, access: participant.access })),
      });
      return result;
    } catch (cause) {
      if (!activated) {
        const projection = await projectionIfPresent(sessionId).catch(() => undefined);
        const current = resource(sessionId);
        if (projection && current && (current.lifecycle === "provisioning" || current.lifecycle === "quarantined")) {
          try {
            security.resources.recordDomainReady(operationId, receipt(projection));
            const latest = resource(sessionId);
            if (latest && (latest.lifecycle === "provisioning" || latest.lifecycle === "quarantined")) {
              security.resources.activate(operationId, latest.revision);
            }
          } catch { /* fail closed on the original error */ }
        } else if (current && (current.lifecycle === "provisioning" || current.lifecycle === "quarantined")) {
          try { security.resources.abortMissingDomain(operationId, current.revision); } catch { /* preserve original */ }
        }
      }
      throw cause;
    }
  };

  const fork: SessionService["fork"] = async (sessionId, atSeq): Promise<ForkResult> => {
    requireMutation();
    await requireActive(sessionId);
    const result = await base.fork(sessionId, atSeq);
    const child = await base.snapshot(result.id);
    // A fork is a new chat owned by whoever forked it.
    adoptCreated(child, ctx.userId, { visibility: defaultSessionVisibility(ctx) });
    return result;
  };

  const archive: SessionService["archive"] = async (sessionId): Promise<void> => {
    requireMutation();
    // Like the base archive this is idempotent: a subtree archive revisits
    // members that were archived earlier and must not fail on them.
    if ((await readProjection(sessionId)).status === "archived" && resource(sessionId)?.lifecycle === "archived") return;
    const projection = await requireActive(sessionId);
    let row = reconcileReadable(projection);
    row = transition(sessionId, ["active"], "archiving", row.revision, "resource.archiving", true);
    try {
      await base.archive(sessionId);
    } catch (cause) {
      const current = resource(sessionId) ?? row;
      if (current.lifecycle === "archiving") {
        try { transition(sessionId, ["archiving"], "active", current.revision, "resource.archive-rolled-back", true); } catch { /* fail closed */ }
      }
      throw cause;
    }
    const current = resource(sessionId);
    if (!current) throw recovery();
    transition(sessionId, ["archiving"], "archived", current.revision, "resource.archived", true);
  };

  const restore: SessionService["restore"] = async (sessionId): Promise<void> => {
    requireMutation();
    const before = await readProjection(sessionId);
    const row = reconcileReadable(before);
    if (row.lifecycle !== "archived" || before.status !== "archived") throw recovery();
    await base.restore(sessionId);
    const current = resource(sessionId);
    if (!current) throw recovery();
    transition(sessionId, ["archived"], "active", current.revision, "resource.restored", true);
  };

  const remove: NonNullable<SessionService["delete"]> | undefined = base.delete
    ? async (sessionId): Promise<void> => {
        requireMutation();
        const projection = await projectionIfPresent(sessionId);
        let row = resource(sessionId);
        if (!projection) {
          if (!row) throw Object.assign(new Error("session not found"), { code: "not-found" });
          assertScope(row);
          if (row.lifecycle === "deleted") return;
          if (row.lifecycle !== "deleting") throw recovery();
          transition(
            sessionId,
            ["deleting"],
            "deleted",
            row.revision,
            "resource.delete-reconciled",
            false,
            "system:resource-reconciler",
          );
          return;
        }
        await adoptDerivedImportedChild(projection);
        row = reconcileReadable(projection);
        const alreadyDeleting = row.lifecycle === "deleting";
        if (!alreadyDeleting && row.lifecycle !== "active" && row.lifecycle !== "archived") throw recovery();
        if (!alreadyDeleting) {
          row = transition(sessionId, [row.lifecycle], "deleting", row.revision, "resource.deleting", true);
        }
        try {
          await base.delete!(sessionId);
        } catch (cause) {
          // A concurrent retry may already have finalized the resource, which
          // is idempotent success.
          if (resource(sessionId)?.lifecycle === "deleted") return;
          // `base.delete` commits by purging the projection together with its
          // canonical deletion tombstone. If that projection survived, no
          // domain state was removed — for example an isolation-ownership
          // refusal runs before the purge. Releasing the fence here lets the
          // still-intact session become readable again; keeping it would hide
          // the session until the next boot reconciliation and block the user
          // from resolving whatever refused the delete.
          const survived = await projectionIfPresent(sessionId);
          const current = resource(sessionId);
          if (survived && current?.lifecycle === "deleting") {
            try {
              transition(
                sessionId,
                ["deleting"],
                survived.status === "archived" ? "archived" : "active",
                current.revision,
                "resource.delete-rolled-back",
                true,
                "system:resource-reconciler",
              );
            } catch {
              // Preserve the fence; boot reconciliation retries from current state.
            }
          }
          throw cause;
        }
        const current = resource(sessionId);
        if (!current) throw recovery();
        if (current.lifecycle === "deleted") return;
        if (current.lifecycle !== "deleting") throw recovery();
        transition(sessionId, ["deleting"], "deleted", current.revision, "resource.deleted", false);
      }
    : undefined;

  const activeMethodNames = new Set<PropertyKey>([
    "send", "abort", "pause", "continuePaused", "replyPermission", "delegatePermission", "replyDelegatedPermission", "replyQuestion", "cancelResume", "setResumeCompact", "resumeNow",
    "rewind", "clearRewind", "runShell", "compact", "replySecret", "rename", "requestAutomaticTitle", "organize",
    "queueList", "queueEditStart", "queueEdit", "queueSendNow", "queueEditCancel", "queueReorder", "queueRemove",
    "pinContext", "unpinContext", "autoAcceptGet", "autoAcceptSet", "confirmBorrowedRuntimeEpoch",
    "saveDraft", "markRead", "postPersonMessage", "setPersonMute", "runtimeFeatures", "renameWorktreeBranch", "patchIsolation", "rebindWorkspace",
    "switchHarness", "cancelHarnessSwitch", "restartRuntime", "updateWorkspace", "patchWorkspace", "withWorkspaceMutation",
  ]);
  const readableMethodNames = new Set<PropertyKey>(["debug", "clientMutationStatus", "mentionCandidates"]);

  const reconciledList = async (projectId?: string): Promise<SessionProjection[]> => {
    await reconcileMissingDeletes();
    const visible: SessionProjection[] = [];
    for (const projection of await base.list(projectId)) {
      const admitted = await admitProjection(projection);
      if (admitted) visible.push(admitted);
    }
    return visible;
  };

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "create") return create;
      if (property === "createConversation") return createConversation;
      if (property === "startSessionFromConversation") return startSessionFromConversation;
      if (property === "fork") return fork;
      if (property === "archive") return archive;
      if (property === "restore") return restore;
      if (property === "delete") return remove;
      if (property === "snapshot") return readProjection;
      if (property === "events") {
        return async (sessionId: string, ...rest: unknown[]) => {
          await readProjection(sessionId);
          return (target.events as (...args: unknown[]) => unknown).call(target, sessionId, ...rest);
        };
      }
      if (property === "list") return reconciledList;
      if (property === "sync") {
        return async (projectId: string) => {
          await reconcileMissingDeletes();
          const visible: SessionProjection[] = [];
          for (const projection of await target.sync(projectId)) {
            const admitted = await admitProjection(projection);
            if (admitted) visible.push(admitted);
          }
          return visible;
        };
      }
      if (property === "importBackendSessions" && target.importBackendSessions) {
        return async (projectId: string, backendIds: string[]) => {
          requireMutation();
          const rows = await target.importBackendSessions!(projectId, backendIds);
          for (const projection of rows) adoptCreated(projection, ctx.userId, { visibility: defaultSessionVisibility(ctx) });
          return rows;
        };
      }
      if (activeMethodNames.has(property)) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          requireMutation();
          // Isolation cleanup may move an archived descendant that never ran
          // out of the checkout it is releasing, or drop an archived session's
          // record of a checkout that is gone; the core decides whether that
          // session qualifies. Every other method stays active-only.
          if ((property === "rebindWorkspace"
            && (rest[0] as { relocateManagedCheckout?: unknown } | undefined)?.relocateManagedCheckout === true)
            || (property === "patchIsolation" && rest[0] === null)) {
            const projection = await readProjection(sessionId);
            const row = reconcileReadable(projection);
            if (row.lifecycle !== "active" && row.lifecycle !== "archived") throw archived();
            return value.call(target, sessionId, ...rest);
          }
          await requireActive(sessionId);
          return value.call(target, sessionId, ...rest);
        };
      }
      if (readableMethodNames.has(property)) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (sessionId: string, ...rest: unknown[]) => {
          await readProjection(sessionId);
          return value.call(target, sessionId, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SessionService;
}
