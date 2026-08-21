// SessionService: canonical session orchestration.
// Runtime events -> appended to durable session log FIRST -> then broadcast/projections.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  AgentProfile, AgentRuntime, AttachmentRef, AutoAcceptSetting, CreateSessionInput, DeliveryMode, Disposable,
  JsonObject, QueueItemDto, RuntimeEvent,
  RuntimeSession, SendResult, SessionEvent, SessionFolderDto, SessionOrganizePatch, SessionProjection, SessionRef,
  SessionService, SessionPersistence, UserTurnInput,
} from "@polyth/contracts";
import type { ProjectService } from "@polyth/contracts";
import type { AutoAcceptStore, PermissionService } from "@polyth/permissions";
import { resolveAutoAccept } from "@polyth/permissions";
import { activeRewind } from "@polyth/session";
import { buildPermissionPreview, PERMISSION_ALLOWED_SCOPES } from "./permissionPreview.ts";
import { sanitizeAttachments } from "./attachments.ts";

export interface Broadcaster {
  event(ev: SessionEvent): void;
  projection(p: SessionProjection): void;
}

/** Durable FIFO delivery queue (implemented by @polyth/session's Store). */
export interface QueueStore {
  enqueue(sessionId: string, text: string, delivery: DeliveryMode, attachments?: AttachmentRef[]): Promise<QueueItemDto>;
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
  /** Authoritative git worktree inventory used to validate session cwd overrides. */
  worktrees?: {
    list(root: string): Promise<Array<{ path: string; branch: string | null }>>;
  };
  /** Agent-profile lookup (WP8) — profiles resolve to explicit model/agent at send time. */
  profiles?: { profileGet(id: string): Promise<AgentProfile | undefined> };
  /** Global behavior instructions (WP9): revision+digest logged before a turn
   *  starts under a newly applied revision, keeping replay reproducible. */
  behavior?: { current(): Promise<{ revision: string; digest: string } | null> };
  /** Bounded composer-shell executor backed by @polyth/terminal. */
  shell?: {
    run(
      input: { projectId: string; cwd: string; cmd: string },
      opts?: { timeoutMs?: number; maxOutputBytes?: number },
    ): Promise<{ output: string; exitCode: number | null; timedOut: boolean; truncated: boolean }>;
  };
  /** Attachment existence/size verification against the session's file root (F2).
   *  `stat` must reject paths escaping the root; `maxBytes` reuses the upload cap. */
  attachments?: {
    stat(root: string, rel: string): Promise<{ kind: "file" | "dir"; size: number }>;
    maxBytes: number;
  };
  /** F18: per-session auto-accept policy store (nearest-parent resolution). */
  autoAccept?: AutoAcceptStore;
  /** F18: human-needed / turn-ended signals for out-of-page delivery (web
   *  push). Fired only when a card actually reaches the UI — auto-accepted
   *  permissions never notify. */
  notify?: {
    attention(sessionId: string, kind: "permission" | "question"): void;
    turnStopped(sessionId: string, reason: "completed" | "aborted" | "error"): void;
  };
}): SessionService {
  const { store, projects, permissions, runtimes, broadcast } = deps;
  const hooks = deps.hooks ?? {};
  const sessionRuntime = new Map<string, AgentRuntime>(); // sessionId -> runtime
  // One onEvent subscription per runtime (not per session): events dispatch
  // through sessionRuntime, so wiring N sessions to a runtime costs a single
  // listener that unwire() disposes once the last session leaves it.
  const runtimeSubs = new Map<AgentRuntime, Disposable>();
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

  // F18: effective auto-accept — own explicit setting, else the nearest
  // ancestor's (subagents/forks carry parentId). The chain is prefetched from
  // projections; resolveAutoAccept is the pure, cycle-guarded core.
  const effectiveAutoAccept = async (sessionId: string): Promise<boolean> => {
    if (!deps.autoAccept) return false;
    const parents = new Map<string, string | undefined>();
    let id: string | undefined = sessionId;
    while (id && !parents.has(id) && parents.size < 64) {
      const proj = await store.projection(id);
      parents.set(id, proj?.parentId);
      id = proj?.parentId;
    }
    return resolveAutoAccept(sessionId, (x) => deps.autoAccept!.get(x), (x) => parents.get(x));
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
        deps.notify?.turnStopped(sessionId, ev.reason);
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
        } else if (await effectiveAutoAccept(sessionId)) {
          // F18: policy-approved. Both events land at once so the log stays
          // truthful while the UI never shows a banner; deny rules above win.
          await appendAndBroadcast(sessionId, "permission/resolved", { requestId: ev.requestId, reply: "once", auto: true }, { ignorable: true });
          await sessionRuntime.get(sessionId)?.replyPermission(sessionId, ev.requestId, "once");
        } else {
          await updateProjection(sessionId, { status: "waiting" });
          deps.notify?.attention(sessionId, "permission");
        }
        break;
      }
      case "question/asked": {
        const { type: _t, ...qData } = ev;
        await appendAndBroadcast(sessionId, "question/asked", qData as unknown as JsonObject, { ignorable: true });
        await updateProjection(sessionId, { status: "waiting" });
        deps.notify?.attention(sessionId, "question");
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
    if (runtimeSubs.has(rt)) return;
    runtimeSubs.set(rt, rt.onEvent((sid, ev) => {
      // deliver only to sessions currently wired to this runtime — the same
      // filter the old per-session closures applied, minus the listener pile-up
      if (sessionRuntime.get(sid) === rt) void onRuntimeEvent(sid, ev);
    }));
  };

  const unwire = (sessionId: string) => {
    const rt = sessionRuntime.get(sessionId);
    if (!rt) return;
    sessionRuntime.delete(sessionId);
    turnReply.delete(sessionId);
    behaviorLogged.delete(sessionId);
    for (const wired of sessionRuntime.values()) if (wired === rt) return;
    runtimeSubs.get(rt)?.dispose();
    runtimeSubs.delete(rt);
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

  const finishShell = async (
    sessionId: string,
    proj: SessionProjection,
    command: string,
    callId: string,
    rejected = false,
  ): Promise<void> => {
    await appendAndBroadcast(sessionId, "tool/call", {
      callId,
      tool: "shell",
      input: { command },
    }, { producerPlugin: "composer-shell" });
    if (rejected) {
      await appendAndBroadcast(sessionId, "tool/result", {
        callId,
        tool: "shell",
        output: "Command rejected by the shell permission policy.",
        title: `!${command}`,
        input: { command },
        metadata: { rejected: true },
      }, { producerPlugin: "composer-shell" });
      return;
    }
    if (!deps.shell) throw Object.assign(new Error("composer shell unavailable"), { code: "unsupported" });
    const project = await projects.get(proj.projectId);
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    try {
      const result = await deps.shell.run({
        projectId: proj.projectId,
        cwd: proj.worktreePath ?? project.path,
        cmd: command,
      }, { timeoutMs: 30_000, maxOutputBytes: 64 * 1_024 });
      const suffix = result.timedOut
        ? "\n[command timed out]"
        : result.truncated
          ? "\n[earlier output truncated]"
          : "";
      await appendAndBroadcast(sessionId, "tool/result", {
        callId,
        tool: "shell",
        output: `${result.output}${suffix}`,
        title: `!${command}`,
        input: { command },
        metadata: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      }, { producerPlugin: "composer-shell" });
    } catch (err) {
      await appendAndBroadcast(sessionId, "tool/result", {
        callId,
        tool: "shell",
        output: err instanceof Error ? err.message : String(err),
        title: `!${command}`,
        input: { command },
        metadata: { failed: true },
      }, { producerPlugin: "composer-shell" });
      throw err;
    }
  };

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

  /** F2: shape-check + existence-check attachments before anything is logged
   *  or queued. Deleted files refuse attachment with a typed error. */
  const verifyAttachments = async (
    proj: SessionProjection, raw: unknown,
  ): Promise<AttachmentRef[] | undefined> => {
    const maxBytes = deps.attachments?.maxBytes ?? 20 * 1024 * 1024;
    const refs = sanitizeAttachments(raw, { maxBytes, projectId: proj.projectId });
    if (refs.length === 0) return undefined;
    if (deps.attachments) {
      const project = await projects.get(proj.projectId);
      const root = proj.worktreePath ?? project?.path;
      if (!root) throw Object.assign(new Error("project not found"), { code: "not-found" });
      for (const ref of refs) {
        if (!ref.path) continue; // url attachments have nothing on disk
        let stat: { kind: "file" | "dir"; size: number };
        try {
          stat = await deps.attachments.stat(root, ref.path);
        } catch {
          throw Object.assign(new Error(`attachment file not found: ${ref.path}`), { code: "invalid-input" });
        }
        if (stat.kind !== "file") {
          throw Object.assign(new Error(`attachment must be a file: ${ref.path}`), { code: "invalid-input" });
        }
        if (stat.size > deps.attachments.maxBytes) {
          throw Object.assign(new Error(`attachment too large (max ${deps.attachments.maxBytes} bytes): ${ref.path}`), { code: "invalid-input" });
        }
        ref.size = stat.size; // trust disk, not the client
      }
    }
    return refs;
  };

  const enqueueMessage = async (
    sessionId: string, text: string, delivery: DeliveryMode, fallbackReason?: string,
    attachments?: AttachmentRef[],
  ): Promise<SendResult> => {
    if (!deps.queue) throw Object.assign(new Error("delivery queue unavailable"), { code: "unsupported" });
    const item = await deps.queue.enqueue(sessionId, text, delivery, attachments);
    if (fallbackReason) {
      await appendAndBroadcast(sessionId, "delivery/fallback-queued", { queueId: item.id, reason: fallbackReason }, { ignorable: true });
    }
    await appendAndBroadcast(sessionId, "queue/enqueued", {
      queueId: item.id, text, delivery,
      ...(attachments?.length ? { attachments: attachments as unknown as JsonObject[] } : {}),
    }, { ignorable: true });
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
      const restored = await deps.queue.enqueue(sessionId, item.text, item.delivery, item.attachments);
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
      await admitTurn(sessionId, proj2, rt, {
        text: item.text,
        ...(item.attachments?.length ? { attachments: item.attachments } : {}),
      });
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
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
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

  // F14 import half: one scan shared by browse/import/sync — backend sessions
  // deduped by id, already-adopted ones filtered out, most recent first.
  const backendSessionScan = async (projectId: string) => {
    const project = await projects.get(projectId);
    if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
    const runtime = await runtimes.forProject(projectId, project.path);
    const known = await store.projections(projectId);
    const adopted = new Set(known.map((s) => s.backendSessionId).filter(Boolean));
    const seen = new Set<string>();
    const items: RuntimeSession[] = [];
    let total = 0;
    for (const remote of await runtime.sessions()) {
      if (seen.has(remote.id)) continue;
      seen.add(remote.id);
      total += 1;
      if (adopted.has(remote.id)) continue;
      items.push(remote);
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return { project, runtime, items, total };
  };

  const service: SessionService = {
    async create(input: CreateSessionInput): Promise<SessionRef> {
      const project = await projects.get(input.projectId);
      if (!project) throw Object.assign(new Error("project not found"), { code: "not-found" });
      let worktree: { path: string; branch: string | null } | undefined;
      if (input.worktreePath && deps.worktrees) {
        const requested = resolve(input.worktreePath);
        worktree = (await deps.worktrees.list(project.path))
          .find((candidate) => resolve(candidate.path) === requested);
        if (!worktree) {
          throw Object.assign(new Error("worktree does not belong to this project"), { code: "invalid-input" });
        }
        input = { ...input, worktreePath: worktree.path };
      }
      const sessionId = randomUUID();
      const cwd = input.worktreePath ?? project.path;
      const rt = await runtimes.forProject(project.id, cwd);
      const backendSessionId = await rt.ensureSession({ ...input, sessionId, cwd });
      wire(sessionId, rt);
      const now = Date.now();
      // F18: a subagent/fork child starts under the nearest parent's policy —
      // the indicator must be honest from the first projection broadcast.
      const inheritedAutoAccept = input.parentId ? await effectiveAutoAccept(input.parentId) : false;
      const projection: SessionProjection = {
        id: sessionId, projectId: project.id,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(inheritedAutoAccept ? { autoAccept: true } : {}),
        title: input.title || "New session", status: "idle",
        ...(input.worktreePath ? {
          worktreePath: input.worktreePath,
          worktreeId: input.worktreePath,
          worktreeState: "ready" as const,
          ...(worktree?.branch ? { branch: worktree.branch } : {}),
        } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        backendSessionId,
        createdAt: now, updatedAt: now,
      };
      await store.upsertProjection(projection);
      await appendAndBroadcast(sessionId, "session/created", {
        title: projection.title, projectId: project.id,
        ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
        ...(input.model ? { model: input.model as unknown as JsonObject } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      }, { ignorable: true });
      broadcast.projection(projection);
      return { id: sessionId };
    },

    async send(sessionId, input: UserTurnInput): Promise<SendResult> {
      let proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      // Attachments are verified before any state changes (rewind reset,
      // queueing, admission) so a bad ref can never dirty the durable log.
      if (input.attachments !== undefined) {
        const verified = await verifyAttachments(proj, input.attachments);
        input = { ...input };
        if (verified) input.attachments = verified;
        else delete input.attachments;
      }
      const rt = await ensureWired(sessionId, proj);

      // A replacement send after rewind must not continue in the backend's
      // stale conversation. Reset first, then resolve the marker and admit the
      // new tail. If reset fails the rewind remains active and replay-safe.
      const rewind = activeRewind(await store.events(sessionId));
      if (rewind) {
        if (!rt.resetSession) {
          throw Object.assign(new Error("runtime cannot reset rewound history"), { code: "unsupported" });
        }
        const project = await projects.get(proj.projectId);
        const cwd = proj.worktreePath ?? project?.path ?? process.cwd();
        const backendSessionId = await rt.resetSession({
          projectId: proj.projectId,
          title: proj.title,
          sessionId,
          cwd,
          ...(proj.model ? { model: proj.model } : {}),
          ...(proj.agent ? { agent: proj.agent } : {}),
        });
        await updateProjection(sessionId, { backendSessionId, status: "idle" });
        proj = { ...proj, backendSessionId, status: "idle" };
        await appendAndBroadcast(sessionId, "session/rewind-cleared", {
          rewindSeq: rewind.markerSeq,
          replaced: true,
        });
      }

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
        if (delivery === "queue") return enqueueMessage(sessionId, input.text, "queue", undefined, input.attachments);
        if (delivery === "normal") {
          // idle race: the turn started between the client's check and admission
          return enqueueMessage(sessionId, input.text, "queue", "turn-active", input.attachments);
        }
        if (delivery === "steer") {
          const caps = await rt.capabilities().catch(() => null);
          if (!caps?.steering || !rt.steer) {
            return enqueueMessage(sessionId, input.text, "steer", "steer-unsupported", input.attachments);
          }
          // Steering is text-only in the runtime seam; attachments would be
          // silently dropped mid-turn, so they queue for the next turn instead.
          if (input.attachments?.length) {
            return enqueueMessage(sessionId, input.text, "steer", "steer-attachments", input.attachments);
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
          const item = await deps.queue.enqueue(sessionId, input.text, "interrupt", input.attachments);
          const rest = await deps.queue.queueList(sessionId);
          const ids = [item.id, ...rest.filter((i) => i.id !== item.id).map((i) => i.id)];
          if (ids.length > 1) await deps.queue.queueReorder(sessionId, ids);
          await appendAndBroadcast(sessionId, "queue/enqueued", {
            queueId: item.id, text: input.text, delivery,
            ...(input.attachments?.length ? { attachments: input.attachments as unknown as JsonObject[] } : {}),
          }, { ignorable: true });
          await rt.abort(sessionId).catch(() => {});
          return { queueId: item.id, queued: true };
        }
      }

      // Idle with older queued items: preserve FIFO — this message joins the
      // queue and the head dispatches now.
      if (!active && deps.queue && delivery !== "interrupt") {
        const pendingQueue = await deps.queue.queueList(sessionId);
        if (pendingQueue.length > 0) {
          const res = await enqueueMessage(sessionId, input.text, delivery === "steer" ? "steer" : "queue", undefined, input.attachments);
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
      if (atSeq !== undefined) {
        if (!Number.isSafeInteger(atSeq) || atSeq <= 0) {
          throw Object.assign(new Error("atSeq must be a positive event sequence"), { code: "invalid-input" });
        }
        const target = (await store.events(sessionId)).find((ev) => ev.seq === atSeq);
        if (!target) throw Object.assign(new Error("fork event not found"), { code: "not-found" });
      }
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

    async rewind(sessionId, atSeq): Promise<SessionEvent> {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (turnActive(sessionId) || proj.status === "working" || proj.status === "waiting") {
        throw Object.assign(new Error("cannot rewind while a turn is running"), { code: "conflict" });
      }
      if (!Number.isSafeInteger(atSeq) || atSeq <= 0) {
        throw Object.assign(new Error("atSeq must be a positive event sequence"), { code: "invalid-input" });
      }
      if (deps.queue && (await deps.queue.queueList(sessionId)).length > 0) {
        throw Object.assign(new Error("cannot rewind while messages are queued"), { code: "conflict" });
      }
      const events = await store.events(sessionId);
      if (activeRewind(events)) {
        throw Object.assign(new Error("restore or replace the current rewind first"), { code: "conflict" });
      }
      const target = events.find((ev) => ev.seq === atSeq);
      if (!target) throw Object.assign(new Error("rewind event not found"), { code: "not-found" });
      if (target.type !== "user/message") {
        throw Object.assign(new Error("rewind target must be a user message"), { code: "invalid-input" });
      }
      const text = (target.data as { raw?: unknown; text?: unknown }).raw
        ?? (target.data as { text?: unknown }).text;
      return appendAndBroadcast(sessionId, "session/rewound", {
        atSeq,
        ...(typeof text === "string" ? { restoredText: text } : {}),
      });
    },

    async clearRewind(sessionId): Promise<SessionEvent> {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (turnActive(sessionId) || proj.status === "working" || proj.status === "waiting") {
        throw Object.assign(new Error("cannot restore while a turn is running"), { code: "conflict" });
      }
      const rewind = activeRewind(await store.events(sessionId));
      if (!rewind) throw Object.assign(new Error("session has no active rewind"), { code: "conflict" });
      return appendAndBroadcast(sessionId, "session/rewind-cleared", { rewindSeq: rewind.markerSeq });
    },

    async runShell(sessionId, command) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (!deps.shell) throw Object.assign(new Error("composer shell unavailable"), { code: "unsupported" });
      if (turnActive(sessionId) || proj.status === "working" || proj.status === "waiting") {
        throw Object.assign(new Error("cannot run a composer shell command during an active turn"), { code: "conflict" });
      }
      const cmd = command.trim();
      if (!cmd || cmd.length > 8_000 || cmd.includes("\0")) {
        throw Object.assign(new Error("shell command required (≤8000 chars)"), { code: "invalid-input" });
      }
      const callId = `shell_${randomUUID()}`;
      const verdict = permissions.evaluate("shell", [cmd], proj.projectId, sessionId);
      if (verdict === "deny") {
        await finishShell(sessionId, proj, cmd, callId, true);
        return { callId, status: "rejected" };
      }
      if (verdict === "ask") {
        const requestId = `per_${randomUUID()}`;
        await appendAndBroadcast(sessionId, "permission/requested", {
          requestId,
          permission: "shell",
          patterns: [cmd],
          tool: "shell",
          callId,
          preview: buildPermissionPreview({ permission: "shell", patterns: [cmd], tool: "shell" }) as unknown as JsonObject,
          allowedScopes: [...PERMISSION_ALLOWED_SCOPES],
        }, { ignorable: true, producerPlugin: "composer-shell" });
        await updateProjection(sessionId, { status: "waiting" });
        return { callId, requestId, status: "pending" };
      }
      await finishShell(sessionId, proj, cmd, callId);
      return { callId, status: "completed" };
    },

    async archive(sessionId) {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (proj.status === "archived") return; // idempotent: no duplicate events
      await appendAndBroadcast(sessionId, "session/archived", {}, { ignorable: true });
      await updateProjection(sessionId, { status: "archived" });
      // Release the dispatch slot when idle. A mid-turn archive stays wired:
      // model-visible content must keep landing in the log until the turn
      // stops; ensureWired re-wires lazily after a restore.
      if (!turnActive(sessionId)) unwire(sessionId);
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
      if (patch.pinned !== undefined) {
        if (patch.pinned === null) {
          next.pinned = undefined;
        } else {
          const position = patch.pinned.position;
          if (!Number.isSafeInteger(position) || position < 0 || position > 100_000) {
            throw Object.assign(new Error("pin position must be an integer from 0 to 100000"), { code: "invalid-input" });
          }
          next.pinned = { position };
        }
      }
      // Pin state is organization metadata, not model-visible session history.
      if (patch.folderId !== undefined || patch.labelIds !== undefined) {
        await appendAndBroadcast(sessionId, "session/metadata-changed", {
          ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
          ...(patch.labelIds !== undefined ? { labelIds: patch.labelIds } : {}),
        }, { ignorable: true });
      }
      // folderId: undefined must actually clear the stored key
      const current = await store.projection(sessionId);
      if (!current) return;
      const merged = { ...current, ...next, updatedAt: Date.now() };
      if (patch.folderId === null) delete merged.folderId;
      if (patch.pinned === null) delete merged.pinned;
      await store.upsertProjection(merged);
      broadcast.projection(merged);
    },

    async markWorktreeMissing(projectId, worktreePath) {
      const missingPath = resolve(worktreePath);
      for (const projection of await store.projections(projectId)) {
        if (!projection.worktreePath || resolve(projection.worktreePath) !== missingPath) continue;
        const next: SessionProjection = {
          ...projection,
          worktreeState: "missing",
          updatedAt: Date.now(),
        };
        await store.upsertProjection(next);
        broadcast.projection(next);
      }
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
      // F14: bulk adopt-everything, kept for programmatic use. The web now
      // browses /api/control/backend-sessions and imports selectively.
      const { items } = await backendSessionScan(projectId);
      if (items.length > 0) {
        await this.importBackendSessions!(projectId, items.map((r) => r.id));
      }
      return store.projections(projectId);
    },
    async backendSessions(projectId) {
      const { items, total } = await backendSessionScan(projectId);
      return { items, total };
    },
    async importBackendSessions(projectId, backendIds) {
      const { project, runtime, items } = await backendSessionScan(projectId);
      const wanted = new Set(backendIds);
      const out: SessionProjection[] = [];
      for (const remote of items) {
        if (!wanted.has(remote.id)) continue;
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
        out.push(projection);
      }
      return out;
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
      const priorEvents = await store.events(sessionId);
      const original = priorEvents.find(
        (e) => e.type === "permission/requested" && (e.data as { requestId?: string }).requestId === requestId,
      );
      const shellRequest = original && (original.data as { permission?: string }).permission === "shell"
        ? original
        : undefined;
      if (shellRequest && priorEvents.some(
        (e) => e.type === "permission/resolved" && (e.data as { requestId?: string }).requestId === requestId,
      )) {
        throw Object.assign(new Error("shell permission request already resolved"), { code: "conflict" });
      }
      await appendAndBroadcast(sessionId, "permission/resolved", { requestId, reply, ...(scope ? { scope } : {}) }, { ignorable: true });
      const proj = await store.projection(sessionId);
      if (reply === "always") {
        // Persist an allow rule derived from the original request. Scope is
        // explicit (WP15): session/project confine the rule; old clients that
        // send no scope keep the pre-existing user-wide behavior.
        const req = original;
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
      if (shellRequest && proj) {
        const d = shellRequest.data as { patterns?: string[]; callId?: string };
        const command = d.patterns?.[0] ?? "";
        const callId = d.callId ?? `shell_${randomUUID()}`;
        await finishShell(sessionId, proj, command, callId, reply === "reject");
        if (proj.status === "waiting") await updateProjection(sessionId, { status: "idle" });
      } else {
        await sessionRuntime.get(sessionId)?.replyPermission(sessionId, requestId, reply);
        if (proj?.status === "waiting") await updateProjection(sessionId, { status: "working" });
      }
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

    async autoAcceptGet(sessionId) {
      if (!deps.autoAccept) throw Object.assign(new Error("auto-accept unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      return { setting: deps.autoAccept.get(sessionId), effective: await effectiveAutoAccept(sessionId) };
    },

    async autoAcceptSet(sessionId, setting: AutoAcceptSetting) {
      if (!deps.autoAccept) throw Object.assign(new Error("auto-accept unavailable"), { code: "unsupported" });
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      if (setting !== "on" && setting !== "off" && setting !== "inherit") {
        throw Object.assign(new Error("setting must be on, off, or inherit"), { code: "invalid-input" });
      }
      deps.autoAccept.set(sessionId, setting);
      // Refresh the effective flag everywhere the change can be seen through a
      // parent chain, and reconcile pending requests where the policy now
      // approves them (OC#2158: enabling resolves requests already waiting).
      for (const p of await store.projections()) {
        const effective = await effectiveAutoAccept(p.id);
        if ((p.autoAccept ?? false) !== effective) await updateProjection(p.id, { autoAccept: effective });
        if (effective && p.status === "waiting") await reconcilePendingPermissions(p.id);
      }
      return { setting, effective: await effectiveAutoAccept(sessionId) };
    },
  };

  /** F18 reconcile-on-enable: resolve every pending runtime permission request
   *  of the session with an auto "once". Composer-shell confirmations are
   *  skipped — those confirm a command the USER typed and must stay manual. */
  const reconcilePendingPermissions = async (sessionId: string): Promise<void> => {
    const evs = await store.events(sessionId);
    const resolved = new Set<string>();
    const answeredQs = new Set<string>();
    for (const e of evs) {
      const rid = (e.data as { requestId?: string }).requestId;
      if (!rid) continue;
      if (e.type === "permission/resolved") resolved.add(rid);
      if (e.type === "question/answered") answeredQs.add(rid);
    }
    let openQuestions = 0;
    let resolvedAny = false;
    for (const e of evs) {
      const rid = (e.data as { requestId?: string }).requestId;
      if (!rid) continue;
      if (e.type === "question/asked" && !answeredQs.has(rid)) openQuestions++;
      if (e.type !== "permission/requested" || resolved.has(rid)) continue;
      if (e.producerPlugin === "composer-shell") continue;
      resolved.add(rid);
      resolvedAny = true;
      await appendAndBroadcast(sessionId, "permission/resolved", { requestId: rid, reply: "once", auto: true }, { ignorable: true });
      await sessionRuntime.get(sessionId)?.replyPermission(sessionId, rid, "once").catch(() => {});
    }
    // The turn resumes once its blocker is answered; questions keep it waiting.
    if (resolvedAny && openQuestions === 0) {
      const proj = await store.projection(sessionId);
      if (proj?.status === "waiting") await updateProjection(sessionId, { status: "working" });
    }
  };

  return service;
}
