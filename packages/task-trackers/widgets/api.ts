import type {
  TaskTrackerBoardDto,
  TaskTrackerProjectDto,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
  TaskTrackerSessionTaskDto,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";

const transport = createApiTransport({
  fetch: (input, init) => globalThis.fetch(input, init),
  onUnauthorized: () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("polyth:auth-required"));
    }
  },
});

export interface TaskTrackerTaskQuery {
  boardId?: string;
  projectId?: string;
  limit?: number;
}

export interface TaskTrackerLinkInput {
  sessionId: string;
  instructions?: string;
  startAgent?: boolean;
}

export interface TaskTrackerStatusInput {
  sessionId: string;
  statusId: string;
}

export interface TaskTrackerLinkResult {
  ok: true;
  task: TaskTrackerTaskDto;
  sessionId: string;
  turn?: unknown;
}

export const api = {
  taskTrackerProviders: () =>
    transport.get<TaskTrackerProviderDto[]>("/api/task-trackers/providers"),
  taskTrackerProjects: (provider: TaskTrackerProvider) =>
    transport.get<TaskTrackerProjectDto[]>(
      `/api/task-trackers/projects?provider=${encodeURIComponent(provider)}`,
    ),
  taskTrackerBoards: (provider: TaskTrackerProvider, projectId?: string) => {
    const query = new URLSearchParams({ provider });
    if (projectId) query.set("projectId", projectId);
    return transport.get<TaskTrackerBoardDto[]>(`/api/task-trackers/boards?${query}`);
  },
  taskTrackerTasks: (
    provider: TaskTrackerProvider,
    input: TaskTrackerTaskQuery,
  ) => {
    const query = new URLSearchParams({ provider });
    if (input.boardId) query.set("boardId", input.boardId);
    if (input.projectId) query.set("projectId", input.projectId);
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return transport.get<TaskTrackerTaskDto[]>(`/api/task-trackers/tasks?${query}`);
  },
  taskTrackerTask: (provider: TaskTrackerProvider, taskId: string) =>
    transport.get<TaskTrackerTaskDto>(
      `/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}`,
    ),
  taskTrackerSessionTasks: (sessionId: string) =>
    transport.get<TaskTrackerSessionTaskDto[]>(
      `/api/task-trackers/sessions/${encodeURIComponent(sessionId)}/tasks`,
    ),
  taskTrackerLink: (
    provider: TaskTrackerProvider,
    taskId: string,
    input: TaskTrackerLinkInput,
  ) => transport.post<TaskTrackerLinkResult>(
    `/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}/link`,
    input,
  ),
  taskTrackerUpdateStatus: (
    provider: TaskTrackerProvider,
    taskId: string,
    input: TaskTrackerStatusInput,
  ) => transport.patch<TaskTrackerTaskDto>(
    `/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}`,
    input,
  ),
};
