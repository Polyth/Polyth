import type {
  SessionEvent,
  TaskCompletedData,
  TaskSelectedData,
  TaskStatusChangedData,
  TaskTrackerBoardDto,
  TaskTrackerBoardType,
  TaskTrackerProjectDto,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
  TaskTrackerService,
  TaskTrackerStatusCategory,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
  TaskTrackerTaskQuery,
} from "@polyth/contracts";

export { TASK_TRACKER_WIDGETS } from "../widgets/index.ts";

export type FetchFn = typeof fetch;

interface ProviderClient {
  listProjects(): Promise<TaskTrackerProjectDto[]>;
  listBoards(projectId?: string): Promise<TaskTrackerBoardDto[]>;
  listTasks(query: TaskTrackerTaskQuery): Promise<TaskTrackerTaskDto[]>;
  getTask(taskId: string): Promise<TaskTrackerTaskDto>;
  updateStatus(taskId: string, statusId: string): Promise<TaskTrackerTaskDto>;
}

const error = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

const required = (value: string | undefined, name: string): string => {
  const clean = value?.trim();
  if (!clean) throw error(`${name} is not configured`, "unavailable");
  return clean;
};

const identifier = (value: string, field: string): string => {
  const clean = value.trim();
  if (!clean || clean.length > 256) {
    throw error(`${field} is required and must be at most 256 characters`, "invalid-input");
  }
  return clean;
};

const limitOf = (value: number | undefined): number => {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw error("limit must be an integer between 1 and 100", "invalid-input");
  }
  return value;
};

const apiError = (provider: string, response: Response): Error => {
  const code = response.status === 404
    ? "not-found"
    : response.status === 400 || response.status === 422
      ? "invalid-input"
      : "unavailable";
  return error(`${provider} request failed (${response.status} ${response.statusText || "HTTP error"})`, code);
};

async function requestJson<T>(
  provider: string,
  fetchImpl: FetchFn,
  url: URL,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    throw error(`${provider} is unreachable`, "unavailable");
  }
  if (!response.ok) throw apiError(provider, response);
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw error(`${provider} returned invalid JSON`, "unavailable");
  }
}

const statusCategory = (key: string | undefined): TaskTrackerStatusCategory => {
  if (key === "done") return "done";
  if (key === "new") return "todo";
  if (key === "indeterminate") return "in_progress";
  return "unknown";
};

const jiraText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: unknown; content?: unknown[]; type?: unknown };
  const own = typeof node.text === "string" ? node.text : "";
  const children = Array.isArray(node.content) ? node.content.map(jiraText).join("") : "";
  return node.type === "paragraph" || node.type === "heading"
    ? `${own}${children}\n`
    : `${own}${children}`;
};

interface JiraIssue {
  id?: string;
  key?: string;
  self?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { id?: string; name?: string; statusCategory?: { key?: string } };
    labels?: unknown[];
    assignee?: { displayName?: string } | null;
    duedate?: string | null;
    updated?: string;
    project?: { id?: string; key?: string };
  };
}

interface JiraStatus {
  id?: string;
  name?: string;
  statusCategory?: { key?: string };
}

const jiraStatus = (value: JiraStatus | undefined): TaskTrackerStatusDto => ({
  id: String(value?.id ?? ""),
  name: String(value?.name ?? "Unknown"),
  category: statusCategory(value?.statusCategory?.key),
});

const jiraIssue = (
  issue: JiraIssue,
  baseUrl: URL,
  availableStatuses?: TaskTrackerStatusDto[],
): TaskTrackerTaskDto => {
  const key = String(issue.key ?? issue.id ?? "");
  const fields = issue.fields ?? {};
  return {
    provider: "jira",
    id: String(issue.id ?? key),
    key,
    title: String(fields.summary ?? "Untitled Jira issue"),
    description: jiraText(fields.description).trim(),
    url: new URL(`/browse/${encodeURIComponent(key)}`, baseUrl).toString(),
    projectId: fields.project?.id,
    projectKey: fields.project?.key,
    status: jiraStatus(fields.status),
    ...(availableStatuses ? { availableStatuses } : {}),
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    assignees: fields.assignee?.displayName ? [fields.assignee.displayName] : [],
    ...(fields.duedate ? { dueAt: fields.duedate } : {}),
    ...(fields.updated ? { updatedAt: fields.updated } : {}),
  };
};

export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetchImpl?: FetchFn;
}

export function createJiraClient(options: JiraClientOptions): ProviderClient {
  const baseUrl = new URL(required(options.baseUrl, "JIRA_BASE_URL"));
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost" && baseUrl.hostname !== "127.0.0.1") {
    throw error("JIRA_BASE_URL must use HTTPS", "invalid-input");
  }
  const email = required(options.email, "JIRA_EMAIL");
  const apiToken = required(options.apiToken, "JIRA_API_TOKEN");
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
  };
  const request = <T>(path: string, init: RequestInit = {}, query?: URLSearchParams) => {
    const url = new URL(path, baseUrl);
    if (query) url.search = query.toString();
    return requestJson<T>("Jira", fetchImpl, url, { ...init, headers: { ...headers, ...init.headers } });
  };
  const detail = async (taskId: string): Promise<TaskTrackerTaskDto> => {
    const id = encodeURIComponent(identifier(taskId, "taskId"));
    const fields = "summary,description,status,labels,assignee,duedate,updated,project";
    const [issue, transitions] = await Promise.all([
      request<JiraIssue>(`/rest/api/3/issue/${id}`, {}, new URLSearchParams({ fields })),
      request<{
        transitions?: Array<{
          id?: string;
          name?: string;
          to?: { id?: string; name?: string; statusCategory?: { key?: string } };
        }>;
      }>(`/rest/api/3/issue/${id}/transitions`),
    ]);
    const statuses = (transitions.transitions ?? []).map((transition) => ({
      id: String(transition.id ?? ""),
      name: String(transition.to?.name ?? transition.name ?? "Unknown"),
      category: statusCategory(transition.to?.statusCategory?.key),
    })).filter((status) => status.id);
    return jiraIssue(issue, baseUrl, statuses);
  };

  return {
    async listProjects() {
      const response = await request<{
        values?: Array<{
          id?: string;
          key?: string;
          name?: string;
          avatarUrls?: Record<string, string>;
        }>;
      }>("/rest/api/3/project/search", {}, new URLSearchParams({
        maxResults: "100",
        orderBy: "name",
      }));
      return (response.values ?? []).map((project) => ({
        provider: "jira",
        id: String(project.id ?? project.key ?? ""),
        key: String(project.key ?? ""),
        name: String(project.name ?? project.key ?? "Untitled Jira project"),
        ...(project.key
          ? { url: new URL(`/browse/${encodeURIComponent(project.key)}`, baseUrl).toString() }
          : {}),
        ...(project.avatarUrls?.["48x48"] ? { avatarUrl: project.avatarUrls["48x48"] } : {}),
      }));
    },

    async listBoards(projectId) {
      const query = new URLSearchParams({ maxResults: "100" });
      if (projectId) query.set("projectKeyOrId", identifier(projectId, "projectId"));
      const response = await request<{
        values?: Array<{
          id?: number | string;
          name?: string;
          type?: string;
          location?: { projectId?: number | string; projectKey?: string };
        }>;
      }>("/rest/agile/1.0/board", {}, query);
      return (response.values ?? []).map((board) => {
        const type: TaskTrackerBoardType =
          board.type === "kanban" || board.type === "scrum" || board.type === "simple"
            ? board.type
            : "unknown";
        const id = String(board.id ?? "");
        return {
          provider: "jira",
          id,
          name: String(board.name ?? "Untitled Jira board"),
          type,
          ...(board.location?.projectId !== undefined
            ? { projectId: String(board.location.projectId) }
            : {}),
          ...(board.location?.projectKey ? { projectKey: board.location.projectKey } : {}),
          ...(id
            ? { url: new URL(`/secure/RapidBoard.jspa?rapidView=${encodeURIComponent(id)}`, baseUrl).toString() }
            : {}),
        };
      });
    },

    async listTasks(query) {
      const limit = limitOf(query.limit);
      const fields = "summary,description,status,labels,assignee,duedate,updated,project";
      let response: { issues?: JiraIssue[] };
      if (query.boardId) {
        response = await request<{ issues?: JiraIssue[] }>(
          `/rest/agile/1.0/board/${encodeURIComponent(identifier(query.boardId, "boardId"))}/issue`,
          {},
          new URLSearchParams({ maxResults: String(limit), fields }),
        );
      } else if (query.projectId) {
        response = await request<{ issues?: JiraIssue[] }>(
          "/rest/api/3/search/jql",
          {},
          new URLSearchParams({
            jql: `project = "${identifier(query.projectId, "projectId").replaceAll('"', '\\"')}" ORDER BY updated DESC`,
            maxResults: String(limit),
            fields,
          }),
        );
      } else {
        throw error("boardId or projectId is required for Jira tasks", "invalid-input");
      }
      return (response.issues ?? []).map((issue) => jiraIssue(issue, baseUrl));
    },

    getTask: detail,

    async updateStatus(taskId, statusId) {
      const id = encodeURIComponent(identifier(taskId, "taskId"));
      await request<void>(`/rest/api/3/issue/${id}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: identifier(statusId, "statusId") } }),
      });
      return detail(taskId);
    },
  };
}

interface TrelloList {
  id?: string;
  name?: string;
  closed?: boolean;
}

interface TrelloCard {
  id?: string;
  name?: string;
  desc?: string;
  url?: string;
  idBoard?: string;
  idList?: string;
  labels?: Array<{ name?: string; color?: string }>;
  members?: Array<{ fullName?: string; username?: string }>;
  due?: string | null;
  dueComplete?: boolean;
  dateLastActivity?: string;
}

const trelloCategory = (name: string, closed = false): TaskTrackerStatusCategory => {
  if (closed || /\b(done|complete|completed|closed|shipped|released)\b/i.test(name)) return "done";
  if (/\b(doing|progress|active|review|testing|qa|blocked)\b/i.test(name)) return "in_progress";
  if (/\b(todo|to do|backlog|open|ready|planned?)\b/i.test(name)) return "todo";
  return "unknown";
};

const trelloStatuses = (lists: TrelloList[]): TaskTrackerStatusDto[] =>
  lists.filter((list) => list.id).map((list) => ({
    id: String(list.id),
    name: String(list.name ?? "Untitled list"),
    category: trelloCategory(String(list.name ?? ""), list.closed === true),
  }));

const trelloCard = (
  card: TrelloCard,
  statuses: TaskTrackerStatusDto[],
): TaskTrackerTaskDto => {
  const id = String(card.id ?? "");
  const current = statuses.find((status) => status.id === card.idList) ?? {
    id: String(card.idList ?? ""),
    name: "Unknown",
    category: "unknown" as const,
  };
  return {
    provider: "trello",
    id,
    key: id,
    title: String(card.name ?? "Untitled Trello card"),
    description: String(card.desc ?? ""),
    ...(card.url ? { url: card.url } : {}),
    ...(card.idBoard ? { boardId: card.idBoard } : {}),
    status: current,
    availableStatuses: statuses,
    labels: (card.labels ?? []).map((label) => label.name || label.color || "").filter(Boolean),
    assignees: (card.members ?? []).map((member) => member.fullName || member.username || "").filter(Boolean),
    ...(card.due ? { dueAt: card.due } : {}),
    ...(card.dateLastActivity ? { updatedAt: card.dateLastActivity } : {}),
  };
};

export interface TrelloClientOptions {
  apiKey: string;
  apiToken: string;
  fetchImpl?: FetchFn;
  baseUrl?: string;
}

export function createTrelloClient(options: TrelloClientOptions): ProviderClient {
  const apiKey = required(options.apiKey, "TRELLO_API_KEY");
  const apiToken = required(options.apiToken, "TRELLO_API_TOKEN");
  const baseUrl = new URL(options.baseUrl ?? "https://api.trello.com");
  const fetchImpl = options.fetchImpl ?? fetch;
  const request = <T>(path: string, init: RequestInit = {}, query = new URLSearchParams()) => {
    const url = new URL(path, baseUrl);
    query.set("key", apiKey);
    query.set("token", apiToken);
    url.search = query.toString();
    return requestJson<T>("Trello", fetchImpl, url, init);
  };
  const lists = (boardId: string) => request<TrelloList[]>(
    `/1/boards/${encodeURIComponent(identifier(boardId, "boardId"))}/lists`,
    {},
    new URLSearchParams({ fields: "name,closed,pos", filter: "all" }),
  );
  const detail = async (taskId: string): Promise<TaskTrackerTaskDto> => {
    const id = encodeURIComponent(identifier(taskId, "taskId"));
    const card = await request<TrelloCard>(`/1/cards/${id}`, {}, new URLSearchParams({
      fields: "id,name,desc,url,idBoard,idList,labels,due,dueComplete,dateLastActivity",
      members: "true",
      member_fields: "fullName,username",
    }));
    const statuses = trelloStatuses(await lists(String(card.idBoard ?? "")));
    return trelloCard(card, statuses);
  };

  return {
    async listProjects() {
      const organizations = await request<Array<{
        id?: string;
        name?: string;
        displayName?: string;
        url?: string;
      }>>("/1/members/me/organizations", {}, new URLSearchParams({
        fields: "name,displayName,url",
      }));
      return organizations.map((organization) => ({
        provider: "trello",
        id: String(organization.id ?? ""),
        key: String(organization.name ?? organization.id ?? ""),
        name: String(organization.displayName ?? organization.name ?? "Untitled Trello Workspace"),
        ...(organization.url ? { url: organization.url } : {}),
      }));
    },

    async listBoards(projectId) {
      const boards = await request<Array<{
        id?: string;
        name?: string;
        url?: string;
        idOrganization?: string | null;
        closed?: boolean;
      }>>("/1/members/me/boards", {}, new URLSearchParams({
        fields: "name,url,idOrganization,closed",
        filter: "open",
      }));
      return boards
        .filter((board) => !projectId || board.idOrganization === projectId)
        .map((board) => ({
          provider: "trello",
          id: String(board.id ?? ""),
          name: String(board.name ?? "Untitled Trello board"),
          type: "kanban",
          ...(board.idOrganization ? { projectId: board.idOrganization } : {}),
          ...(board.url ? { url: board.url } : {}),
        }));
    },

    async listTasks(query) {
      const boardId = identifier(query.boardId ?? "", "boardId");
      const [cards, boardLists] = await Promise.all([
        request<TrelloCard[]>(
          `/1/boards/${encodeURIComponent(boardId)}/cards`,
          {},
          new URLSearchParams({
            fields: "id,name,desc,url,idBoard,idList,labels,due,dueComplete,dateLastActivity",
            members: "true",
            member_fields: "fullName,username",
            limit: String(limitOf(query.limit)),
          }),
        ),
        lists(boardId),
      ]);
      const statuses = trelloStatuses(boardLists);
      return cards.map((card) => trelloCard(card, statuses));
    },

    getTask: detail,

    async updateStatus(taskId, statusId) {
      await request<TrelloCard>(
        `/1/cards/${encodeURIComponent(identifier(taskId, "taskId"))}`,
        { method: "PUT" },
        new URLSearchParams({ idList: identifier(statusId, "statusId") }),
      );
      return detail(taskId);
    },
  };
}

export interface TaskTrackerServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchFn;
}

export function isTaskTrackerProvider(value: string): value is TaskTrackerProvider {
  return value === "jira" || value === "trello";
}

export function createTaskTrackerService(
  options: TaskTrackerServiceOptions = {},
): TaskTrackerService {
  const env = options.env ?? process.env;
  const configured = {
    jira: Boolean(env.JIRA_BASE_URL?.trim() && env.JIRA_EMAIL?.trim() && env.JIRA_API_TOKEN?.trim()),
    trello: Boolean(env.TRELLO_API_KEY?.trim() && env.TRELLO_API_TOKEN?.trim()),
  };
  const clients: Partial<Record<TaskTrackerProvider, ProviderClient>> = {};
  if (configured.jira) {
    clients.jira = createJiraClient({
      baseUrl: env.JIRA_BASE_URL!,
      email: env.JIRA_EMAIL!,
      apiToken: env.JIRA_API_TOKEN!,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  if (configured.trello) {
    clients.trello = createTrelloClient({
      apiKey: env.TRELLO_API_KEY!,
      apiToken: env.TRELLO_API_TOKEN!,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }
  const providerInfo: TaskTrackerProviderDto[] = [
    {
      provider: "jira",
      configured: configured.jira,
      requiredEnv: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
    },
    {
      provider: "trello",
      configured: configured.trello,
      requiredEnv: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"],
    },
  ];
  const client = (provider: TaskTrackerProvider): ProviderClient => {
    const value = clients[provider];
    if (!value) {
      const names = providerInfo.find((item) => item.provider === provider)?.requiredEnv.join(", ");
      throw error(`${provider} is not configured; set ${names}`, "unavailable");
    }
    return value;
  };
  return {
    providers: () => providerInfo.map((item) => ({ ...item, requiredEnv: [...item.requiredEnv] })),
    listProjects: (provider) => client(provider).listProjects(),
    listBoards: (provider, projectId) => client(provider).listBoards(projectId),
    listTasks: (provider, query) => client(provider).listTasks(query),
    getTask: (provider, taskId) => client(provider).getTask(taskId),
    updateStatus: (provider, taskId, statusId) => client(provider).updateStatus(taskId, statusId),
  };
}

export function buildTaskWorkPrompt(task: TaskTrackerTaskDto, instructions = ""): string {
  const custom = instructions.trim();
  return [
    `Work on ${task.provider === "jira" ? "Jira issue" : "Trello card"} ${task.key}: ${task.title}`,
    "",
    `Tracker: ${task.provider}`,
    `Status: ${task.status.name}`,
    ...(task.url ? [`URL: ${task.url}`] : []),
    "",
    "Task description:",
    task.description || "(No description provided.)",
    ...(custom ? ["", "Additional instructions:", custom] : []),
    "",
    "Complete the requested engineering work in this project.",
    "Run the relevant tests, commit the result, and report the commit and verification evidence.",
    "Do not merge or change the external task status unless the user explicitly requests it.",
  ].join("\n");
}

export interface TaskLifecycleState {
  provider: TaskTrackerProvider;
  taskId: string;
  taskKey: string;
  title: string;
  statusId: string;
  statusName: string;
  completed: boolean;
  selectedAtSeq: number;
  updatedAtSeq: number;
}

/** Replays package events without assuming every session event is known. */
export function reduceTaskLifecycle(events: readonly SessionEvent[]): TaskLifecycleState[] {
  const linked = new Map<string, TaskLifecycleState>();
  for (const event of events) {
    if (
      event.type !== "task/selected"
      && event.type !== "task/status-changed"
      && event.type !== "task/completed"
    ) continue;
    const data = event.data as unknown as
      | TaskSelectedData
      | TaskStatusChangedData
      | TaskCompletedData;
    if (!isTaskTrackerProvider(String(data.provider)) || !data.taskId) continue;
    const id = `${data.provider}:${data.taskId}`;
    const previous = linked.get(id);
    linked.set(id, {
      provider: data.provider,
      taskId: String(data.taskId),
      taskKey: String(data.taskKey ?? data.taskId),
      title: String(data.title ?? ""),
      statusId: String(data.statusId ?? previous?.statusId ?? ""),
      statusName: String(data.statusName ?? previous?.statusName ?? ""),
      completed: event.type === "task/completed" || previous?.completed === true,
      selectedAtSeq: previous?.selectedAtSeq ?? event.seq,
      updatedAtSeq: event.seq,
    });
  }
  return [...linked.values()].sort((a, b) => a.selectedAtSeq - b.selectedAtSeq);
}
