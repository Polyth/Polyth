// SessionService: canonical session orchestration.
// Runtime events -> appended to durable session log FIRST -> then broadcast/projections.
import { randomUUID } from "node:crypto";
import type {
  AgentProfile, AgentRuntime, CreateSessionInput, DeliveryMode, JsonObject, QueueItemDto, RuntimeEvent,
  SendResult, SessionEvent, SessionFolderDto, SessionOrganizePatch, SessionProjection, SessionRef,
  SessionService, SessionPersistence, UserTurnInput,
} from "@polyth/contracts";
import type { ProjectService } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { buildPermissionPreview, PERMISSION_ALLOWED_SCOPES } from "./permissionPreview.ts";

export interface Broadcaster {
  event(ev: SessionEvent): void;
  projection(p: SessionProjection): void;
}

/** Durable FIFO delivery queue (implemented by @polyth/session's Store). */
export interface QueueStore {
  enqueue(sessionId: string, text: string, delivery: DeliveryMode): Promise<QueueItemDto>;
  queueList(sessionId: string): Promise<QueueItemDto[]>;
  queueReorder(sessionId: string, ids: string[]): Promise<QueueItemDto[]>;
  queueRemove(sessionId: string, queueId: string): Promise<boolean>;
  queueShift(sessionId: string): Promise<QueueItemDto | undefined>;
}

export interface RuntimePool {
  /** `cwd` overrides the project root — that is how worktree sessions are isolated. */
  forProject(projectId: string, cwd?: string): Promise<AgentRuntime>;
}

/** Organization seams implemented by @polyth/session's Store (WP5). */
export interface OrgStore {
  folderList(projectId: string): Promise<SessionFolderDto[]>;
  attentionFor(sessionIds: string[]): Promise<Record<string, { questions: number; permissions: number }>>;
}

/** Workflow hooks (goals today, multirun/review later) — plugins observe turns
 *  through this seam instead of reaching into the backend loop. */
export interface TurnHooks {
  onTurnCompleted?(sessionId: string, assistantText: string): void;
  onUsage?(sessionId: string, tokens: { input: number; output: number; reasoning?: number }): void;
}

/** Slash-command / snippet expansion seam. The commands plugin owns the syntax;
 *  the session service only knows "text may be rewritten before the model sees it". */
export type ExpandInput = (
  projectId: string,
  text: string,
) => Promise<{ text: string; raw: string; agent?: string; model?: { providerID: string; modelID: string } }>;

export function createSessionService(deps: {
  store: SessionPersistence;
  projects: ProjectService;
  permissions: PermissionService;
  runtimes: RuntimePool;
  broadcast: Broadcaster;
  hooks?: TurnHooks;
  expand?: ExpandInput;
  queue?: QueueStore;
  org?: OrgStore;
  /** Agent-profile lookup (WP8) — profiles resolve to explicit model/agent at send time. */
  profiles?: { profileGet(id: string): Promise<AgentProfile | undefined> };
  /** Global behavior instructions (WP9): revision+digest logged before a turn
   *  starts under a newly applied revision, keeping replay reproducible. */
  behavior?: { current(): Promise<{ revision: string; digest: string } | null> };
}): SessionService {
  const { store, projects, permissions, runtimes, broadcast } = deps;
  const hooks = deps.hooks ?? {};
  const sessionRuntime = new Map<string, AgentRuntime>(); // sessionId -> runtime
  const lastTurnId = new Map<string, string>();           // sessionId -> active turnId
  // sessions whose turn admission is in flight (startTurn sent, turn/started
  // not yet observed) — a concurrent send must treat these as active
  const admitting = new Set<string>();
  const behaviorLogged = new Map<string, string>(); // sessionId -> behavior revision already in the log
  // sessionId -> parts of the current turn's assistant reply, keyed by partId in
  // arrival order. Models may finalize parts out of order (a reasoning-as-text
  // part can land after the answer), so workflows get the whole turn, not "the
  // last part that happened to close".
  const turnReply = new Map<string, Map<string, string>>();
  const replyText = (sessionId: string): string =>
    [...(turnReply.get(sessionId)?.values() ?? [])].filter((t) => t.trim()).join("\n\n");

  const appendAndBroadcast = async (
    sessionId: string, type: string, data: JsonObject,
    opts?: Parameters<SessionPersistence["append"]>[3],
  ): Promise<SessionEvent> => {
    const ev = await store.append(sessionId, type, data, opts);
    broadcast.event(ev);
    return ev;
  };

  const updateProjection = async (sessionId: string, patch: Partial<SessionProjection>) => {
    const current = await store.projection(sessionId);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await store.upsertProjection(next);
    broadcast.projection(next);
  };

  const onRuntimeEvent = async (sessionId: string, ev: RuntimeEvent) => {
    // invariant: model-visible content hits the log before any UI sees it
    switch (ev.type) {
      case "turn/started":
        lastTurnId.set(sessionId, ev.turnId);
        admitting.delete(sessionId);
        turnReply.set(sessionId, new Map());
        await appendAndBroadcast(sessionId, "turn/started", { turnId: ev.turnId }, { ignorable: true });
        await updateProjection(sessionId, { status: "working", lastTurnAt: Date.now() });
        break;
      case "turn/stopped":
        await appendAndBroadcast(sessionId, "turn/stopped", {
          turnId: lastTurnId.get(sessionId) ?? ev.type, reason: ev.reason, ...(ev.error ? { error: ev.error } : {}),
        }, { ignorable: true });
        lastTurnId.delete(sessionId);
        admitting.delete(sessionId);
        await updateProjection(sessionId, { status: ev.reason === "error" ? "failed" : "idle" });
        if (ev.reason === "completed") hooks.onTurnCompleted?.(sessionId, replyText(sessionId));
        // FIFO dispatch of queued follow-ups; never into an error state (a
        // failing session would silently burn the whole queue otherwise).
        if (ev.reason !== "error") void dispatchQueue(sessionId);
        break;
      case "permission/requested": {
        const { type: _t, ...reqData } = ev;
        // Redacted preview + explicit scopes are generated BEFORE the request
        // event is appended (WP15) so the log never sees raw metadata values.
        const enriched: JsonObject = {
          ...(reqData as unknown as JsonObject),
          preview: buildPermissionPreview({
            permission: ev.permission, patterns: ev.patterns,
            ...(ev.metadata ? { metadata: ev.metadata } : {}),
            ...(ev.tool ? { tool: ev.tool } : {}),
          }) as unknown as JsonObject,
          allowedScopes: [...PERMISSION_ALLOWED_SCOPES],
        };
        await appendAndBroadcast(sessionId, "permission/requested", enriched, { ignorable: true });
        const proj = await store.projection(sessionId);
        const verdict = permissions.evaluate(ev.permission, ev.patterns, proj?.projectId, sessionId);
        if (verdict === "allow" || verdict === "deny") {
          const reply = verdict === "allow" ? "once" : "reject";
          await appendAndBroadcast(sessionId, "permission/resolved", { requestId: ev.requestId, reply }, { ignorable: true });
          await sessionRuntime.get(sessionId)?.replyPermission(sessionId, ev.requestId, reply);
        } else {
          await updateProjection(sessionId, { status: "waiting" });
        }
        break;
      }
      case "question/asked": {
        const { type: _t, ...qData } = ev;
        await appendAndBroadcast(sessionId, "question/asked", qData as unknown as JsonObject, { ignorable: true });
        await updateProjection(sessionId, { status: "waiting" });
        break;
      }
      case "usage/recorded": {
        const { type: _t, ...uData } = ev;
        await appendAndBroadcast(sessionId, "usage/recorded", uData as unknown as JsonObject, { ignorable: true });
        const proj = await store.projection(sessionId);
        const t = proj?.tokenTotals;
        await updateProjection(sessionId, {
          tokenTotals: {
            input: (t?.input ?? 0) + ev.tokens.input,
            output: (t?.output ?? 0) + ev.tokens.output,
            ...(ev.tokens.reasoning ? { reasoning: (t?.reasoning ?? 0) + ev.tokens.reasoning } : {}),
          },
          costTotal: (proj?.costTotal ?? 0) + (ev.cost ?? 0),
        });
        hooks.onUsage?.(sessionId, ev.tokens);
        break;
      }
      default: {
        // model-visible payloads pass through verbatim (minus the envelope `type`)
        const { type: _t, ...rest } = ev;
        if (ev.type === "assistant/message" && ev.text.trim()) {
          let parts = turnReply.get(sessionId);
          if (!parts) turnReply.set(sessionId, (parts = new Map()));
          parts.set(ev.partId, ev.text);
        }
        await appendAndBroadcast(sessionId, ev.type, rest as unknown as JsonObject);
      }
    }
  };

  const wire = (sessionId: string, rt: AgentRuntime) => {
    if (sessionRuntime.has(sessionId)) return;
    sessionRuntime.set(sessionId, rt);
    rt.onEvent((sid, ev) => { if (sid === sessionId) void onRuntimeEvent(sid, ev); });
  };

  const ensureWired = async (sessionId: string, proj: SessionProjection): Promise<AgentRuntime> => {
    let rt = sessionRuntime.get(sessionId);
    if (!rt) {
      // server restarted: recreate the backend session; canonical log remains UI truth.
      // ponytail: model-side history is not replayed into the backend here (M2: summary injection).
      const project = await projects.get(proj.projectId);
      const cwd = proj.worktreePath ?? project?.path ?? process.cwd();
      rt = await runtimes.forProject(proj.projectId, cwd);
      await rt.ensureSession({
        projectId: proj.projectId, title: proj.title, sessionId, cwd,
        ...(proj.backendSessionId ? { backendSessionId: proj.backendSessionId } : {}),
        ...(proj.model ? { model: proj.model } : {}), ...(proj.agent ? { agent: proj.agent } : {}),
      });
      wire(sessionId, rt);
    }
    return rt;
  };

  const turnActive = (sessionId: string): boolean =>
    lastTurnId.has(sessionId) || admitting.has(sessionId);

  /** Atomic send-time arbitration: reject open questions and deny open
   *  permissions of this exact session before the new message is admitted.
   *  Resolution events precede the queue/user events in the durable log. */
  const dismissPendingRequests = async (sessionId: string, rt: AgentRuntime): Promise<void> => {
    const evs = await store.events(sessionId);
    const resolvedPerms = new Set<string>();
    const answeredQs = new Set<string>();
    for (const e of evs) {
      const rid = (e.data as { requestId?: string }).requestId;
      if (!rid) continue;
      if (e.type === "permission/resolved") resolvedPerms.add(rid);
      if (e.type === "question/answered") answeredQs.add(rid);
    }
    for (const e of evs) {
      const rid = (e.data as { requestId?: string }).requestId;
      if (!rid) continue;
      if (e.type === "permission/requested" && !resolvedPerms.has(rid)) {
        resolvedPerms.add(rid);
        await appendAndBroadcast(sessionId, "permission/resolved", { requestId: rid, reply: "reject" }, { ignorable: true });
        await rt.replyPermission(sessionId, rid, "reject").catch(() => {});
      }
      if (e.type === "question/asked" && !answeredQs.has(rid)) {
        answeredQs.add(rid);
        await appendAndBroadcast(sessionId, "question/answered", { requestId: rid, rejected: true }, { ignorable: true });
        await rt.replyQuestion(sessionId, rid, { action: "reject" }).catch(() => {});
      }
    }
  };

  const enqueueMessage = async (
    sessionId: string, text: string, delivery: DeliveryMode, fallbackReason?: string,
  ): Promise<SendResult> => {
    if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
    const item = await deps.queue.enqueue(sessionId, text, delivery);
    if (fallbackReason) {
      await appendAndBroadcast(sessionId, "delivery/fallback-queued", { queueId: item.id, reason: fallbackReason }, { ignorable: true });
    }
    await appendAndBroadcast(sessionId, "queue/enqueued", { queueId: item.id, text, delivery }, { ignorable: true });
    return { queueId: item.id, queued: true };
  };

  /** Dispatch the next queued message iff the session is idle. Never enters an
   *  active stream: re-checked after every await. */
  const dispatchQueue = async (sessionId: string): Promise<void> => {
    if (!deps.queue) return;
    if (turnActive(sessionId)) return;
    const proj = await store.projection(sessionId);
    if (!proj || proj.status === "archived") return;
    if (turnActive(sessionId)) return;
    const item = await deps.queue.queueShift(sessionId);
    if (!item) return;
    if (turnActive(sessionId)) {
      // a send raced us between shift and dispatch: put the item back at the front
      const restored = await deps.queue.enqueue(sessionId, item.text, item.delivery);
      const rest = await deps.queue.queueList(sessionId);
      const ids = [restored.id, ...rest.filter((i) => i.id !== restored.id).map((i) => i.id)];
      if (ids.length > 1) await deps.queue.queueReorder(sessionId, ids);
      return;
    }
    await appendAndBroadcast(sessionId, "queue/dispatched", { queueId: item.id }, { ignorable: true });
    try {
      // direct admission: dispatch bypasses the FIFO-preservation branch in
      // send() (which would re-enqueue behind the remaining items forever)
      const proj2 = await store.projection(sessionId);
      if (!proj2) return;
      const rt = await ensureWired(sessionId, proj2);
      await admitTurn(sessionId, proj2, rt, { text: item.text });
    } catch (err) {
      console.error(`[polyth] queued dispatch failed for ${sessionId}`, err);
    }
  };

  /** Expansion + user/message append + startTurn. Callers already decided
   *  admission; this is the single place a text enters the model stream. */
  const admitTurn = async (
    sessionId: string, proj: SessionProjection, rt: AgentRuntime, input: UserTurnInput,
  ): Promise<SendResult> => {
    // /command and #snippet expansion happens before anything is logged, so the
    // durable log holds exactly what the model saw (plus `raw` for the UI).
    let text = input.text;
    let raw = input.text;
    let cmdAgent: string | undefined;
    let cmdModel: { providerID: string; modelID: string } | undefined;
    if (deps.expand) {
      try {
        const r = await deps.expand(proj.projectId, input.text);
        text = r.text; raw = r.raw; cmdAgent = r.agent; cmdModel = r.model;
      } catch (err) {
        console.error("[polyth] command expansion failed", err);
      }
    }
    if (input.model || input.agent) {
      await updateProjection(sessionId, {
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      });
    }
    admitting.add(sessionId);
    try {
      const model = input.model ?? cmdModel ?? proj.model;
      const agent = input.agent ?? cmdAgent ?? proj.agent;
      // Model-visible behavior instructions are logged BEFORE the turn that
      // first runs under a new revision (worst case after restart: one benign
      // re-append, which replay tooling dedupes by revision).
      if (deps.behavior) {
        const cur = await deps.behavior.current().catch(() => null);
        if (cur && behaviorLogged.get(sessionId) !== cur.revision) {
          await appendAndBroadcast(sessionId, "behavior/instructions-applied", {
            revision: cur.revision, digest: cur.digest, scope: "global",
          }, { ignorable: true });
          behaviorLogged.set(sessionId, cur.revision);
        }
      }
      // Resolved turn configuration lands in the durable log (not just the
      // mutable profile id), so replay is stable across profile edits.
      await appendAndBroadcast(sessionId, "user/message", {
        text, ...(raw !== text ? { raw } : {}),
        ...(input.attachments ? { attachments: input.attachments as unknown as JsonObject[] } : {}),
        ...(input.agentProfileId ? {
          agentProfileId: input.agentProfileId,
          ...(model ? { resolvedModel: model as unknown as JsonObject } : {}),
          ...(agent ? { resolvedAgent: agent } : {}),
        } : {}),
      });
      await rt.startTurn({
        sessionId, text,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
      });
    } catch (err) {
      admitting.delete(sessionId);
      await appendAndBroadcast(sessionId, "turn/failed", { error: String(err) }, { ignorable: true });
      await updateProjection(sessionId, { status: "failed" });
      throw err;
    }
    return { turnId: randomUUID() };
  };

  const service: SessionService = {
    async create(input: CreateSessionInput): Promise<SessionRef> {
      const project = await projects.get(input.projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      const sessionId = randomUUID();
      const cwd = input.worktreePath ?? project.path;
      const rt = await runtimes.forProject(project.id, cwd);
      const backendSessionId = await rt.ensureSession({ ...input, sessionId, cwd });
      wire(sessionId, rt);
      const now = Date.now();
      const projection: SessionProjection = {
        id: sessionId, projectId: project.id,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        title: input.title || "New session", status: "idle",
        ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        backendSessionId,
        createdAt: now, updatedAt: now,
      };
      await store.upsertProjection(projection);
      await appendAndBroadcast(sessionId, "session/created", {
        title: projection.title, projectId: project.id,
        ...(input.model ? { model: input.model as unknown as JsonObject } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      }, { ignorable: true });
      broadcast.projection(projection);
      return { id: sessionId };
    },

    async send(sessionId, input: UserTurnInput): Promise<SendResult> {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const rt = await ensureWired(sessionId, proj);

      // Atomic profile application: resolve to explicit model/agent up front so
      // no intermediate invalid combination can reach the runtime. Explicit
      // per-send model/agent still win over the profile's bundle.
      if (input.agentProfileId && deps.profiles) {
        const profile = await deps.profiles.profileGet(input.agentProfileId);
        if (!profile) throw Object.assign(new Error("agent profile not found"), { code: "not-found" });
        input = {
          ...input,
          model: input.model ?? { providerID: profile.providerID, modelID: profile.modelID },
          ...(input.agent ?? profile.agent ? { agent: input.agent ?? profile.agent } : {}),
        };
      }
      // Send-time arbitration first: resolution events precede queue/user events.
      if (input.dismissPending) await dismissPendingRequests(sessionId, rt);

      const delivery: DeliveryMode = input.delivery ?? "normal";
      const active = turnActive(sessionId);

      if (active && deps.queue) {
        if (delivery === "queue") return enqueueMessage(sessionId, input.text, "queue");
        if (delivery === "normal") {
          // idle race: the turn started between the client's check and admission
          return enqueueMessage(sessionId, input.text, "queue", "turn-active");
        }
        if (delivery === "steer") {
          const caps = await rt.capabilities().catch(() => null);
          if (!caps?.steering || !rt.steer) {
            return enqueueMessage(sessionId, input.text, "steer", "steer-unsupported");
          }
          // Deliver first, then log: a failed steer must fall back to queue
          // without leaving a dangling user/message the model never saw.
          const ok = await rt.steer(sessionId, input.text).catch(() => false);
          if (!ok) return enqueueMessage(sessionId, input.text, "steer", "steer-rejected");
          await appendAndBroadcast(sessionId, "delivery/steered", { text: input.text }, { ignorable: true });
          await appendAndBroadcast(sessionId, "user/message", { text: input.text });
          return { turnId: lastTurnId.get(sessionId) ?? randomUUID() };
        }
        if (delivery === "interrupt") {
          // enqueue at the head, then abort; turn/stopped(aborted) dispatches it
          const item = await deps.queue.enqueue(sessionId, input.text, "interrupt");
          const rest = await deps.queue.queueList(sessionId);
          const ids = [item.id, ...rest.filter((i) => i.id !== item.id).map((i) => i.id)];
          if (ids.length > 1) await deps.queue.queueReorder(sessionId, ids);
          await appendAndBroadcast(sessionId, "queue/enqueued", { queueId: item.id, text: input.text, delivery }, { ignorable: true });
          await rt.abort(sessionId).catch(() => {});
          return { queueId: item.id, queued: true };
        }
      }

      // Idle with older queued items: preserve FIFO — this message joins the
      // queue and the head dispatches now.
      if (!active && deps.queue && delivery !== "interrupt") {
        const pendingQueue = await deps.queue.queueList(sessionId);
        if (pendingQueue.length > 0) {
          const res = await enqueueMessage(sessionId, input.text, delivery === "steer" ? "steer" : "queue");
          void dispatchQueue(sessionId);
          return res;
        }
      }

      return admitTurn(sessionId, proj, rt, input);
    },

    async queueList(sessionId) {
      if (!deps.queue) return [];
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      return deps.queue.queueList(sessionId);
    },
    async queueReorder(sessionId, ids) {
      if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const items = await deps.queue.queueReorder(sessionId, ids);
      await appendAndBroadcast(sessionId, "queue/reordered", { ids }, { ignorable: true });
      return items;
    },
    async queueRemove(sessionId, queueId) {
      if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const removed = await deps.queue.queueRemove(sessionId, queueId);
      if (!removed) throw Object.assign(new Error("queue item not found"), { code: "not-found" });
      await appendAndBroadcast(sessionId, "queue/removed", { queueId }, { ignorable: true });
    },

    async abort(sessionId) { await sessionRuntime.get(sessionId)?.abort(sessionId); },

    async fork(sessionId, atSeq): Promise<SessionRef> {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const forkId = randomUUID();
      const project = await projects.get(proj.projectId);
      const forkCwd = proj.worktreePath ?? project?.path ?? process.cwd();
      const rt = await runtimes.forProject(proj.projectId, forkCwd);
      const backendSessionId = await rt.ensureSession({ projectId: proj.projectId, title: `${proj.title} (fork)`, sessionId: forkId, cwd: forkCwd });
      wire(forkId, rt);
      await store.copyTo(sessionId, forkId, atSeq);
      const now = Date.now();
      const projection: SessionProjection = {
        ...proj, id: forkId, parentId: sessionId,
        title: `${proj.title} (fork)`, status: "idle", createdAt: now, updatedAt: now,
        backendSessionId,
      };
      await store.upsertProjection(projection);
      await appendAndBroadcast(forkId, "session/forked", { fromSessionId: sessionId, ...(atSeq ? { atSeq } : {}) }, { ignorable: true });
      broadcast.projection(projection);
      return { id: forkId };
    },

    async archive(sessionId) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (proj.status === "archived") return; // idempotent: no duplicate events
      await appendAndBroadcast(sessionId, "session/archived", {}, { ignorable: true });
      await updateProjection(sessionId, { status: "archived" });
    },
    async restore(sessionId) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (proj.status !== "archived") return; // idempotent
      await appendAndBroadcast(sessionId, "session/restored", {}, { ignorable: true });
      await updateProjection(sessionId, { status: "idle" });
    },

    async rename(sessionId, title) {
      const t = title.trim();
      if (!t || t.length > 200) throw Object.assign(new Error("title required (≤200 chars)"), { code: "invalid-input" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      await appendAndBroadcast(sessionId, "session/metadata-changed", { title: t }, { ignorable: true });
      await updateProjection(sessionId, { title: t });
    },

    async organize(sessionId, patch: SessionOrganizePatch) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const next: Partial<SessionProjection> = {};
      if (patch.folderId !== undefined) {
        if (patch.folderId === null) {
          next.folderId = undefined;
        } else {
          if (!deps.org) throw Object.assign(new Error("folders unavailable"), { code: "unsupported" });
          const folders = await deps.org.folderList(proj.projectId);
          if (!folders.some((f) => f.id === patch.folderId)) {
            // absent or cross-project — both are rejected the same way
            throw Object.assign(new Error("folder not found in this project"), { code: "invalid-input" });
          }
          next.folderId = patch.folderId;
        }
      }
      if (patch.labelIds !== undefined) next.labelIds = patch.labelIds;
      await appendAndBroadcast(sessionId, "session/metadata-changed", {
        ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
        ...(patch.labelIds !== undefined ? { labelIds: patch.labelIds } : {}),
      }, { ignorable: true });
      // folderId: undefined must actually clear the stored key
      const current = await store.projection(sessionId);
      if (!current) return;
      const merged = { ...current, ...next, updatedAt: Date.now() };
      if (patch.folderId === null) delete merged.folderId;
      await store.upsertProjection(merged);
      broadcast.projection(merged);
    },

    async list(projectId) {
      const projections = await store.projections(projectId);
      if (!deps.org || projections.length === 0) return projections;
      // Attention badges derive from durable events on every read (WP5).
      const counts = await deps.org.attentionFor(projections.map((p) => p.id)).catch(() => ({} as Record<string, { questions: number; permissions: number }>));
      return projections.map((p) => {
        const c = counts[p.id];
        return c ? { ...p, attention: { questions: c.questions, permissions: c.permissions, unread: 0 } } : p;
      });
    },
    async sync(projectId) {
      const project = await projects.get(projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      const runtime = await runtimes.forProject(projectId, project.path);
      const known = await store.projections(projectId);
      const byBackend = new Map(known.filter((session) => session.backendSessionId).map((session) => [session.backendSessionId!, session]));
      for (const remote of await runtime.sessions()) {
        if (byBackend.has(remote.id)) continue;
        const id = randomUUID();
        const projection: SessionProjection = {
          id, projectId, title: remote.title, status: "idle", backendSessionId: remote.id,
          createdAt: remote.createdAt, updatedAt: remote.updatedAt,
        };
        // History is NOT fetched here — importing full histories for every
        // remote session at once is what OOM'd the server. It is imported
        // lazily in events() the first time the session is opened.
        await runtime.ensureSession({ projectId, title: remote.title, sessionId: id, cwd: project.path, backendSessionId: remote.id });
        wire(id, runtime);
        await store.upsertProjection(projection);
        await appendAndBroadcast(id, "session/imported", { backendSessionId: remote.id }, { ignorable: true });
        broadcast.projection(projection);
      }
      return store.projections(projectId);
    },
    async snapshot(sessionId) {
      const p = await store.projection(sessionId);
      if (!p) throw Object.assign(new Error("session not found"), { code: "not-found" });
      return p;
    },
    async events(sessionId, afterSeq) {
      // Restart recovery: opening an idle session with persisted queued
      // messages resumes FIFO dispatch (never into an active stream).
      if (afterSeq === 0 && deps.queue && !turnActive(sessionId)) {
        void deps.queue.queueList(sessionId).then((q) => {
          if (q.length > 0) return dispatchQueue(sessionId);
          return undefined;
        }).catch(() => {});
      }
      // Lazy history import: one-time, bounded, only for sessions adopted
      // from OpenCode. Importing all histories eagerly at sync time is what
      // OOM'd the server, so history arrives the first time a session opens.
      if (afterSeq === 0) {
        const proj = await store.projection(sessionId);
        if (proj?.backendSessionId) {
          const all = await store.events(sessionId);
          const imported = all.some((e) => e.type === "session/imported");
          const fetched = all.some((e) => e.type === "session/history-imported");
          if (imported && !fetched) {
            try {
              const rt = await ensureWired(sessionId, proj);
              for (const message of await rt.history(proj.backendSessionId)) {
                await appendAndBroadcast(sessionId, message.role === "user" ? "user/message" : "assistant/message", {
                  partId: `import_${randomUUID()}`, text: message.text,
                  ...(message.reasoning ? { reasoning: message.reasoning } : {}),
                });
              }
            } catch (err) {
              console.warn(`[polyth] failed to import history for ${sessionId}`, err);
            } finally {
              // marker even on failure so we never retry in a hot loop
              await appendAndBroadcast(sessionId, "session/history-imported", {}, { ignorable: true });
            }
          }
        }
      }
      return store.events(sessionId, afterSeq);
    },

    async replyPermission(sessionId, requestId, reply, scope) {
      await appendAndBroadcast(sessionId, "permission/resolved", { requestId, reply, ...(scope ? { scope } : {}) }, { ignorable: true });
      const proj = await store.projection(sessionId);
      if (reply === "always") {
        // Persist an allow rule derived from the original request. Scope is
        // explicit (WP15): session/project confine the rule; old clients that
        // send no scope keep the pre-existing user-wide behavior.
        const evs = await store.events(sessionId);
        const req = evs.find((e) => e.type === "permission/requested" && (e.data as { requestId?: string }).requestId === requestId);
        if (req) {
          const d = req.data as { permission?: string; patterns?: string[] };
          for (const pattern of d.patterns?.length ? d.patterns : ["*"]) {
            if (scope === "session") {
              permissions.addRule({ permission: d.permission ?? "*", pattern, action: "allow", scope: "session", sessionId });
            } else if (scope === "project" && proj?.projectId) {
              permissions.addRule({ permission: d.permission ?? "*", pattern, action: "allow", scope: "project", projectId: proj.projectId });
            } else {
              permissions.addRule({ permission: d.permission ?? "*", pattern, action: "allow", scope: "user" });
            }
          }
        }
      }
      await sessionRuntime.get(sessionId)?.replyPermission(sessionId, requestId, reply);
      if (proj?.status === "waiting") await updateProjection(sessionId, { status: "working" });
    },

    async replyQuestion(sessionId, requestId, answers) {
      await appendAndBroadcast(sessionId, "question/answered", { requestId, answers }, { ignorable: true });
      const rt = sessionRuntime.get(sessionId);
      if (answers && (answers as { __reject?: boolean }).__reject) {
        await rt?.replyQuestion(sessionId, requestId, { action: "reject" });
      } else {
        await rt?.replyQuestion(sessionId, requestId, answers);
      }
      const proj = await store.projection(sessionId);
      if (proj?.status === "waiting") await updateProjection(sessionId, { status: "working" });
    },
  };
  return service;
}
