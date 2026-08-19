// SessionService: canonical session orchestration.
// Runtime events -> appended to durable session log FIRST -> then broadcast/projections.
import { randomUUID } from "node:crypto";
import type {
  AgentRuntime, CreateSessionInput, JsonObject, RuntimeEvent, SessionEvent,
  SessionProjection, SessionRef, SessionService, SessionPersistence, TurnRef, UserTurnInput,
} from "@polyth/contracts";
import type { ProjectService } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";

export interface Broadcaster {
  event(ev: SessionEvent): void;
  projection(p: SessionProjection): void;
}

export interface RuntimePool {
  /** `cwd` overrides the project root — that is how worktree sessions are isolated. */
  forProject(projectId: string, cwd?: string): Promise<AgentRuntime>;
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
}): SessionService {
  const { store, projects, permissions, runtimes, broadcast } = deps;
  const hooks = deps.hooks ?? {};
  const sessionRuntime = new Map<string, AgentRuntime>(); // sessionId -> runtime
  const lastTurnId = new Map<string, string>();           // sessionId -> active turnId
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
        turnReply.set(sessionId, new Map());
        await appendAndBroadcast(sessionId, "turn/started", { turnId: ev.turnId }, { ignorable: true });
        await updateProjection(sessionId, { status: "working", lastTurnAt: Date.now() });
        break;
      case "turn/stopped":
        await appendAndBroadcast(sessionId, "turn/stopped", {
          turnId: lastTurnId.get(sessionId) ?? ev.type, reason: ev.reason, ...(ev.error ? { error: ev.error } : {}),
        }, { ignorable: true });
        lastTurnId.delete(sessionId);
        await updateProjection(sessionId, { status: ev.reason === "error" ? "failed" : "idle" });
        if (ev.reason === "completed") hooks.onTurnCompleted?.(sessionId, replyText(sessionId));
        break;
      case "permission/requested": {
        const { type: _t, ...reqData } = ev;
        await appendAndBroadcast(sessionId, "permission/requested", reqData as unknown as JsonObject, { ignorable: true });
        const proj = await store.projection(sessionId);
        const verdict = permissions.evaluate(ev.permission, ev.patterns, proj?.projectId);
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

  return {
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

    async send(sessionId, input: UserTurnInput): Promise<TurnRef> {
      const proj = await store.projection(sessionId);
      if (!proj) throw Object.assign(new Error("session not found"), { code: "not-found" });
      const rt = await ensureWired(sessionId, proj);
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
      await appendAndBroadcast(sessionId, "user/message", {
        text, ...(raw !== text ? { raw } : {}),
        ...(input.attachments ? { attachments: input.attachments as unknown as JsonObject[] } : {}),
      });
      try {
        const model = input.model ?? cmdModel ?? proj.model;
        const agent = input.agent ?? cmdAgent ?? proj.agent;
        await rt.startTurn({
          sessionId, text,
          ...(model ? { model } : {}),
          ...(agent ? { agent } : {}),
        });
      } catch (err) {
        await appendAndBroadcast(sessionId, "turn/failed", { error: String(err) }, { ignorable: true });
        await updateProjection(sessionId, { status: "failed" });
        throw err;
      }
      return { turnId: randomUUID() };
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
      await appendAndBroadcast(sessionId, "session/archived", {}, { ignorable: true });
      await updateProjection(sessionId, { status: "archived" });
    },
    async restore(sessionId) {
      await appendAndBroadcast(sessionId, "session/restored", {}, { ignorable: true });
      await updateProjection(sessionId, { status: "idle" });
    },

    list: (projectId) => store.projections(projectId),
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

    async replyPermission(sessionId, requestId, reply) {
      await appendAndBroadcast(sessionId, "permission/resolved", { requestId, reply }, { ignorable: true });
      const proj = await store.projection(sessionId);
      if (reply === "always") {
        // persist an allow rule derived from the original request
        const evs = await store.events(sessionId);
        const req = evs.find((e) => e.type === "permission/requested" && (e.data as { requestId?: string }).requestId === requestId);
        if (req) {
          const d = req.data as { permission?: string; patterns?: string[] };
          for (const pattern of d.patterns?.length ? d.patterns : ["*"]) {
            permissions.addRule({ permission: d.permission ?? "*", pattern, action: "allow", scope: "user" });
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
}
