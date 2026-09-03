import {
  CAP,
  type JsonObject,
  type RouteHandler,
  type SessionEvent,
  type SessionProjection,
  type TaskSelectedData,
  type TaskTrackerProvider,
  type TaskTrackerService,
  type TaskTrackerTaskDto,
  type UserTurnInput,
} from "@polyth/contracts";
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

const invalid = (message: string, field?: string): Error =>
  Object.assign(new Error(message), {
    code: "invalid-input",
    ...(field ? { field } : {}),
  });

const providerOf = (value: string | null): TaskTrackerProvider => {
  if (!value || !isTaskTrackerProvider(value)) {
    throw invalid("provider must be jira or trello", "provider");
  }
  return value;
};

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

interface TaskTrackerRouteDeps {
  trackers: TaskTrackerService;
  snapshot(sessionId: string): Promise<SessionProjection>;
  events(sessionId: string): Promise<SessionEvent[]>;
  append(sessionId: string, type: string, data: JsonObject): Promise<SessionEvent>;
  send(sessionId: string, input: UserTurnInput): Promise<unknown>;
}

export function taskTrackerRoutes(deps: TaskTrackerRouteDeps): RouteHandler {
  const session = async (sessionId: string): Promise<SessionProjection> => {
    try {
      return await deps.snapshot(sessionId);
    } catch {
      throw Object.assign(new Error("session not found"), { code: "not-found" });
    }
  };

  return async ({ path, method, url, body, json }) => {
    if (!path.startsWith("/api/task-trackers")) return false;

    if (path === "/api/task-trackers/providers" && method === "GET") {
      json(200, deps.trackers.providers());
      return true;
    }

    if (path === "/api/task-trackers/projects" && method === "GET") {
      json(200, await deps.trackers.listProjects(providerOf(url.searchParams.get("provider"))));
      return true;
    }

    if (path === "/api/task-trackers/boards" && method === "GET") {
      json(200, await deps.trackers.listBoards(
        providerOf(url.searchParams.get("provider")),
        url.searchParams.get("projectId") ?? undefined,
      ));
      return true;
    }

    if (path === "/api/task-trackers/tasks" && method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      json(200, await deps.trackers.listTasks(
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
      await session(sessionId);
      json(200, reduceTaskLifecycle(await deps.events(sessionId)));
      return true;
    }

    match = path.match(/^\/api\/task-trackers\/(jira|trello)\/tasks\/([^/]+)$/);
    if (match && method === "GET") {
      json(200, await deps.trackers.getTask(
        providerOf(match[1] ?? null),
        pathPart(match[2], "taskId"),
      ));
      return true;
    }

    if (match && method === "PATCH") {
      const provider = providerOf(match[1] ?? null);
      const taskId = pathPart(match[2], "taskId");
      const input = await body();
      const statusId = String(input.statusId ?? "").trim();
      const sessionId = String(input.sessionId ?? "").trim();
      if (!statusId) throw invalid("statusId is required", "statusId");
      if (!sessionId) throw invalid("sessionId is required", "sessionId");
      await session(sessionId);

      const previous = await deps.trackers.getTask(provider, taskId);
      const updated = await deps.trackers.updateStatus(provider, taskId, statusId);
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

    match = path.match(/^\/api\/task-trackers\/(jira|trello)\/tasks\/([^/]+)\/link$/);
    if (match && method === "POST") {
      const provider = providerOf(match[1] ?? null);
      const taskId = pathPart(match[2], "taskId");
      const input = await body();
      const sessionId = String(input.sessionId ?? "").trim();
      if (!sessionId) throw invalid("sessionId is required", "sessionId");
      await session(sessionId);
      const task = await deps.trackers.getTask(provider, taskId);

      // Persist the semantic selection before either the model-visible prompt
      // or the initiating UI can observe success.
      await deps.append(sessionId, "task/selected", {
        ...selectedData(task),
      });
      let turn: unknown;
      if (input.startAgent !== false) {
        turn = await deps.send(sessionId, {
          text: buildTaskWorkPrompt(task, String(input.instructions ?? "")),
        });
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

export default function registerPackage(host: ServerPackageHost): ServerPackage {
  const trackers = createTaskTrackerService();
  host.services.provide(serverServiceKey<TaskTrackerService>("task-trackers"), trackers);
  host.root.provide(CAP.taskTrackers, trackers);
  const routes = taskTrackerRoutes({
    trackers,
    snapshot: (sessionId) => host.sessions.snapshot(sessionId),
    events: (sessionId) => host.store.events(sessionId),
    append: (sessionId, type, data) => host.events.append(
      sessionId,
      type,
      data,
      { ignorable: true, producerPlugin: host.pluginId },
    ),
    send: (sessionId, input) => host.sessions.send(sessionId, input),
  });
  return {
    remoteAccess: localOnlyRemoteAccess(["task-trackers"]),
    routes,
  };
}
