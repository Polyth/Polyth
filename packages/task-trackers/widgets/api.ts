import type {
  HarnessSelection,
  ModelRef,
  TaskTrackerBoardDto,
  TaskTrackerAttachmentInput,
  TaskTrackerBoardColumnsDto,
  TaskTrackerColumnDto,
  TaskTrackerColumnInput,
  TaskTrackerCreateBoardInput,
  TaskTrackerCreateTaskInput,
  TaskTrackerProjectDto,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
  TaskTrackerSessionTaskDto,
  TaskTrackerTaskDto,
  TaskTrackerViewerDto,
} from "@polyth/contracts";
import { createApiTransport } from "@polyth/web-sdk";
import type {
  JiraConnectInput,
  LinearConnectInput,
  TaskTrackerConnectionScope,
  TaskTrackerDispatchResultDto,
  TaskTrackerManagementDto,
  TaskTrackerPreferencesPatch,
  TaskTrackerTaskLinkDto,
  TrelloConnectInput,
} from "../src/types.ts";

const onUnauthorized = () => {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("polyth:auth-required"));
  }
};

const transport = createApiTransport({
  fetch: (input, init) => globalThis.fetch(input, init),
  onUnauthorized,
});

/** Reads that only decorate the board ("Mine"): one attempt, no retry. */
const decoration = createApiTransport({
  fetch: (input, init) => globalThis.fetch(input, init),
  onUnauthorized,
  readRetry: false,
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
  /** Records the change in this session; the board omits it. */
  sessionId?: string;
  statusId: string;
}

export interface TaskTrackerLinkResult {
  ok: true;
  task: TaskTrackerTaskDto;
  sessionId: string;
  turn?: unknown;
}

export interface TaskTrackerDispatchInput {
  projectId: string;
  tasks: Array<{ provider: TaskTrackerProvider; taskId: string }>;
  instructions?: string;
  harness?: HarnessSelection;
  model?: ModelRef;
}

/** `connectionId` names one of the caller's own accounts (personal scope only). */
const scoped = (path: string, scope: TaskTrackerConnectionScope, connectionId?: string) =>
  scope === "personal"
    ? `${path}?scope=personal${connectionId ? `&id=${encodeURIComponent(connectionId)}` : ""}`
    : path;

const columnsPath = (provider: TaskTrackerProvider, boardId: string) =>
  `/api/task-trackers/${provider}/boards/${encodeURIComponent(boardId)}/columns`;

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
  taskTrackerSettings: () =>
    transport.get<TaskTrackerManagementDto>("/api/task-trackers/settings"),
  taskTrackerUpdateSettings: (patch: TaskTrackerPreferencesPatch) =>
    transport.patch<TaskTrackerManagementDto>("/api/task-trackers/settings", patch),
  taskTrackerConnectJira: (input: JiraConnectInput, scope: TaskTrackerConnectionScope = "space") =>
    transport.post<TaskTrackerManagementDto>(scoped("/api/task-trackers/connections/jira", scope), input),
  taskTrackerConnectTrello: (input: TrelloConnectInput, scope: TaskTrackerConnectionScope = "space") =>
    transport.post<TaskTrackerManagementDto>(scoped("/api/task-trackers/connections/trello", scope), input),
  taskTrackerConnectLinear: (input: LinearConnectInput, scope: TaskTrackerConnectionScope = "space") =>
    transport.post<TaskTrackerManagementDto>(scoped("/api/task-trackers/connections/linear", scope), input),
  /** The account the board acts as, for "assigned to me". */
  taskTrackerViewer: (provider: TaskTrackerProvider) =>
    decoration.get<TaskTrackerViewerDto>(`/api/task-trackers/${provider}/me`),
  taskTrackerVerifyConnection: (provider: TaskTrackerProvider, scope: TaskTrackerConnectionScope = "space", connectionId?: string) =>
    transport.post<TaskTrackerManagementDto>(scoped(`/api/task-trackers/connections/${provider}/verify`, scope, connectionId), {}),
  taskTrackerDisconnect: (provider: TaskTrackerProvider, scope: TaskTrackerConnectionScope = "space", connectionId?: string) =>
    transport.delete<TaskTrackerManagementDto>(scoped(`/api/task-trackers/connections/${provider}`, scope, connectionId)),
  taskTrackerSetPersonalEnabled: (connectionId: string, enabled: boolean) =>
    transport.put<TaskTrackerManagementDto>(
      `/api/task-trackers/personal-connections/${encodeURIComponent(connectionId)}/enabled`,
      { enabled },
    ),
  taskTrackerSetServicePolicy: (agentsMayUseService: boolean) =>
    transport.put<TaskTrackerManagementDto>("/api/task-trackers/service-policy", { agentsMayUseService }),
  taskTrackerCreate: (provider: TaskTrackerProvider, input: TaskTrackerCreateTaskInput) =>
    transport.post<TaskTrackerTaskDto>(`/api/task-trackers/${provider}/tasks`, input),
  taskTrackerUpdateTask: (
    provider: TaskTrackerProvider,
    taskId: string,
    input: { title?: string; description?: string; statusId?: string; sessionId?: string },
  ) =>
    transport.patch<TaskTrackerTaskDto>(
      `/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}`,
      input,
    ),
  taskTrackerAddComment: (
    provider: TaskTrackerProvider,
    taskId: string,
    text: string,
  ) =>
    transport.post<{ ok: true; task?: TaskTrackerTaskDto }>(
      `/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}/comments`,
      { text },
    ),
  taskTrackerAttach: (provider: TaskTrackerProvider, taskId: string, files: TaskTrackerAttachmentInput[]) =>
    transport.post<{ ok: true; task?: TaskTrackerTaskDto }>(`/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}/attachments`, { files }),
  taskTrackerCreateBoard: (provider: TaskTrackerProvider, input: TaskTrackerCreateBoardInput) =>
    transport.post<TaskTrackerBoardDto>(`/api/task-trackers/${provider}/boards`, input),
  taskTrackerColumns: (provider: TaskTrackerProvider, boardId: string) =>
    transport.get<TaskTrackerBoardColumnsDto>(columnsPath(provider, boardId)),
  taskTrackerCreateColumn: (provider: TaskTrackerProvider, boardId: string, input: TaskTrackerColumnInput) =>
    transport.post<TaskTrackerColumnDto>(columnsPath(provider, boardId), input),
  taskTrackerUpdateColumn: (
    provider: TaskTrackerProvider,
    boardId: string,
    columnId: string,
    input: TaskTrackerColumnInput,
  ) => transport.patch<TaskTrackerColumnDto>(`${columnsPath(provider, boardId)}/${encodeURIComponent(columnId)}`, input),
  taskTrackerRemoveColumn: (provider: TaskTrackerProvider, boardId: string, columnId: string) =>
    transport.delete<{ ok: true }>(`${columnsPath(provider, boardId)}/${encodeURIComponent(columnId)}`),
  taskTrackerMoveTask: (
    provider: TaskTrackerProvider,
    taskId: string,
    input: { boardId: string; columnId: string; sessionId?: string },
  ) => transport.post<TaskTrackerTaskDto>(`/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}/move`, input),
  taskTrackerArchiveTask: (provider: TaskTrackerProvider, taskId: string) =>
    transport.post<{ ok: true }>(`/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}/archive`, {}),
  taskTrackerDeleteTask: (provider: TaskTrackerProvider, taskId: string) =>
    transport.delete<{ ok: true }>(`/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}`),
  taskTrackerDispatch: (input: TaskTrackerDispatchInput) =>
    transport.post<{ results: TaskTrackerDispatchResultDto[] }>("/api/task-trackers/dispatch", input),
  taskTrackerLinks: () =>
    transport.get<TaskTrackerTaskLinkDto[]>("/api/task-trackers/links"),
};
