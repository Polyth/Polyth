import type {
  AgentProjectSummaryDto,
  AgentSessionDetailDto,
  AgentSessionListDto,
  AutoAcceptSetting,
  HarnessSelection,
  JsonObject,
  ModelRef,
  Project,
  ProjectService,
  RouteHandler,
  SessionDebugDto,
  SessionEvent,
  SessionOrganizePatch,
  SessionPersistence,
  SessionProjection,
  SessionService,
  UserTurnInput,
} from "@polyth/contracts";
import { deriveMessages, planRuntimeEpochRecovery, sessionDebugObservability } from "@polyth/session";
import type { SpaceServicesFor } from "../spaceScope.ts";
import { parseTurnCommand } from "../turnCommand.ts";

const SESSION_STATUSES = new Set([
  "idle", "working", "waiting", "finished", "failed", "archived",
  "epoch-pending",
]);
const DELIVERY_MODES = new Set(["normal", "steer", "queue", "interrupt"]);
const MAX_IMPORT_BATCH = 200;
const SESSION_TITLE_MAX = 120;

export interface AgentGoalState {
  objective: string;
  status: "active" | "paused" | "completed" | "stuck" | "stopped";
  continuations: number;
  maxContinuations: number;
  tokensUsed: number;
  budgetTokens: number;
  lastVerdict?: "keep" | "done" | "stuck";
  lastReason?: string;
  stuckStreak: number;
  updatedAt: number;
}

export interface AgentGoalService {
  get(sessionId: string): AgentGoalState | null;
  rehydrate(
    sessionId: string,
    events: SessionEvent[],
  ): AgentGoalState | null | Promise<AgentGoalState | null>;
  attach(sessionId: string, input: {
    objective: string;
    budgetTokens?: number;
    maxContinuations?: number;
  }): Promise<AgentGoalState>;
  pause(sessionId: string): Promise<AgentGoalState>;
  resume(sessionId: string): Promise<AgentGoalState>;
  stop(sessionId: string): Promise<void>;
}

export interface AgentSessionRouteDeps {
  /** Tenant-scoped services. The agent API is a full session surface, so it
   *  never receives the unscoped services — a `spaceId` is required to obtain
   *  any of them. */
  spaces: SpaceServicesFor;
  store: Pick<SessionPersistence, "events">;
  capabilities?: () => string[];
  goals?: () => AgentGoalService | undefined;
  version?: string;
  /** Private notification-recipient registration after a durable session write. */
  onSessionCreated?: (sessionId: string, space: { userId: string; spaceId: string }, parentSessionId?: string) => Promise<void>;
  onSessionsImported?: (sessionIds: readonly string[], space: { userId: string; spaceId: string }) => Promise<void>;
  onSessionForked?: (parentSessionId: string, sessionId: string, space: { userId: string; spaceId: string }) => Promise<void>;
}

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: "invalid-input" });
};

const unsupported = (message: string): never => {
  throw Object.assign(new Error(message), { code: "unsupported" });
};

const pathId = (raw: string): string => {
  try {
    const id = decodeURIComponent(raw);
    if (!id) return invalid("session id required");
    return id;
  } catch {
    throw Object.assign(new Error("invalid encoded path"), { code: "invalid-path" });
  }
};

const integerQuery = (
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return invalid(`${name} must be an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return invalid(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
};

const optionalString = (
  body: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return invalid(`${key} must be a string`);
  return value;
};

const agentSessionTitle = (body: Record<string, unknown>): string => {
  const value = optionalString(body, "title");
  const title = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!title) return invalid("title is required for agent-created sessions");
  if (title.length > SESSION_TITLE_MAX) {
    return invalid(`title must be ${SESSION_TITLE_MAX} characters or fewer`);
  }
  return title;
};

const modelInput = (value: unknown): ModelRef | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("model must contain providerID and modelID");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.providerID !== "string" || !raw.providerID.trim()
    || typeof raw.modelID !== "string" || !raw.modelID.trim()) {
    return invalid("model must contain providerID and modelID");
  }
  if (raw.variant !== undefined && (typeof raw.variant !== "string" || !raw.variant.trim())) {
    return invalid("model variant must be a non-empty string");
  }
  return {
    providerID: raw.providerID,
    modelID: raw.modelID,
    ...(typeof raw.variant === "string" ? { variant: raw.variant } : {}),
  };
};

const harnessInput = (value: unknown): HarnessSelection | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("harness must be auto or a pinned harness selection");
  }
  const raw = value as Record<string, unknown>;
  if (raw.mode === "auto" && raw.harnessId === undefined) return { mode: "auto" };
  if (raw.mode === "pinned"
    && typeof raw.harnessId === "string"
    && /^[a-z][a-z0-9-]*$/.test(raw.harnessId)) {
    return { mode: "pinned", harnessId: raw.harnessId };
  }
  return invalid("harness must be auto or a pinned harness selection");
};

const commandInput = (value: unknown): UserTurnInput["command"] | undefined => {
  try {
    return parseTurnCommand(value);
  } catch (error) {
    return invalid((error as Error).message);
  }
};

const messageInput = (body: Record<string, unknown>): UserTurnInput => {
  if (typeof body.text !== "string") return invalid("text must be a string");
  if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
    return invalid("attachments must be an array");
  }
  if (body.delivery !== undefined
    && (typeof body.delivery !== "string" || !DELIVERY_MODES.has(body.delivery))) {
    return invalid("delivery must be normal, steer, queue, or interrupt");
  }
  if (body.agentProfileId !== undefined
    && body.agentProfileId !== null
    && typeof body.agentProfileId !== "string") {
    return invalid("agentProfileId must be a string or null");
  }
  const model = modelInput(body.model);
  const agent = optionalString(body, "agent");
  const harness = harnessInput(body.harness);
  const command = commandInput(body.command);
  return {
    text: body.text,
    ...(command ? { command } : {}),
    ...(body.autoTitle === true ? { autoTitle: true } : {}),
    ...(Array.isArray(body.attachments) ? { attachments: body.attachments as never } : {}),
    ...(model ? { model } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(harness ? { harness } : {}),
    ...(typeof body.delivery === "string"
      ? { delivery: body.delivery as UserTurnInput["delivery"] }
      : {}),
    ...(body.dismissPending === true ? { dismissPending: true } : {}),
    ...(body.agentProfileId !== undefined
      ? { agentProfileId: body.agentProfileId as string | null }
      : {}),
  };
};

const pendingRequests = (events: readonly SessionEvent[]): SessionDebugDto["pending"] => {
  const permissions = new Set<string>();
  const questions = new Set<string>();
  const secrets = new Set<string>();
  for (const event of events) {
    const requestId = (event.data as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string" || !requestId) continue;
    if (event.type === "permission/requested") permissions.add(requestId);
    else if (event.type === "permission/resolved" || event.type === "permission/expired") permissions.delete(requestId);
    else if (event.type === "question/asked") questions.add(requestId);
    else if (event.type === "question/answered" || event.type === "question/expired") questions.delete(requestId);
    else if (event.type === "secret/requested") secrets.add(requestId);
    else if (event.type === "secret/resolved" || event.type === "secret/expired") secrets.delete(requestId);
  }
  return {
    permissions: [...permissions],
    questions: [...questions],
    secrets: [...secrets],
  };
};

const recentErrors = (events: readonly SessionEvent[]): SessionDebugDto["recentErrors"] =>
  events.flatMap((event) => {
    const data = event.data as Record<string, unknown>;
    const isError = event.type === "turn/failed"
      || event.type === "tool/error"
      || event.type.endsWith("/failed")
      || (event.type === "turn/stopped" && data.reason === "error");
    if (!isError) return [];
    const raw = data.error ?? data.message ?? data.reason ?? "unknown error";
    return [{
      seq: event.seq,
      time: event.time,
      type: event.type,
      message: typeof raw === "string" ? raw : JSON.stringify(raw),
    }];
  }).slice(-20);

const fallbackDebug = async (
  sessions: SessionService,
  projection: SessionProjection,
  events: SessionEvent[],
): Promise<SessionDebugDto> => {
  const last = events.at(-1);
  const queue = await sessions.queueList?.(projection.id) ?? [];
  const plan = planRuntimeEpochRecovery({
    events,
    operations: [],
    includeRestored: true,
  });
  const restored = events.some((event) => {
    if (event.type !== "user/message") return false;
    const metadata = (event.data as {
      runtimeEpochRecovery?: { markerSeq?: unknown; epoch?: unknown };
    }).runtimeEpochRecovery;
    return Number(metadata?.markerSeq) === plan?.markerSeq
      && Number(metadata?.epoch) === plan?.epoch;
  });
  return {
    status: projection.status,
    eventCount: events.length,
    latestSeq: last?.seq ?? 0,
    ...(last ? { lastEvent: { seq: last.seq, time: last.time, type: last.type } } : {}),
    runtime: {
      attached: false,
      activeTurn: projection.status === "working",
      admissionPending: false,
      ...(projection.backendSessionId ? { backendSessionId: projection.backendSessionId } : {}),
      ...(projection.worktreePath ? { worktreePath: projection.worktreePath } : {}),
    },
    queue,
    pending: pendingRequests(events),
    recentErrors: recentErrors(events),
    ...sessionDebugObservability({
      events,
      heldForReview: queue.filter((item) => item.heldForReview).length,
      ...(projection.runtimeBinding ? { binding: projection.runtimeBinding } : {}),
      ...(plan ? { recoveryPlan: plan, recoveryRestored: restored } : {}),
    }),
  };
};

const projectInventory = (
  projects: Project[],
  sessions: SessionProjection[],
): AgentProjectSummaryDto[] => projects.map((project) => {
  const rows = sessions.filter((session) => session.projectId === project.id);
  const latestActivityAt = rows.reduce(
    (latest, session) => Math.max(latest, session.updatedAt),
    0,
  );
  return {
    project,
    sessionCount: rows.length,
    activeSessionCount: rows.filter((session) => session.status !== "archived").length,
    archivedSessionCount: rows.filter((session) => session.status === "archived").length,
    ...(latestActivityAt > 0 ? { latestActivityAt } : {}),
  };
}).sort((a, b) => (b.latestActivityAt ?? 0) - (a.latestActivityAt ?? 0));

const sessionLinks = (sessionId: string): Record<string, string> => {
  const id = encodeURIComponent(sessionId);
  return {
    self: `/api/agent/sessions/${id}`,
    events: `/api/agent/sessions/${id}/events`,
    messages: `/api/agent/sessions/${id}/messages`,
    debug: `/api/agent/sessions/${id}/debug`,
    cancel: `/api/agent/sessions/${id}/cancel`,
    compact: `/api/agent/sessions/${id}/compact`,
    archive: `/api/agent/sessions/${id}/archive`,
    unarchive: `/api/agent/sessions/${id}/unarchive`,
    fork: `/api/agent/sessions/${id}/fork`,
    rewind: `/api/agent/sessions/${id}/rewind`,
    queue: `/api/agent/sessions/${id}/queue`,
    autoAccept: `/api/agent/sessions/${id}/permissions/auto-accept`,
    goal: `/api/agent/sessions/${id}/goal`,
    shell: `/api/agent/sessions/${id}/shell`,
  };
};

/** Authenticated, versioned-by-contract session surface for non-UI agents.
 * Existing feature routes remain available; the discovery response advertises
 * their templates so an agent can traverse the complete session system. */
export function agentSessionRoutes(deps: AgentSessionRouteDeps): RouteHandler {
  const { store } = deps;

  return async (rc) => {
    const { path, method, url, body, json } = rc;
    // Do not read `rc.space` until we know this is an /api/agent path — the
    // getter throws for anonymous SPA/static requests that also hit this chain.
    if (!path.startsWith("/api/agent")) return false;
    // Bound once per request. Every helper below closes over these scoped
    // services, so no branch of this large surface can reach another tenant.
    const space = rc.space;
    const { sessions, projects } = deps.spaces(space);
    const recordNotificationRecipient = async (work: (() => Promise<void>) | undefined): Promise<void> => {
      try { await work?.(); } catch { console.warn("[polyth] notification recipient registration failed"); }
    };

  const context = async (sessionId: string) => {
    const session = await sessions.snapshot(sessionId);
    return { session, project: await projects.get(session.projectId) ?? null };
  };

  const debug = async (
    session: SessionProjection,
    events?: SessionEvent[],
  ): Promise<SessionDebugDto> => sessions.debug
    ? sessions.debug(session.id)
    : fallbackDebug(sessions, session, events ?? await sessions.events(session.id));

  const goal = async (sessionId: string): Promise<AgentGoalService> => {
    const service = deps.goals?.();
    if (!service) return unsupported("session goals are unavailable");
    if (!service.get(sessionId)) {
      await service.rehydrate(sessionId, await store.events(sessionId));
    }
    return service;
  };

    if (path === "/api/agent" && method === "GET"
      || path === "/api/agent/sessions/capabilities" && method === "GET") {
      json(200, {
        apiVersion: 1,
        serverVersion: deps.version ?? "unknown",
        capabilities: deps.capabilities?.() ?? [],
        contracts: {
          sessionCreate: {
            required: ["projectId", "title"],
            title: { maxLength: SESSION_TITLE_MAX, purpose: "concise human-readable delegated job title" },
          },
        },
        endpoints: {
          projects: "GET /api/agent/projects",
          backendSessions: "GET|POST /api/agent/backend-sessions[/import]",
          sessions: "GET|POST /api/agent/sessions",
          session: "GET|PATCH|DELETE /api/agent/sessions/{sessionId}",
          events: "GET /api/agent/sessions/{sessionId}/events?afterSeq=0&limit=200",
          messages: "GET|POST /api/agent/sessions/{sessionId}/messages",
          debug: "GET /api/agent/sessions/{sessionId}/debug",
          lifecycle: "POST /api/agent/sessions/{sessionId}/{cancel|archive|unarchive}",
          queue: "GET|PATCH /api/agent/sessions/{sessionId}/queue",
          permissions: "POST /api/agent/sessions/{sessionId}/permissions/{requestId}",
          questions: "POST /api/agent/sessions/{sessionId}/questions/{requestId}",
          goal: "GET|POST /api/agent/sessions/{sessionId}/goal[/pause|/resume|/stop]",
        },
        relatedSessionApis: {
          multirun: "/api/sessions/{sessionId}/multirun",
          fusion: "/api/sessions/{sessionId}/fuse",
          walkthrough: "/api/sessions/{sessionId}/walkthrough",
          review: "/api/sessions/{sessionId}/review/generate",
          knowledge: "/api/sessions/{sessionId}/knowledge",
          terminal: "/api/terminals (body.sessionId)",
          files: "/api/files/*?sessionId={sessionId}",
          git: "/api/git/*?sessionId={sessionId}",
        },
      });
      return true;
    }

    if (path === "/api/agent/backend-sessions" && method === "GET") {
      if (!sessions.backendSessions) return unsupported("backend session import is unavailable");
      const projectId = url.searchParams.get("projectId") ?? "";
      if (!projectId) return invalid("projectId is required");
      json(200, await sessions.backendSessions(projectId));
      return true;
    }

    if (path === "/api/agent/backend-sessions/import" && method === "POST") {
      if (!sessions.importBackendSessions) return unsupported("backend session import is unavailable");
      const input = await body();
      if (typeof input.projectId !== "string" || !input.projectId) return invalid("projectId is required");
      if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.some((id) => typeof id !== "string" || !id)) {
        return invalid("ids must be a non-empty array of strings");
      }
      if (input.ids.length > MAX_IMPORT_BATCH) return invalid(`at most ${MAX_IMPORT_BATCH} sessions per import`);
      const imported = await sessions.importBackendSessions(input.projectId, input.ids as string[]);
      await recordNotificationRecipient(deps.onSessionsImported
        ? () => deps.onSessionsImported!(imported.map((session) => session.id), space)
        : undefined);
      json(200, imported);
      return true;
    }

    if (path === "/api/agent/projects" && method === "GET") {
      const [projectRows, sessionRows] = await Promise.all([projects.list(), sessions.list()]);
      json(200, { projects: projectInventory(projectRows, sessionRows) });
      return true;
    }

    if (path === "/api/agent/sessions" && method === "GET") {
      const limit = integerQuery(url, "limit", 50, 1, 200);
      const offset = integerQuery(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const recentEventLimit = integerQuery(url, "recentEvents", 3, 0, 10);
      const updatedAfter = integerQuery(url, "updatedAfter", 0, 0, Number.MAX_SAFE_INTEGER);
      const archived = url.searchParams.get("archived") ?? "include";
      if (!["include", "exclude", "only"].includes(archived)) {
        return invalid("archived must be include, exclude, or only");
      }
      const requestedStatuses = (url.searchParams.get("status") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (requestedStatuses.some((status) => !SESSION_STATUSES.has(status))) {
        return invalid("status contains an unknown session status");
      }
      const statusFilter = new Set(requestedStatuses);
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const [projectRows, allSessions] = await Promise.all([projects.list(), sessions.list()]);
      let filtered = allSessions
        .filter((session) => !projectId || session.projectId === projectId)
        .filter((session) => session.updatedAt >= updatedAfter)
        .filter((session) => archived === "include"
          || (archived === "only" ? session.status === "archived" : session.status !== "archived"))
        .filter((session) => statusFilter.size === 0 || statusFilter.has(session.status))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const total = filtered.length;
      filtered = filtered.slice(offset, offset + limit);
      const projectById = new Map(projectRows.map((project) => [project.id, project]));
      const summaries = await Promise.all(filtered.map(async (session) => {
        const events = await store.events(session.id);
        return {
          session,
          project: projectById.get(session.projectId) ?? null,
          eventCount: events.length,
          latestSeq: events.at(-1)?.seq ?? 0,
          recentEvents: recentEventLimit > 0 ? events.slice(-recentEventLimit) : [],
        };
      }));
      const response: AgentSessionListDto = {
        projects: projectInventory(projectRows, allSessions),
        sessions: summaries,
        total,
        limit,
        offset,
      };
      json(200, response);
      return true;
    }

    if (path === "/api/agent/sessions" && method === "POST") {
      const input = await body();
      if (typeof input.projectId !== "string" || !input.projectId) {
        return invalid("projectId is required");
      }
      const model = modelInput(input.model);
      const harness = harnessInput(input.harness);
      const title = agentSessionTitle(input);
      const agent = optionalString(input, "agent");
      const parentId = optionalString(input, "parentId");
      const worktreePath = optionalString(input, "worktreePath");
      const createInput = {
        projectId: input.projectId,
        ...(harness ? { harness } : {}),
        title,
        ...(model ? { model } : {}),
        ...(agent !== undefined ? { agent } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(worktreePath !== undefined ? { worktreePath } : {}),
      };
      const ref = await sessions.create(createInput);
      await recordNotificationRecipient(deps.onSessionCreated
        ? () => deps.onSessionCreated!(ref.id, space, parentId)
        : undefined);
      let sendResult: unknown;
      if (input.message !== undefined) {
        const message = typeof input.message === "string"
          ? { text: input.message, autoTitle: true }
          : input.message && typeof input.message === "object" && !Array.isArray(input.message)
            ? input.message as Record<string, unknown>
            : invalid("message must be a string or object");
        sendResult = await sessions.send(ref.id, messageInput(message));
      }
      json(201, {
        session: await sessions.snapshot(ref.id),
        ...(sendResult !== undefined ? { sendResult } : {}),
        links: sessionLinks(ref.id),
      });
      return true;
    }

    const match = path.match(/^\/api\/agent\/sessions\/([^/]+)(\/.*)?$/);
    if (!match) return false;
    const sessionId = pathId(match[1]!);
    const suffix = match[2] ?? "";

    if (suffix === "" && method === "GET") {
      const eventLimit = integerQuery(url, "eventLimit", 100, 1, 500);
      const { session, project } = await context(sessionId);
      const allEvents = await sessions.events(sessionId);
      const events = allEvents.slice(-eventLimit);
      const response: AgentSessionDetailDto = {
        session,
        project,
        events,
        messages: deriveMessages(allEvents),
        state: await debug(session, allEvents),
        eventWindow: {
          total: allEvents.length,
          returned: events.length,
          ...(allEvents.length > events.length && events[0]
            ? { truncatedBeforeSeq: events[0].seq }
            : {}),
        },
        links: sessionLinks(sessionId),
      };
      json(200, response);
      return true;
    }

    if (suffix === "/events" && method === "GET") {
      await sessions.snapshot(sessionId);
      const afterSeq = integerQuery(url, "afterSeq", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = integerQuery(url, "limit", 200, 1, 1000);
      const available = await sessions.events(sessionId, afterSeq);
      const events = available.slice(0, limit);
      json(200, {
        sessionId,
        events,
        afterSeq,
        returned: events.length,
        hasMore: available.length > events.length,
        nextAfterSeq: events.at(-1)?.seq ?? afterSeq,
      });
      return true;
    }

    if (suffix === "/messages" && method === "GET") {
      await sessions.snapshot(sessionId);
      const events = await sessions.events(sessionId);
      json(200, { sessionId, messages: deriveMessages(events), eventCount: events.length });
      return true;
    }

    if (suffix === "/debug" && method === "GET") {
      const { session, project } = await context(sessionId);
      json(200, {
        session,
        project,
        debug: await debug(session),
        server: {
          version: deps.version ?? "unknown",
          capabilities: deps.capabilities?.() ?? [],
        },
      });
      return true;
    }

    if (suffix === "" && method === "PATCH") {
      const input = await body();
      let changed = false;
      if (input.title !== undefined) {
        if (!sessions.rename) return unsupported("session rename is unavailable");
        if (typeof input.title !== "string") return invalid("title must be a string");
        await sessions.rename(sessionId, input.title);
        changed = true;
      }
      const patch: SessionOrganizePatch = {};
      if (input.folderId !== undefined) {
        if (input.folderId !== null && typeof input.folderId !== "string") {
          return invalid("folderId must be a string or null");
        }
        patch.folderId = input.folderId as string | null;
      }
      if (input.labelIds !== undefined) {
        if (!Array.isArray(input.labelIds)
          || input.labelIds.some((value) => typeof value !== "string")) {
          return invalid("labelIds must be an array of strings");
        }
        patch.labelIds = input.labelIds as string[];
      }
      if (input.pinned !== undefined) {
        if (input.pinned !== null
          && (!input.pinned || typeof input.pinned !== "object" || Array.isArray(input.pinned))) {
          return invalid("pinned must contain a position or be null");
        }
        patch.pinned = input.pinned as { position: number } | null;
      }
      if (Object.keys(patch).length > 0) {
        if (!sessions.organize) return unsupported("session organization is unavailable");
        await sessions.organize(sessionId, patch);
        changed = true;
      }
      if (!changed) return invalid("no supported session fields supplied");
      json(200, { session: await sessions.snapshot(sessionId), links: sessionLinks(sessionId) });
      return true;
    }

    if (suffix === "" && method === "DELETE") {
      if (!sessions.delete) return unsupported("session deletion is unavailable");
      await sessions.delete(sessionId);
      json(200, { ok: true, sessionId });
      return true;
    }

    const lifecycle = suffix.match(/^\/(cancel|archive|unarchive)$/);
    if (lifecycle && method === "POST") {
      if (lifecycle[1] === "cancel") {
        await sessions.abort(sessionId, { source: "agent" });
        json(200, { ok: true, sessionId });
      } else {
        await (lifecycle[1] === "archive"
          ? sessions.archive(sessionId)
          : sessions.restore(sessionId));
        json(200, { session: await sessions.snapshot(sessionId), links: sessionLinks(sessionId) });
      }
      return true;
    }

    if (suffix === "/compact" && method === "POST") {
      if (!sessions.compact) return unsupported("session compaction is unavailable");
      await sessions.compact(sessionId);
      json(200, { ok: true, sessionId });
      return true;
    }

    if (suffix === "/runtime-epoch" && method === "POST") {
      if (!sessions.confirmBorrowedRuntimeEpoch) {
        return unsupported("runtime epoch confirmation is unavailable");
      }
      const input = await body();
      if (input.confirm !== true) return invalid("confirm must be true");
      json(200, await sessions.confirmBorrowedRuntimeEpoch(sessionId));
      return true;
    }

    if (suffix === "/messages" && method === "POST") {
      const sendResult = await sessions.send(sessionId, messageInput(await body()));
      json(200, { sessionId, sendResult });
      return true;
    }

    if (suffix === "/fork" && method === "POST") {
      const input = await body();
      const atSeq = input.atSeq === undefined ? undefined : Number(input.atSeq);
      if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq <= 0)) {
        return invalid("atSeq must be a positive integer");
      }
      const result = await sessions.fork(sessionId, atSeq);
      await recordNotificationRecipient(deps.onSessionForked
        ? () => deps.onSessionForked!(sessionId, result.id, space)
        : undefined);
      json(201, { ...result, links: sessionLinks(result.id) });
      return true;
    }

    if (suffix === "/rewind" && method === "POST") {
      if (!sessions.rewind) return unsupported("session rewind is unavailable");
      const input = await body();
      const atSeq = Number(input.atSeq);
      if (!Number.isSafeInteger(atSeq) || atSeq <= 0) {
        return invalid("atSeq must be a positive integer");
      }
      json(200, await sessions.rewind(sessionId, atSeq));
      return true;
    }

    if (suffix === "/rewind/clear" && method === "POST") {
      if (!sessions.clearRewind) return unsupported("session rewind is unavailable");
      json(200, await sessions.clearRewind(sessionId));
      return true;
    }

    const pin = suffix.match(/^\/context\/pins\/(\d+)$/);
    if (pin && (method === "POST" || method === "DELETE")) {
      const seq = Number(pin[1]);
      const operation = method === "POST" ? sessions.pinContext : sessions.unpinContext;
      if (!operation) return unsupported("message pinning is unavailable");
      json(200, await operation.call(sessions, sessionId, seq));
      return true;
    }

    if (suffix === "/queue" && method === "GET") {
      json(200, { sessionId, items: await sessions.queueList?.(sessionId) ?? [] });
      return true;
    }

    if (suffix === "/queue" && method === "PATCH") {
      if (!sessions.queueReorder) return unsupported("queue reordering is unavailable");
      const input = await body();
      if (!Array.isArray(input.ids) || input.ids.some((id) => typeof id !== "string")) {
        return invalid("ids must be an array of strings");
      }
      json(200, { sessionId, items: await sessions.queueReorder(sessionId, input.ids as string[]) });
      return true;
    }

    const queueItem = suffix.match(/^\/queue\/([^/]+)$/);
    if (queueItem && method === "PATCH") {
      if (!sessions.queueEdit) return unsupported("queue editing is unavailable");
      const input = await body();
      if (typeof input.text !== "string") return invalid("text must be a string");
      json(200, await sessions.queueEdit(sessionId, pathId(queueItem[1]!), input.text));
      return true;
    }
    if (queueItem && method === "DELETE") {
      if (!sessions.queueRemove) return unsupported("queue removal is unavailable");
      await sessions.queueRemove(sessionId, pathId(queueItem[1]!));
      json(200, { ok: true, sessionId });
      return true;
    }

    if (suffix === "/permissions/auto-accept" && method === "GET") {
      if (!sessions.autoAcceptGet) return unsupported("auto-accept is unavailable");
      json(200, await sessions.autoAcceptGet(sessionId));
      return true;
    }
    if (suffix === "/permissions/auto-accept" && method === "PATCH") {
      if (!sessions.autoAcceptSet) return unsupported("auto-accept is unavailable");
      const input = await body();
      if (!["on", "off", "inherit"].includes(String(input.setting))) {
        return invalid("setting must be on, off, or inherit");
      }
      json(200, await sessions.autoAcceptSet(sessionId, input.setting as AutoAcceptSetting));
      return true;
    }

    const permission = suffix.match(/^\/permissions\/([^/]+)$/);
    if (permission && method === "POST") {
      const input = await body();
      if (!["once", "always", "reject"].includes(String(input.reply))) {
        return invalid("reply must be once, always, or reject");
      }
      if (input.scope !== undefined && input.scope !== "session" && input.scope !== "project") {
        return invalid("scope must be session or project");
      }
      await sessions.replyPermission(
        sessionId,
        pathId(permission[1]!),
        input.reply as "once" | "always" | "reject",
        input.scope as "session" | "project" | undefined,
      );
      json(200, { ok: true, sessionId });
      return true;
    }

    const question = suffix.match(/^\/questions\/([^/]+)$/);
    if (question && method === "POST") {
      const input = await body();
      const answers = input.reject === true
        ? { __reject: true }
        : input.answers && typeof input.answers === "object" && !Array.isArray(input.answers)
          ? input.answers as JsonObject
          : invalid("answers must be an object, or reject must be true");
      await sessions.replyQuestion(sessionId, pathId(question[1]!), answers);
      json(200, { ok: true, sessionId });
      return true;
    }

    const secret = suffix.match(/^\/secrets\/([^/]+)$/);
    if (secret && method === "POST") {
      if (!sessions.replySecret) return unsupported("Secure Safe is unavailable");
      const input = await body();
      if (input.action === "save") {
        if (typeof input.value !== "string" || !input.value.trim()) {
          return invalid("value is required");
        }
        await sessions.replySecret(sessionId, pathId(secret[1]!), {
          action: "save",
          value: input.value,
        });
      } else if (input.action === "dismiss") {
        await sessions.replySecret(sessionId, pathId(secret[1]!), { action: "dismiss" });
      } else {
        return invalid("action must be save or dismiss");
      }
      json(200, { ok: true, sessionId });
      return true;
    }

    const goalMatch = suffix.match(/^\/goal(?:\/(pause|resume|stop))?$/);
    if (goalMatch) {
      const service = await goal(sessionId);
      const action = goalMatch[1];
      if (!action && method === "GET") {
        json(200, service.get(sessionId));
        return true;
      }
      if (!action && method === "POST") {
        const input = await body();
        if (typeof input.objective !== "string") return invalid("objective must be a string");
        json(200, await service.attach(sessionId, {
          objective: input.objective,
          ...(input.budgetTokens !== undefined
            ? { budgetTokens: Number(input.budgetTokens) }
            : {}),
          ...(input.maxContinuations !== undefined
            ? { maxContinuations: Number(input.maxContinuations) }
            : {}),
        }));
        return true;
      }
      if (action && method === "POST") {
        if (action === "stop") {
          await service.stop(sessionId);
          json(200, { ok: true, sessionId });
        } else {
          json(200, action === "pause"
            ? await service.pause(sessionId)
            : await service.resume(sessionId));
        }
        return true;
      }
    }

    if (suffix === "/shell" && method === "POST") {
      if (!sessions.runShell) return unsupported("composer shell is unavailable");
      const input = await body();
      if (typeof input.command !== "string") return invalid("command must be a string");
      json(200, await sessions.runShell(sessionId, input.command));
      return true;
    }

    return false;
  };
}
