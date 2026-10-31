import type {
  TaskTrackerAccountDto,
  TaskTrackerAttachmentDto,
  TaskTrackerBoardDto,
  TaskTrackerColumnDto,
  TaskTrackerCommentDto,
  TaskTrackerPersonDto,
  TaskTrackerPriority,
  TaskTrackerPriorityDto,
  TaskTrackerProjectDto,
  TaskTrackerStatusCategory,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import {
  attachmentContentPath,
  BOARD_NAME_MAX,
  boundedText,
  cleanReason,
  COMMENT_MAX,
  DESCRIPTION_MAX,
  error,
  identifier,
  imageFiles,
  imageTypeOfName,
  limitOf,
  requestBinary,
  required,
  statusError,
  TITLE_MAX,
  webUrl,
  type FetchFn,
  type ProviderClient,
} from "./common.ts";

/**
 * Linear through its GraphQL API (https://linear.app/developers/graphql).
 *
 * Mapping: a Linear team is the board picker's "project" (Teams); its boards
 * are the team's issues (board id = team id) and each of its active Linear
 * projects (board id = `<teamId>:<projectId>`). Columns are the team's
 * workflow states, which Linear edits in its team settings only. Images
 * pasted into a description, and files Polyth attaches, live on
 * uploads.linear.app behind the API key, so the board reads them through
 * the attachment content route.
 */

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
/** Settings → Teams, where each team's issue statuses are edited. */
export const LINEAR_TEAMS_SETTINGS = "https://linear.app/settings/teams";
const UPLOADS_HOST = "uploads.linear.app";
/** Completed and canceled issues stay on a board this long, as in Linear. */
const RECENTLY_CLOSED = "-P2W";

/** Personal API keys go as they are; an OAuth token as a bearer token. */
const authorization = (apiKey: string): string =>
  apiKey.startsWith("lin_oauth_") ? `Bearer ${apiKey}` : apiKey;

interface GraphqlError {
  message?: string;
  extensions?: {
    code?: string;
    statusCode?: number;
    userPresentableMessage?: string;
    http?: { status?: number };
  };
}

const NOT_FOUND = /not found|could not find|entity not found/i;

/**
 * One GraphQL request. Linear answers most failures with an `errors` list
 * (on HTTP 200 or 4xx). A write whose root field came back null applied
 * nothing; one whose root field resolved ran, even if a nested field failed.
 */
async function graphql<T extends object>(
  fetchImpl: FetchFn,
  endpoint: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
  write: boolean,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: authorization(apiKey),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(write ? 30_000 : 20_000),
    });
  } catch {
    throw error("Linear is unreachable", "unavailable");
  }
  const text = await response.text().catch(() => "");
  let body: { data?: T | null; errors?: GraphqlError[] } = {};
  try {
    body = text ? JSON.parse(text) as typeof body : {};
  } catch {
    if (response.ok) throw error("Linear returned invalid JSON", "unavailable");
  }
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const data = body.data && typeof body.data === "object" ? body.data : null;
  const resolved = data !== null && Object.values(data).length > 0
    && Object.values(data).every((value) => value !== null && value !== undefined);
  if (response.ok && resolved) return data as T;
  const reason = cleanReason(errors
    .map((item) => item.extensions?.userPresentableMessage || item.message || "")
    .filter(Boolean)
    .join("; "));
  if (errors.some((item) => item.extensions?.code === "RATELIMITED")) {
    throw Object.assign(error("Linear’s rate limit was reached. Try again in a few minutes.", "unavailable"), {
      httpStatus: 429,
      ...(write ? { mutationOutcome: "rejected" } : {}),
    });
  }
  // Linear states the HTTP status of a GraphQL error in its extensions.
  const declared = Number(errors[0]?.extensions?.statusCode ?? errors[0]?.extensions?.http?.status ?? 0);
  const stated = declared >= 400 && declared < 600;
  let status = !response.ok ? response.status : stated ? declared : 400;
  if (status < 500 && NOT_FOUND.test(reason)) status = 404;
  const statusText = !response.ok && response.statusText ? response.statusText : STATUS_TEXT[status] ?? "Error";
  const failure = statusError("Linear", status, statusText, write ? "POST" : "GET", reason);
  // A write counts as refused (nothing applied) only when Linear said so with
  // a 4xx; an error without a stated status leaves the outcome unknown, so
  // nobody is invited to send it twice.
  if (write && response.ok && !stated) delete (failure as { mutationOutcome?: string }).mutationOutcome;
  throw failure;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
};

interface LinearUser {
  id?: string;
  name?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string | null;
}

interface LinearState {
  id?: string;
  name?: string;
  type?: string;
  position?: number;
}

interface LinearAttachment {
  id?: string;
  title?: string | null;
  url?: string;
  createdAt?: string;
}

interface LinearIssue {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  url?: string;
  priority?: number;
  priorityLabel?: string;
  dueDate?: string | null;
  updatedAt?: string;
  sortOrder?: number;
  state?: LinearState | null;
  assignee?: LinearUser | null;
  labels?: { nodes?: Array<{ name?: string }> };
  attachments?: { nodes?: LinearAttachment[] };
  team?: { id?: string; key?: string; states?: { nodes?: LinearState[] } } | null;
  project?: { id?: string } | null;
  comments?: {
    nodes?: Array<{ id?: string; body?: string; createdAt?: string; user?: LinearUser | null }>;
  };
}

const ISSUE_FIELDS = `
  id identifier title description url priority priorityLabel dueDate updatedAt sortOrder
  state { id name type }
  assignee { id name displayName avatarUrl }
  labels(first: 10) { nodes { name } }
  attachments(first: 10) { nodes { id title url createdAt } }
  team { id key }
  project { id }
`;

const STATES_FIELDS = "states(first: 100) { nodes { id name type position } }";

/** Workflow state types in the fixed order Linear shows them. */
const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;

export const linearCategory = (type: string | undefined): TaskTrackerStatusCategory => {
  if (type === "completed" || type === "canceled" || type === "duplicate") return "done";
  if (type === "started") return "in_progress";
  if (type === "triage" || type === "backlog" || type === "unstarted") return "todo";
  return "unknown";
};

const stateRank = (type: string | undefined): number => {
  const index = STATE_TYPES.indexOf(type as typeof STATE_TYPES[number]);
  return index < 0 ? STATE_TYPES.length : index;
};

/** A team's states in board order. "Duplicate" is reserved: Linear applies it
 *  when an issue is marked as a duplicate, so nothing moves an issue there. */
const boardStates = (states: readonly LinearState[] | undefined): Array<Required<Pick<LinearState, "id" | "name">> & LinearState> =>
  (states ?? [])
    .filter((state): state is Required<Pick<LinearState, "id" | "name">> & LinearState =>
      Boolean(state.id) && typeof state.name === "string" && state.type !== "duplicate")
    .sort((left, right) => stateRank(left.type) - stateRank(right.type) || (left.position ?? 0) - (right.position ?? 0));

const linearStatus = (state: LinearState | null | undefined): TaskTrackerStatusDto => ({
  id: String(state?.id ?? ""),
  name: String(state?.name ?? "Unknown"),
  category: linearCategory(state?.type),
});

const PRIORITY_LEVELS: readonly TaskTrackerPriority[] = ["none", "urgent", "high", "medium", "low"];
const PRIORITY_NAMES: Record<TaskTrackerPriority, string> = {
  none: "No priority",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Linear: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low. */
export const linearPriority = (value: number | undefined, label?: string): TaskTrackerPriorityDto | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const level = PRIORITY_LEVELS[Math.trunc(value)] ?? "none";
  return { level, name: label?.trim() || PRIORITY_NAMES[level] };
};

const PRIORITY_ORDER: Record<TaskTrackerPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

const linearPerson = (user: LinearUser): TaskTrackerPersonDto => ({
  id: String(user.id ?? ""),
  name: String(user.name || user.displayName || ""),
  ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
});

/** The id the board uses for a file on uploads.linear.app: its path, which
 *  names one upload. Null for any other address. */
export const linearUploadId = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== UPLOADS_HOST) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length > 0 ? `upload~${parts.join("~")}` : null;
  } catch {
    return null;
  }
};

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((https:\/\/uploads\.linear\.app\/[^\s)]+)\)/g;

interface LinearUpload {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  createdAt?: string;
}

/** Files of an issue that live on uploads.linear.app: images pasted into the
 *  description, then attachments that point at an upload. */
const issueUploads = (issue: Pick<LinearIssue, "description" | "attachments">): LinearUpload[] => {
  const uploads: LinearUpload[] = [];
  const seen = new Set<string>();
  for (const match of String(issue.description ?? "").matchAll(MARKDOWN_IMAGE)) {
    const url = match[2]!;
    const id = linearUploadId(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const alt = match[1]!.trim();
    const name = alt || decodeURIComponent(url.split("/").at(-1) ?? "") || "image";
    uploads.push({ id, url, name, mimeType: imageTypeOfName(name) ?? imageTypeOfName(url) ?? "image/*" });
  }
  for (const node of issue.attachments?.nodes ?? []) {
    if (!node.id || !node.url || !linearUploadId(node.url) || seen.has(node.id)) continue;
    seen.add(node.id);
    const name = node.title?.trim() || decodeURIComponent(node.url.split("/").at(-1) ?? "") || "file";
    uploads.push({
      id: node.id,
      url: node.url,
      name,
      mimeType: imageTypeOfName(name) ?? imageTypeOfName(node.url) ?? "application/octet-stream",
      ...(node.createdAt ? { createdAt: node.createdAt } : {}),
    });
  }
  return uploads;
};

const issueAttachments = (issue: LinearIssue, issueId: string): TaskTrackerAttachmentDto[] => {
  const uploaded = issueUploads(issue).map((upload): TaskTrackerAttachmentDto => ({
    id: upload.id,
    name: upload.name,
    mimeType: upload.mimeType,
    url: attachmentContentPath("linear", issueId, upload.id),
    ...(upload.mimeType.startsWith("image/") ? { thumbnailUrl: attachmentContentPath("linear", issueId, upload.id, true) } : {}),
    ...(upload.createdAt ? { createdAt: upload.createdAt } : {}),
  }));
  // Other attachments are links (a pull request, a Figma file, a Slack
  // thread) and open where they live.
  const links = (issue.attachments?.nodes ?? []).flatMap((node): TaskTrackerAttachmentDto[] => {
    const url = webUrl(node.url);
    if (!node.id || !url || linearUploadId(url)) return [];
    return [{
      id: node.id,
      name: node.title?.trim() || url,
      mimeType: "text/uri-list",
      url,
      ...(node.createdAt ? { createdAt: node.createdAt } : {}),
    }];
  });
  return [...uploaded, ...links];
};

const linearIssue = (issue: LinearIssue, states?: readonly LinearState[]): TaskTrackerTaskDto => {
  const id = String(issue.id ?? "");
  const key = String(issue.identifier ?? id);
  const assignee = issue.assignee && (issue.assignee.name || issue.assignee.displayName) ? linearPerson(issue.assignee) : null;
  const priority = linearPriority(issue.priority, issue.priorityLabel);
  const attachments = issueAttachments(issue, id);
  const comments: TaskTrackerCommentDto[] = (issue.comments?.nodes ?? [])
    .filter((comment) => comment.id)
    .map((comment) => ({
      id: String(comment.id),
      author: String(comment.user?.name || comment.user?.displayName || "Unknown"),
      ...(comment.user?.avatarUrl ? { authorAvatarUrl: comment.user.avatarUrl } : {}),
      text: String(comment.body ?? ""),
      ...(comment.createdAt ? { createdAt: comment.createdAt } : {}),
    }))
    // Oldest first, as the other trackers read.
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
  const teamId = issue.team?.id;
  const projectId = issue.project?.id;
  return {
    provider: "linear",
    id,
    key,
    title: String(issue.title ?? "Untitled Linear issue"),
    description: String(issue.description ?? ""),
    ...(webUrl(issue.url) ? { url: webUrl(issue.url)! } : {}),
    ...(teamId ? { boardId: projectId ? `${teamId}:${projectId}` : teamId, projectId: teamId } : {}),
    ...(issue.team?.key ? { projectKey: issue.team.key } : {}),
    status: linearStatus(issue.state),
    ...(states ? { availableStatuses: boardStates(states).map(linearStatus) } : {}),
    labels: (issue.labels?.nodes ?? []).map((label) => String(label.name ?? "")).filter(Boolean),
    assignees: assignee ? [assignee.name] : [],
    ...(assignee ? { assigneePeople: [assignee] } : {}),
    ...(priority ? { priority } : {}),
    ...(issue.dueDate ? { dueAt: issue.dueDate } : {}),
    ...(issue.updatedAt ? { updatedAt: issue.updatedAt } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(comments.length > 0 ? { comments, commentCount: comments.length } : {}),
  };
};

/** Board ids: a team (`teamId`) or one Linear project inside it
 *  (`teamId:projectId`). */
export const linearBoardId = (teamId: string, projectId?: string): string =>
  projectId ? `${teamId}:${projectId}` : teamId;

const parseBoard = (boardId: string): { teamId: string; projectId?: string } => {
  const parts = identifier(boardId, "boardId").split(":");
  if (parts.length > 2 || !parts[0] || parts[1] === "") throw error("Linear board id is not valid", "invalid-input");
  return { teamId: parts[0], ...(parts[1] ? { projectId: parts[1] } : {}) };
};

const teamUrl = (urlKey: string | undefined, key: string | undefined): string | undefined =>
  urlKey && key ? `https://linear.app/${encodeURIComponent(urlKey)}/team/${encodeURIComponent(key)}/all` : undefined;

export interface LinearClientOptions {
  apiKey: string;
  fetchImpl?: FetchFn;
  endpoint?: string;
}

export function createLinearClient(options: LinearClientOptions): ProviderClient {
  const apiKey = required(options.apiKey, "LINEAR_API_KEY");
  const endpoint = options.endpoint ?? LINEAR_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const read = <T extends object>(query: string, variables: Record<string, unknown> = {}) =>
    graphql<T>(fetchImpl, endpoint, apiKey, query, variables, false);
  const write = <T extends object>(query: string, variables: Record<string, unknown>) =>
    graphql<T>(fetchImpl, endpoint, apiKey, query, variables, true);
  /** A mutation that answered `success: false` applied nothing. */
  const succeeded = (payload: { success?: boolean } | null | undefined, refusal: string): void => {
    if (payload?.success !== true) {
      throw Object.assign(error(refusal, "unavailable"), { mutationOutcome: "rejected" });
    }
  };

  const teamStates = async (teamId: string): Promise<LinearState[]> => {
    const data = await read<{ team: { states?: { nodes?: LinearState[] } } }>(
      `query TeamStates($id: String!) { team(id: $id) { id ${STATES_FIELDS} } }`,
      { id: identifier(teamId, "teamId") },
    );
    return data.team.states?.nodes ?? [];
  };

  const detail = async (taskId: string): Promise<TaskTrackerTaskDto> => {
    const data = await read<{ issue: LinearIssue }>(
      `query Issue($id: String!) {
        issue(id: $id) {
          ${ISSUE_FIELDS}
          team { id key ${STATES_FIELDS} }
          comments(first: 50) { nodes { id body createdAt user { id name displayName avatarUrl } } }
        }
      }`,
      { id: identifier(taskId, "taskId") },
    );
    return linearIssue(data.issue, data.issue.team?.states?.nodes ?? []);
  };

  const setState = async (taskId: string, stateId: string): Promise<TaskTrackerTaskDto> => {
    const data = await write<{ issueUpdate: { success?: boolean } }>(
      `mutation SetState($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
      { id: identifier(taskId, "taskId"), stateId: identifier(stateId, "statusId") },
    );
    succeeded(data.issueUpdate, "Linear didn’t change the issue’s status");
    return detail(taskId);
  };

  return {
    async currentUser() {
      const data = await read<{ viewer: LinearUser }>("query Viewer { viewer { id name displayName avatarUrl } }");
      return linearPerson(data.viewer);
    },

    async listProjects() {
      const data = await read<{
        teams: { nodes?: Array<{ id?: string; key?: string; name?: string }> };
        organization: { urlKey?: string };
      }>("query Teams { organization { urlKey } teams(first: 100) { nodes { id key name } } }");
      return (data.teams.nodes ?? []).filter((team) => team.id).map((team): TaskTrackerProjectDto => {
        const url = teamUrl(data.organization.urlKey, team.key);
        return {
          provider: "linear",
          id: String(team.id),
          key: String(team.key ?? ""),
          name: String(team.name ?? team.key ?? "Untitled Linear team"),
          ...(url ? { url } : {}),
        };
      });
    },

    async listBoards(projectId) {
      const data = await read<{
        organization: { urlKey?: string };
        teams: {
          nodes?: Array<{
            id?: string;
            key?: string;
            name?: string;
            projects?: { nodes?: Array<{ id?: string; name?: string; url?: string }> };
          }>;
        };
      }>(
        `query Boards($teamFilter: TeamFilter, $projectFilter: ProjectFilter) {
          organization { urlKey }
          teams(first: 50, filter: $teamFilter) {
            nodes { id key name projects(first: 50, filter: $projectFilter) { nodes { id name url } } }
          }
        }`,
        {
          ...(projectId ? { teamFilter: { id: { eq: identifier(projectId, "projectId") } } } : {}),
          // Finished projects leave the picker, as they leave Linear's sidebar.
          projectFilter: { status: { type: { nin: ["completed", "canceled"] } } },
        },
      );
      const teams = (data.teams.nodes ?? []).filter((team) => team.id);
      // A project of several teams shows once per team; its name then says which.
      const shared = new Map<string, number>();
      for (const team of teams) {
        for (const project of team.projects?.nodes ?? []) {
          if (project.id) shared.set(project.id, (shared.get(project.id) ?? 0) + 1);
        }
      }
      return teams.flatMap((team): TaskTrackerBoardDto[] => {
        const teamId = String(team.id);
        const key = team.key ? String(team.key) : undefined;
        const url = teamUrl(data.organization.urlKey, key);
        const board: TaskTrackerBoardDto = {
          provider: "linear",
          id: linearBoardId(teamId),
          name: String(team.name ?? key ?? "Untitled Linear team"),
          type: "kanban",
          projectId: teamId,
          ...(key ? { projectKey: key } : {}),
          ...(url ? { url } : {}),
        };
        const projects = (team.projects?.nodes ?? []).filter((project) => project.id).map((project): TaskTrackerBoardDto => {
          const name = String(project.name ?? "Untitled Linear project");
          const projectUrl = webUrl(project.url);
          return {
            provider: "linear",
            id: linearBoardId(teamId, String(project.id)),
            name: (shared.get(String(project.id)) ?? 0) > 1 && key ? `${name} · ${key}` : name,
            type: "kanban",
            projectId: teamId,
            ...(key ? { projectKey: key } : {}),
            ...(projectUrl ? { url: projectUrl } : {}),
          };
        });
        return [board, ...projects];
      });
    },

    async listTasks(query) {
      const limit = limitOf(query.limit);
      const board = query.boardId ? parseBoard(query.boardId) : null;
      const teamId = board?.teamId ?? (query.projectId ? identifier(query.projectId, "projectId") : "");
      if (!teamId) throw error("boardId or projectId is required for Linear issues", "invalid-input");
      const data = await read<{ issues: { nodes?: LinearIssue[] } }>(
        `query Issues($filter: IssueFilter, $first: Int) {
          issues(first: $first, filter: $filter, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
        }`,
        {
          first: limit,
          filter: {
            and: [
              { team: { id: { eq: teamId } } },
              ...(board?.projectId ? [{ project: { id: { eq: board.projectId } } }] : []),
              { state: { type: { neq: "duplicate" } } },
              // Open work, plus what closed lately: a board of years of
              // finished issues would push the open ones out of the page.
              {
                or: [
                  { state: { type: { nin: ["completed", "canceled"] } } },
                  { completedAt: { gt: RECENTLY_CLOSED } },
                  { canceledAt: { gt: RECENTLY_CLOSED } },
                ],
              },
            ],
          },
        },
      );
      // The most recently updated issues, shown most urgent first and then in
      // Linear's manual order.
      return (data.issues.nodes ?? [])
        .filter((issue) => issue.id)
        .sort((left, right) =>
          PRIORITY_ORDER[linearPriority(left.priority)?.level ?? "none"] - PRIORITY_ORDER[linearPriority(right.priority)?.level ?? "none"]
          || (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
        .map((issue) => linearIssue(issue));
    },

    getTask: detail,

    updateStatus: setState,

    async updateTask(taskId, input) {
      const changes: Record<string, string> = {};
      if (input.title !== undefined) changes.title = boundedText(input.title, "title", TITLE_MAX);
      if (input.description !== undefined) {
        changes.description = boundedText(input.description, "description", DESCRIPTION_MAX, true);
      }
      if (Object.keys(changes).length > 0) {
        const data = await write<{ issueUpdate: { success?: boolean } }>(
          `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
          { id: identifier(taskId, "taskId"), input: changes },
        );
        succeeded(data.issueUpdate, "Linear didn’t save the issue");
      }
      return detail(taskId);
    },

    async listColumns(boardId) {
      const { teamId } = parseBoard(boardId);
      return {
        columns: boardStates(await teamStates(teamId)).map((state): TaskTrackerColumnDto => ({
          id: state.id,
          name: state.name,
          category: linearCategory(state.type),
          statusIds: [state.id],
        })),
        // Statuses belong to the whole team and keep Linear's fixed category
        // order, so they are edited in Linear's team settings.
        editable: false,
        manageUrl: LINEAR_TEAMS_SETTINGS,
      };
    },

    async moveTask(taskId, boardId, columnId) {
      const { teamId } = parseBoard(boardId);
      const state = boardStates(await teamStates(teamId)).find((item) => item.id === identifier(columnId, "columnId"));
      if (!state) throw error("Linear status was not found on this team", "not-found");
      return setState(taskId, state.id);
    },

    async createTask(input) {
      const title = boundedText(input.title, "title", TITLE_MAX);
      const description = boundedText(input.description, "description", DESCRIPTION_MAX, true);
      const board = input.boardId ? parseBoard(input.boardId) : null;
      const teamId = board?.teamId ?? input.projectId?.trim() ?? "";
      if (!teamId) throw error("Choose a Linear team or board for the new issue", "invalid-input");
      const data = await write<{ issueCreate: { success?: boolean; issue?: LinearIssue | null } }>(
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} team { id key ${STATES_FIELDS} } } }
        }`,
        {
          input: {
            teamId: identifier(teamId, "teamId"),
            ...(board?.projectId ? { projectId: board.projectId } : {}),
            title,
            ...(description ? { description } : {}),
          },
        },
      );
      succeeded(data.issueCreate, "Linear didn’t create the issue");
      const issue = data.issueCreate.issue;
      if (!issue?.id) throw error("Linear did not return the new issue", "unavailable");
      // Linear answers with the whole issue; reading it back again could fail
      // after the issue exists and invite a duplicate.
      return linearIssue(issue, issue.team?.states?.nodes ?? []);
    },

    async createBoard(input) {
      const name = boundedText(input.name, "name", BOARD_NAME_MAX);
      if (!input.projectId?.trim()) throw error("Choose a Linear team for the new project", "invalid-input");
      const teamId = identifier(input.projectId, "projectId");
      const data = await write<{ projectCreate: { success?: boolean; project?: { id?: string; name?: string; url?: string } | null } }>(
        `mutation CreateProject($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name url } } }`,
        { input: { name, teamIds: [teamId] } },
      );
      succeeded(data.projectCreate, "Linear didn’t create the project");
      const project = data.projectCreate.project;
      if (!project?.id) throw error("Linear did not return the new project", "unavailable");
      const url = webUrl(project.url);
      return {
        provider: "linear",
        id: linearBoardId(teamId, String(project.id)),
        name: String(project.name ?? name),
        type: "kanban",
        projectId: teamId,
        ...(url ? { url } : {}),
      };
    },

    async addComment(taskId, text) {
      const data = await write<{ commentCreate: { success?: boolean } }>(
        `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: await issueUuid(taskId), body: boundedText(text, "comment", COMMENT_MAX) } },
      );
      succeeded(data.commentCreate, "Linear didn’t add the comment");
    },

    async addAttachments(taskId, files) {
      const images = imageFiles(files);
      const issueId = await issueUuid(taskId);
      for (const file of images) {
        // Linear stores the bytes in its cloud storage first; the PUT carries
        // only the headers Linear returned, never the API key.
        const data = await write<{
          fileUpload: {
            success?: boolean;
            uploadFile?: { uploadUrl?: string; assetUrl?: string; headers?: Array<{ key?: string; value?: string }> } | null;
          };
        }>(
          `mutation Upload($contentType: String!, $filename: String!, $size: Int!) {
            fileUpload(contentType: $contentType, filename: $filename, size: $size) {
              success uploadFile { uploadUrl assetUrl headers { key value } }
            }
          }`,
          { contentType: file.mimeType, filename: file.name, size: file.bytes.length },
        );
        succeeded(data.fileUpload, "Linear didn’t accept the image");
        const target = data.fileUpload.uploadFile;
        let uploadUrl: URL;
        try {
          uploadUrl = new URL(String(target?.uploadUrl ?? ""));
        } catch {
          throw error("Linear did not return an upload address", "unavailable");
        }
        // The upload address is a signed URL on Linear's cloud storage, not
        // uploads.linear.app, so only HTTPS is required of it: it receives the
        // image the person chose for Linear and the headers Linear returned,
        // never the API key. The asset must be a Linear upload.
        if (uploadUrl.protocol !== "https:" || !linearUploadId(target?.assetUrl)) {
          throw error("Linear returned an unexpected upload address", "unavailable");
        }
        const headers: Record<string, string> = {
          "content-type": file.mimeType,
          "cache-control": "public, max-age=31536000",
        };
        // Header names are case-insensitive; Linear's own win.
        for (const header of target?.headers ?? []) {
          if (header.key && typeof header.value === "string") headers[header.key.toLowerCase()] = header.value;
        }
        let response: Response;
        try {
          response = await fetchImpl(uploadUrl, {
            method: "PUT",
            headers,
            body: new Blob([file.bytes], { type: file.mimeType }),
            signal: AbortSignal.timeout(60_000),
          });
        } catch {
          throw error("Linear’s file storage is unreachable", "unavailable");
        }
        if (!response.ok) throw statusError("Linear file storage", response.status, response.statusText, "PUT", "");
        const attached = await write<{ attachmentCreate: { success?: boolean } }>(
          `mutation Attach($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`,
          { input: { issueId, title: file.name, url: target!.assetUrl } },
        );
        succeeded(attached.attachmentCreate, "Linear didn’t attach the image");
      }
    },

    // Linear keeps no smaller copies, so a preview reads the file itself.
    async attachmentContent(taskId, attachmentId) {
      const wanted = identifier(attachmentId, "attachmentId");
      // Only files of this issue are served, never an arbitrary address.
      const data = await read<{ issue: Pick<LinearIssue, "id" | "description" | "attachments"> }>(
        `query IssueFiles($id: String!) { issue(id: $id) { id description attachments(first: 50) { nodes { id title url createdAt } } } }`,
        { id: identifier(taskId, "taskId") },
      );
      const upload = issueUploads(data.issue).find((item) => item.id === wanted);
      if (!upload) throw error("Attachment was not found on this task", "not-found");
      const url = new URL(upload.url);
      // The key goes only to Linear's own file host.
      if (url.protocol !== "https:" || url.hostname !== UPLOADS_HOST) {
        throw error("Linear returned an unexpected attachment address", "unavailable");
      }
      return requestBinary(
        "Linear",
        fetchImpl,
        url,
        { authorization: authorization(apiKey) },
        upload.name,
        upload.mimeType === "image/*" ? "application/octet-stream" : upload.mimeType,
      );
    },

    async archiveTask(taskId) {
      const data = await write<{ issueArchive: { success?: boolean } }>(
        `mutation Archive($id: String!) { issueArchive(id: $id) { success } }`,
        { id: identifier(taskId, "taskId") },
      );
      succeeded(data.issueArchive, "Linear didn’t archive this issue");
    },

    async deleteTask(taskId) {
      // Linear keeps a deleted issue in its trash for 30 days.
      const data = await write<{ issueDelete: { success?: boolean } }>(
        `mutation Delete($id: String!) { issueDelete(id: $id) { success } }`,
        { id: identifier(taskId, "taskId") },
      );
      succeeded(data.issueDelete, "Linear didn’t delete this issue");
    },
  };

  /** Comment and attachment inputs take the issue's UUID, not its key. */
  async function issueUuid(taskId: string): Promise<string> {
    const clean = identifier(taskId, "taskId");
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) return clean;
    const data = await read<{ issue: { id?: string } }>(`query IssueId($id: String!) { issue(id: $id) { id } }`, { id: clean });
    if (!data.issue.id) throw error("Linear issue was not found", "not-found");
    return data.issue.id;
  }
}

/** Confirms a Linear API key and returns the public account identity. */
export async function verifyLinearAccount(
  credentials: { apiKey: string; fetchImpl?: FetchFn; endpoint?: string },
): Promise<TaskTrackerAccountDto> {
  const apiKey = required(credentials.apiKey, "API key");
  const data = await graphql<{
    viewer: LinearUser;
    organization: { name?: string; urlKey?: string };
  }>(
    credentials.fetchImpl ?? fetch,
    credentials.endpoint ?? LINEAR_ENDPOINT,
    apiKey,
    "query Me { viewer { id name displayName email avatarUrl } organization { name urlKey } }",
    {},
    false,
  ).catch((cause: Error & { httpStatus?: number }) => {
    if (cause.httpStatus === 401 || cause.httpStatus === 403) {
      throw error("Linear rejected this API key", "invalid-input");
    }
    throw cause;
  });
  const urlKey = data.organization.urlKey;
  return {
    name: String(data.viewer.name || data.viewer.displayName || data.viewer.email || "Linear member"),
    ...(data.viewer.email ? { email: data.viewer.email } : {}),
    ...(data.viewer.avatarUrl ? { avatarUrl: data.viewer.avatarUrl } : {}),
    ...(urlKey ? { site: `https://linear.app/${encodeURIComponent(urlKey)}` } : {}),
  };
}
