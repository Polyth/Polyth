import {
  CAP,
  roleAtLeast,
  type AgentCapabilityContributionRegistry,
  type CreateSessionInput,
  type Disposable,
  type HarnessSelection,
  type JsonObject,
  type ModelRef,
  type RouteHandler,
  type RouteRequest,
  type SecureSafeService,
  type SessionEvent,
  type SessionProjection,
  type SpaceContext,
  type TaskSelectedData,
  type TaskTrackerProvider,
  type TaskTrackerService,
  type TaskTrackerTaskDto,
  type UserTurnInput,
} from "@polyth/contracts";
import { hasInstanceOwnerAuthority } from "@polyth/contracts/instance-authority";
import {
  localOnlyRemoteAccess,
  serverServiceKey,
  type ServerPackage,
  type ServerPackageHost,
} from "@polyth/plugins";
import {
  buildTaskWorkPrompt,
  createTaskTrackerService,
  isTaskTrackerProvider,
  reduceTaskLifecycle,
} from "./index.ts";
import {
  createTaskTrackerManagement,
  type TaskTrackerManagement,
  type TrackerAccess,
  type TrackerActor,
} from "./management.ts";
import { createTaskAgentTools, taskSkill, TASK_TRACKERS_PACKAGE_ID } from "./agentTool.ts";
import {
  TASK_TRACKER_PROVIDERS,
  type TaskTrackerConnectionScope,
  type TaskTrackerDispatchResultDto,
  type TaskTrackerPreferencesPatch,
} from "./types.ts";

/** One dispatch starts at most this many agent sessions. */
export const MAX_DISPATCH = 10;

const invalid = (message: string, field?: string): Error =>
  Object.assign(new Error(message), {
    code: "invalid-input",
    ...(field ? { field } : {}),
  });

const providerOf = (value: string | null): TaskTrackerProvider => {
  if (!value || !isTaskTrackerProvider(value)) {
    throw invalid(`provider must be ${TASK_TRACKER_PROVIDERS.join(", ")}`, "provider");
  }
  return value;
};

/** The provider segment of a tracker route. */
const P = `(${TASK_TRACKER_PROVIDERS.join("|")})`;
const route = (pattern: string): RegExp => new RegExp(`^/api/task-trackers/${pattern}$`);
const CONNECTION = route(`connections/${P}(/verify)?`);
const CREATE_TASK = route(`${P}/tasks`);
const ATTACHMENTS = route(`${P}/tasks/([^/]+)/attachments`);
const ATTACHMENT_CONTENT = route(`${P}/tasks/([^/]+)/attachments/([^/]+)/content`);
const COMMENTS = route(`${P}/tasks/([^/]+)/comments`);
const CREATE_BOARD = route(`${P}/boards`);
const VIEWER = route(`${P}/me`);
const TASK = route(`${P}/tasks/([^/]+)`);
const COLUMNS = route(`${P}/boards/([^/]+)/columns`);
const COLUMN = route(`${P}/boards/([^/]+)/columns/([^/]+)`);
const MOVE = route(`${P}/tasks/([^/]+)/move`);
const ARCHIVE = route(`${P}/tasks/([^/]+)/archive`);
const LINK = route(`${P}/tasks/([^/]+)/link`);

const pathPart = (value: string | undefined, field: string): string => {
  if (!value) throw invalid(`${field} is required`, field);
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.trim() || decoded.includes("/")) throw new Error();
    return decoded;
  } catch {
    throw invalid(`${field} is invalid`, field);
  }
};

const selectedData = (task: TaskTrackerTaskDto): TaskSelectedData => ({
  provider: task.provider,
  taskId: task.id,
  taskKey: task.key,
  title: task.title,
  ...(task.url ? { url: task.url } : {}),
  statusId: task.status.id,
  statusName: task.status.name,
});

/** A feature or setting refused the request before anything was written. */
const unavailable = (message: string): Error =>
  Object.assign(new Error(message), { code: "unavailable", mutationOutcome: "not-started" });

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

const forbidden = (message: string): Error =>
  Object.assign(new Error(message), { code: "forbidden" });

/** Tracker writes and agent work need at least the member role. */
const requireMember = (request: RouteRequest): void => {
  if (request.space && !roleAtLeast(request.space.role, "member")) {
    throw forbidden("Your Space role can view tasks but not change them");
  }
};

const scopeOf = (value: unknown): TaskTrackerConnectionScope =>
  value === "personal" ? "personal" : "space";

/**
 * The env (`JIRA_*` / `TRELLO_*`) account belongs to the installation: only
 * the instance owner on `local-trusted` may use it, never other members.
 */
export const requestAccess = (request: RouteRequest): TrackerAccess => ({
  installationOwner: request.space?.deployment === "local-trusted"
    && Boolean(request.principal)
    && hasInstanceOwnerAuthority(request),
});

const harnessOf = (value: unknown): HarnessSelection | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (item.mode === "auto") return { mode: "auto" };
  if (item.mode === "pinned" && typeof item.harnessId === "string" && item.harnessId.trim()) {
    return { mode: "pinned", harnessId: item.harnessId.trim() };
  }
  return undefined;
};

const modelOf = (value: unknown): ModelRef | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.providerID !== "string" || typeof item.modelID !== "string") return undefined;
  if (!item.providerID.trim() || !item.modelID.trim()) return undefined;
  return {
    providerID: item.providerID,
    modelID: item.modelID,
    ...(typeof item.variant === "string" && item.variant ? { variant: item.variant } : {}),
  };
};

/** The task after a write. The write already happened, so a failed read
 *  must not turn into an error a caller would retry into a duplicate. */
const reread = async (
  trackers: TaskTrackerService,
  provider: TaskTrackerProvider,
  taskId: string,
): Promise<{ task?: TaskTrackerTaskDto }> => {
  try {
    return { task: await trackers.getTask(provider, taskId) };
  } catch {
    return {};
  }
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error && cause.message ? cause.message : "Couldn’t start this task";

interface TaskTrackerRouteDeps {
  /** A fixed service, or one resolved per request from the caller's Space. */
  trackers: TaskTrackerService | ((request: RouteRequest) => TaskTrackerService);
  /** Settings and connections; absent in narrow route tests. */
  management?: TaskTrackerManagement;
  snapshot(sessionId: string, request: RouteRequest): Promise<SessionProjection>;
  events(sessionId: string): Promise<SessionEvent[]>;
  append(sessionId: string, type: string, data: JsonObject): Promise<SessionEvent>;
  send(sessionId: string, input: UserTurnInput, request: RouteRequest): Promise<unknown>;
  /** Creates a session in the caller's Space; absent disables dispatch. */
  create?(input: CreateSessionInput, request: RouteRequest): Promise<{ id: string }>;
}

const patchOf = (input: Record<string, unknown>): TaskTrackerPreferencesPatch => {
  const patch: TaskTrackerPreferencesPatch = {};
  const flags = (value: unknown): Record<string, boolean> | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] =>
      typeof entry[1] === "boolean"));
  };
  const providers = flags(input.providers);
  const widgets = flags(input.widgets);
  if (providers) patch.providers = providers;
  if (widgets) patch.widgets = widgets;
  for (const key of ["demo", "agentHandoff", "statusUpdates"] as const) {
    if (typeof input[key] === "boolean") patch[key] = input[key];
  }
  return patch;
};

export function taskTrackerRoutes(deps: TaskTrackerRouteDeps): RouteHandler {
  const session = async (sessionId: string, request: RouteRequest): Promise<SessionProjection> => {
    try {
      return await deps.snapshot(sessionId, request);
    } catch {
      throw Object.assign(new Error("session not found"), { code: "not-found" });
    }
  };

  return async (request) => {
    const { path, method, url, body, json } = request;
    if (!path.startsWith("/api/task-trackers")) return false;
    const trackers = typeof deps.trackers === "function" ? deps.trackers(request) : deps.trackers;
    const preferences = deps.management && request.space
      ? deps.management.preferences(request.space)
      : null;
    const access = requestAccess(request);

    if (deps.management && path === "/api/task-trackers/settings") {
      if (method === "GET") {
        json(200, deps.management.state(request.space, access));
        return true;
      }
      if (method === "PATCH") {
        json(200, deps.management.updatePreferences(request.space, patchOf(await body()), access));
        return true;
      }
    }

    // May agents and system work use the Space service accounts? Admin-only.
    if (deps.management && path === "/api/task-trackers/service-policy") {
      if (method === "GET") {
        json(200, deps.management.servicePolicy(request.space));
        return true;
      }
      if (method === "PUT") {
        const input = await body();
        if (typeof input.agentsMayUseService !== "boolean") {
          throw invalid("agentsMayUseService must be true or false", "agentsMayUseService");
        }
        json(200, deps.management.setServicePolicy(request.space, { agentsMayUseService: input.agentsMayUseService }, access));
        return true;
      }
    }

    // Turn one of the caller's own accounts on or off in this Space.
    const personal = path.match(/^\/api\/task-trackers\/personal-connections\/([^/]+)\/enabled$/);
    if (deps.management && personal && method === "PUT") {
      const connectionId = pathPart(personal[1], "connectionId");
      const input = await body();
      if (typeof input.enabled !== "boolean") throw invalid("enabled must be true or false", "enabled");
      json(200, deps.management.setPersonalEnabled(request.space, connectionId, input.enabled, access));
      return true;
    }

    const connection = path.match(CONNECTION);
    if (deps.management && connection) {
      const provider = providerOf(connection[1] ?? null);
      const scope = scopeOf(url.searchParams.get("scope"));
      const connectionId = url.searchParams.get("id") || undefined;
      const callOptions = { ...access, ...(connectionId ? { connectionId } : {}) };
      if (method === "POST" && connection[2]) {
        json(200, await deps.management.verify(request.space, provider, scope, callOptions));
        return true;
      }
      if (method === "POST") {
        const input = await body();
        json(200, provider === "jira"
          ? await deps.management.connectJira(request.space, {
              site: String(input.site ?? ""),
              email: String(input.email ?? ""),
              apiToken: String(input.apiToken ?? ""),
            }, scope, access)
          : provider === "trello"
            ? await deps.management.connectTrello(request.space, {
                apiKey: String(input.apiKey ?? ""),
                token: String(input.token ?? ""),
              }, scope, access)
            : await deps.management.connectLinear(request.space, {
                apiKey: String(input.apiKey ?? ""),
              }, scope, access));
        return true;
      }
      if (method === "DELETE" && !connection[2]) {
        json(200, deps.management.disconnect(request.space, provider, scope, callOptions));
        return true;
      }
    }

    if (deps.management && path === "/api/task-trackers/links" && method === "GET") {
      json(200, deps.management.links(request.space));
      return true;
    }

    if (path === "/api/task-trackers/dispatch" && method === "POST") {
      requireMember(request);
      if (!deps.create) throw unavailable("Starting agent sessions is not available on this server");
      if (preferences && !preferences.agentHandoff) {
        throw unavailable("Agent handoff is turned off in Task tracker settings");
      }
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      if (!projectId) throw invalid("projectId is required", "projectId");
      const items = Array.isArray(input.tasks) ? input.tasks : [];
      if (items.length === 0) throw invalid("Choose at least one task", "tasks");
      if (items.length > MAX_DISPATCH) throw invalid(`Send at most ${MAX_DISPATCH} tasks at once`, "tasks");
      const targets = items.map((item) => {
        const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return {
          provider: providerOf(typeof record.provider === "string" ? record.provider : null),
          taskId: String(record.taskId ?? "").trim() || (() => { throw invalid("taskId is required", "tasks"); })(),
        };
      });
      const instructions = String(input.instructions ?? "").slice(0, 2000);
      const harness = harnessOf(input.harness);
      const model = modelOf(input.model);
      const results: TaskTrackerDispatchResultDto[] = [];
      // Sequential on purpose: each task becomes its own durable session, and
      // one failure must not hide which of the others already started.
      for (const target of targets) {
        let task: TaskTrackerTaskDto | undefined;
        try {
          task = await trackers.getTask(target.provider, target.taskId);
          const created = await deps.create({
            projectId,
            title: `${task.key} · ${task.title}`.slice(0, 120),
            ...(harness ? { harness } : {}),
            ...(model ? { model } : {}),
          }, request);
          await deps.append(created.id, "task/selected", { ...selectedData(task) });
          deps.management?.recordLink(request.space, {
            provider: task.provider,
            taskId: task.id,
            taskKey: task.key,
            sessionId: created.id,
          });
          await deps.send(created.id, {
            text: buildTaskWorkPrompt(task, instructions),
            ...(model ? { model } : {}),
          }, request);
          results.push({ provider: task.provider, taskId: task.id, taskKey: task.key, sessionId: created.id });
        } catch (cause) {
          results.push({
            ...target,
            ...(task ? { taskKey: task.key } : {}),
            error: messageOf(cause),
          });
        }
      }
      json(200, { results });
      return true;
    }

    const create = path.match(CREATE_TASK);
    if (create && method === "POST") {
      requireMember(request);
      const provider = providerOf(create[1] ?? null);
      if (!trackers.createTask) throw unavailable("Creating tasks is not available on this server");
      const input = await body();
      const projectId = String(input.projectId ?? "").trim();
      const boardId = String(input.boardId ?? "").trim();
      json(200, await trackers.createTask(provider, {
        title: String(input.title ?? ""),
        description: String(input.description ?? ""),
        ...(projectId ? { projectId } : {}),
        ...(boardId ? { boardId } : {}),
      }));
      return true;
    }
    const attach = path.match(ATTACHMENTS);
    if (attach && method === "POST") {
      requireMember(request);
      const provider = providerOf(attach[1] ?? null);
      if (!trackers.addAttachments) throw unavailable("Attaching images is not available on this server");
      const input = await body();
      const taskId = pathPart(attach[2], "taskId");
      await trackers.addAttachments(provider, taskId, Array.isArray(input.files) ? input.files : []);
      json(200, { ok: true, ...await reread(trackers, provider, taskId) });
      return true;
    }
    const content = path.match(ATTACHMENT_CONTENT);
    if (content && method === "GET") {
      const provider = providerOf(content[1] ?? null);
      if (!trackers.attachmentContent) throw unavailable("Attachment previews are not available on this server");
      const file = await trackers.attachmentContent(
        provider,
        pathPart(content[2], "taskId"),
        pathPart(content[3], "attachmentId"),
        url.searchParams.get("preview") === "1",
      );
      // Tracker files are untrusted: raster images render inline, everything
      // else downloads, and nothing served here may run script.
      const inline = INLINE_IMAGE_TYPES.has(file.mimeType);
      request.res.writeHead(200, {
        "content-type": inline ? file.mimeType : "application/octet-stream",
        "content-length": String(file.bytes.length),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
        // An attachment id names one immutable upload, so the browser keeps it
        // for a day instead of re-reading every cover when a board reopens.
        "cache-control": "private, max-age=86400",
      });
      request.res.end(Buffer.from(file.bytes));
      return true;
    }
    const comment = path.match(COMMENTS);
    if (comment && method === "POST") {
      requireMember(request);
      const provider = providerOf(comment[1] ?? null);
      if (!trackers.addComment) throw unavailable("Commenting is not available on this server");
      const input = await body();
      const text = String(input.text ?? "").trim();
      if (!text) throw invalid("text is required", "text");
      const taskId = pathPart(comment[2], "taskId");
      await trackers.addComment(provider, taskId, text);
      json(200, { ok: true, ...await reread(trackers, provider, taskId) });
      return true;
    }
    const createBoard = path.match(CREATE_BOARD);
    if (createBoard && method === "POST") {
      requireMember(request);
      const provider = providerOf(createBoard[1] ?? null);
      if (!trackers.createBoard) throw unavailable("Creating boards is not available on this server");
      const input = await body();
      const name = String(input.name ?? "").trim();
      if (!name) throw invalid("name is required", "name");
      const projectId = String(input.projectId ?? "").trim();
      json(200, await trackers.createBoard(provider, {
        name,
        ...(projectId ? { projectId } : {}),
        ...(input.type === "scrum" || input.type === "kanban" ? { type: input.type } : {}),
      }));
      return true;
    }
    if (path === "/api/task-trackers/providers" && method === "GET") {
      json(200, trackers.providers());
      return true;
    }

    const viewer = path.match(VIEWER);
    if (viewer && method === "GET") {
      if (!trackers.currentUser) throw unavailable("The connected account can’t be named on this server");
      json(200, await trackers.currentUser(providerOf(viewer[1] ?? null)));
      return true;
    }

    if (path === "/api/task-trackers/projects" && method === "GET") {
      json(200, await trackers.listProjects(providerOf(url.searchParams.get("provider"))));
      return true;
    }

    if (path === "/api/task-trackers/boards" && method === "GET") {
      json(200, await trackers.listBoards(
        providerOf(url.searchParams.get("provider")),
        url.searchParams.get("projectId") ?? undefined,
      ));
      return true;
    }

    if (path === "/api/task-trackers/tasks" && method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      json(200, await trackers.listTasks(
        providerOf(url.searchParams.get("provider")),
        {
          ...(url.searchParams.get("boardId")
            ? { boardId: url.searchParams.get("boardId")! }
            : {}),
          ...(url.searchParams.get("projectId")
            ? { projectId: url.searchParams.get("projectId")! }
            : {}),
          ...(rawLimit !== null ? { limit: Number(rawLimit) } : {}),
        },
      ));
      return true;
    }

    let match = path.match(/^\/api\/task-trackers\/sessions\/([^/]+)\/tasks$/);
    if (match && method === "GET") {
      const sessionId = pathPart(match[1], "sessionId");
      await session(sessionId, request);
      json(200, reduceTaskLifecycle(await deps.events(sessionId)));
      return true;
    }

    match = path.match(TASK);
    if (match && method === "GET") {
      json(200, await trackers.getTask(
        providerOf(match[1] ?? null),
        pathPart(match[2], "taskId"),
      ));
      return true;
    }

    if (match && method === "PATCH") {
      const provider = providerOf(match[1] ?? null);
      const taskId = pathPart(match[2], "taskId");
      const input = await body();
      const statusId = typeof input.statusId === "string" ? input.statusId.trim() : "";
      const sessionId = String(input.sessionId ?? "").trim();
      const hasTitle = typeof input.title === "string";
      const hasDescription = typeof input.description === "string";
      requireMember(request);
      if (!statusId && !hasTitle && !hasDescription) {
        throw invalid("statusId, title, or description is required", "statusId");
      }
      if (statusId && preferences && !preferences.statusUpdates) {
        throw unavailable("Tracker status updates are turned off in Task tracker settings");
      }
      // The board changes a status without a session; a session, when given,
      // records the change.
      if (sessionId) await session(sessionId, request);

      let current: TaskTrackerTaskDto | undefined;
      if (hasTitle || hasDescription) {
        if (!trackers.updateTask) throw unavailable("Updating tasks is not available on this server");
        current = await trackers.updateTask(provider, taskId, {
          ...(hasTitle ? { title: String(input.title) } : {}),
          ...(hasDescription ? { description: String(input.description) } : {}),
        });
      }

      if (statusId) {
        const previous = current ?? await trackers.getTask(provider, taskId);
        const updated = await trackers.updateStatus(provider, taskId, statusId);
        if (!sessionId) {
          json(200, updated);
          return true;
        }
        await deps.append(sessionId, "task/status-changed", {
          ...selectedData(updated),
          previousStatusId: previous.status.id,
          previousStatusName: previous.status.name,
        });
        if (
          updated.status.category === "done"
          && previous.status.category !== "done"
        ) {
          await deps.append(sessionId, "task/completed", {
            ...selectedData(updated),
          });
        }
        json(200, updated);
        return true;
      }

      json(200, current);
      return true;
    }

    const columnInput = (input: Record<string, unknown>, requireName: boolean) => {
      const name = typeof input.name === "string" ? input.name.trim() : undefined;
      if (requireName && !name) throw invalid("name is required", "name");
      if (input.name !== undefined && !name) throw invalid("name can't be empty", "name");
      const position = input.position;
      if (position !== undefined && (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0)) {
        throw invalid("position must be a non-negative integer", "position");
      }
      return {
        ...(name !== undefined ? { name } : {}),
        ...(typeof position === "number" ? { position } : {}),
      };
    };
    match = path.match(COLUMNS);
    if (match && (method === "GET" || method === "POST")) {
      const provider = providerOf(match[1] ?? null);
      const boardId = pathPart(match[2], "boardId");
      if (method === "GET") {
        if (!trackers.listColumns) throw unavailable("Board columns are not available on this server");
        json(200, await trackers.listColumns(provider, boardId));
        return true;
      }
      requireMember(request);
      if (!trackers.createColumn) throw unavailable("Adding columns is not available on this server");
      json(200, await trackers.createColumn(provider, boardId, columnInput(await body(), true)));
      return true;
    }
    match = path.match(COLUMN);
    if (match && (method === "PATCH" || method === "DELETE")) {
      const provider = providerOf(match[1] ?? null);
      const boardId = pathPart(match[2], "boardId");
      const columnId = pathPart(match[3], "columnId");
      requireMember(request);
      if (method === "PATCH") {
        if (!trackers.updateColumn) throw unavailable("Editing columns is not available on this server");
        json(200, await trackers.updateColumn(provider, boardId, columnId, columnInput(await body(), false)));
        return true;
      }
      if (!trackers.removeColumn) throw unavailable("Removing columns is not available on this server");
      await trackers.removeColumn(provider, boardId, columnId);
      json(200, { ok: true });
      return true;
    }
    match = path.match(MOVE);
    if (match && method === "POST") {
      const provider = providerOf(match[1] ?? null);
      const taskId = pathPart(match[2], "taskId");
      const input = await body();
      const boardId = String(input.boardId ?? "").trim();
      const columnId = String(input.columnId ?? "").trim();
      const sessionId = String(input.sessionId ?? "").trim();
      requireMember(request);
      if (!boardId) throw invalid("boardId is required", "boardId");
      if (!columnId) throw invalid("columnId is required", "columnId");
      if (preferences && !preferences.statusUpdates) {
        throw unavailable("Tracker status updates are turned off in Task tracker settings");
      }
      if (!trackers.moveTask) throw unavailable("Moving tasks is not available on this server");
      // A move from the board needs no session. With one (the task is linked
      // there), the session records the change like a status update.
      if (sessionId) await session(sessionId, request);
      const previous = sessionId ? await trackers.getTask(provider, taskId) : null;
      const updated = await trackers.moveTask(provider, taskId, boardId, columnId);
      if (sessionId && previous && previous.status.id !== updated.status.id) {
        await deps.append(sessionId, "task/status-changed", {
          ...selectedData(updated),
          previousStatusId: previous.status.id,
          previousStatusName: previous.status.name,
        });
        if (updated.status.category === "done" && previous.status.category !== "done") {
          await deps.append(sessionId, "task/completed", { ...selectedData(updated) });
        }
      }
      json(200, updated);
      return true;
    }
    match = path.match(ARCHIVE);
    if (match && method === "POST") {
      const provider = providerOf(match[1] ?? null);
      const taskId = pathPart(match[2], "taskId");
      requireMember(request);
      if (!trackers.archiveTask) throw unavailable("Archiving tasks is not available on this server");
      await trackers.archiveTask(provider, taskId);
      json(200, { ok: true });
      return true;
    }
    match = path.match(TASK);
    if (match && method === "DELETE") {
      const provider = providerOf(match[1] ?? null);
      const taskId = pathPart(match[2], "taskId");
      requireMember(request);
      if (!trackers.deleteTask) throw unavailable("Deleting tasks is not available on this server");
      await trackers.deleteTask(provider, taskId);
      json(200, { ok: true });
      return true;
    }

    match = path.match(LINK);
    if (match && method === "POST") {
      const provider = providerOf(match[1] ?? null);
      const taskId = pathPart(match[2], "taskId");
      const input = await body();
      const sessionId = String(input.sessionId ?? "").trim();
      requireMember(request);
      if (!sessionId) throw invalid("sessionId is required", "sessionId");
      if (preferences && !preferences.agentHandoff && input.startAgent !== false) {
        throw unavailable("Agent handoff is turned off in Task tracker settings");
      }
      await session(sessionId, request);
      const task = await trackers.getTask(provider, taskId);

      // Persist the semantic selection before either the model-visible prompt
      // or the initiating UI can observe success.
      await deps.append(sessionId, "task/selected", {
        ...selectedData(task),
      });
      deps.management?.recordLink(request.space, {
        provider: task.provider,
        taskId: task.id,
        taskKey: task.key,
        sessionId,
      });
      let turn: unknown;
      if (input.startAgent !== false) {
        turn = await deps.send(sessionId, {
          text: buildTaskWorkPrompt(task, String(input.instructions ?? "")),
        }, request);
      }
      json(200, {
        ok: true,
        task,
        sessionId,
        ...(turn !== undefined ? { turn } : {}),
      });
      return true;
    }

    return false;
  };
}

/**
 * The shared tracker service (`CAP.taskTrackers`, `task-trackers`). Its
 * `TaskTrackerService` methods name no caller, so they are system work outside
 * any Space: no account at all — never the installation's env account, which
 * is the instance owner's alone — only the sandbox. Callers that know who
 * they act for use `forPerson`/`forActor`, the routes' and agent tools' rules.
 */
export interface ScopedTaskTrackerService extends TaskTrackerService {
  /** A signed-in person's view: theirs, else the Space's, else (instance owner on local-trusted) env. */
  forPerson(space: SpaceContext): TaskTrackerService;
  /** Agent work for `actorUserId`; none is system work: the Space service account under policy only. */
  forActor(spaceId: string, actorUserId: string | undefined, provider: TaskTrackerProvider): TaskTrackerService;
}

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const management = createTaskTrackerManagement({
    storage: (space) => host.spaceStorage(space),
    vault: () => host.services.get(serverServiceKey<SecureSafeService>("secure-safe")),
    people: () => host.people,
  });
  const routes = taskTrackerRoutes({
    trackers: (request) => management.trackers(request.space, requestAccess(request)),
    management,
    // Validate the session inside the caller's Space before any append.
    snapshot: (sessionId, request) => host.forSpace(request.space).sessions.snapshot(sessionId),
    events: (sessionId) => host.store.events(sessionId),
    append: (sessionId, type, data) => host.events.append(
      sessionId,
      type,
      data,
      { ignorable: true, producerPlugin: host.pluginId },
    ),
    send: (sessionId, input, request) => host.forSpace(request.space).sessions.send(sessionId, input),
    create: (input, request) => host.forSpace(request.space).sessions.create(input),
  });
  const space = (spaceId: string) => host.systemSpaceContext(spaceId);
  // An agent acts for the person who sent the turn; no person means system
  // work. The env account stays the instance owner's on local-trusted.
  const agentActor = (spaceId: string, actorUserId: string | undefined): TrackerActor => {
    if (!actorUserId) return { origin: "system" };
    const context = host.deployment === "local-trusted"
      ? host.personSpaceContext?.(actorUserId, spaceId) as { instanceOwner?: boolean } | undefined
      : undefined;
    return { origin: "agent", userId: actorUserId, installationOwner: context?.instanceOwner === true };
  };
  const trackers: ScopedTaskTrackerService = {
    ...createTaskTrackerService({ credentials: {} }),
    forPerson: (person) => management.trackers(person, {
      installationOwner: person.deployment === "local-trusted"
        && (person as { instanceOwner?: boolean }).instanceOwner === true,
    }),
    forActor: (spaceId, actorUserId, provider) =>
      management.agentTrackers(space(spaceId), agentActor(spaceId, actorUserId), provider),
  };
  host.services.provide(serverServiceKey<ScopedTaskTrackerService>("task-trackers"), trackers);
  host.root.provide(CAP.taskTrackers, trackers);
  const tools = createTaskAgentTools({
    trackers: (spaceId, actorUserId, provider) =>
      management.agentTrackers(space(spaceId), agentActor(spaceId, actorUserId), provider),
    preferences: (spaceId) => management.preferences(space(spaceId)),
    events: (spaceId, sessionId) => host.forSpace(space(spaceId)).sessions.events(sessionId),
    append: (sessionId, type, data) => host.events.append(
      sessionId,
      type,
      data,
      { ignorable: true, producerPlugin: host.pluginId },
    ),
  });
  let capabilities: Disposable[] = [];
  return {
    remoteAccess: localOnlyRemoteAccess([TASK_TRACKERS_PACKAGE_ID]),
    routes,
    onEnable() {
      const registry = host.services.get(
        serverServiceKey<AgentCapabilityContributionRegistry>("harness.capabilities"),
      );
      if (!registry || capabilities.length > 0) return;
      capabilities = [taskSkill, ...tools].map((contribution) =>
        registry.register(TASK_TRACKERS_PACKAGE_ID, contribution));
    },
    async onDisable() {
      for (const capability of capabilities.toReversed()) await capability.dispose();
      capabilities = [];
    },
  };
}
