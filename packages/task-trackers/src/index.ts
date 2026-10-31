import type {
  SessionEvent,
  TaskCompletedData,
  TaskSelectedData,
  TaskStatusChangedData,
  TaskTrackerAccountDto,
  TaskTrackerAttachmentDto,
  TaskTrackerBoardDto,
  TaskTrackerBoardType,
  TaskTrackerColumnDto,
  TaskTrackerCommentDto,
  TaskTrackerCreateBoardInput,
  TaskTrackerPersonDto,
  TaskTrackerPriority,
  TaskTrackerPriorityDto,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
  TaskTrackerProviderSource,
  TaskTrackerService,
  TaskTrackerSessionTaskDto,
  TaskTrackerStatusCategory,
  TaskTrackerStatusDto,
  TaskTrackerTaskDto,
} from "@polyth/contracts";
import {
  DEFAULT_TASK_TRACKER_PREFERENCES,
  TASK_TRACKER_PROVIDERS,
  type TaskTrackerPreferences,
} from "./types.ts";
import {
  attachmentContentPath,
  BOARD_NAME_MAX,
  boundedText,
  categoryOfName,
  COLUMN_NAME_MAX,
  columnPosition,
  COMMENT_MAX,
  deniedWrite,
  DESCRIPTION_MAX,
  error,
  identifier,
  imageFiles,
  imageTypeOfName,
  limitOf,
  multipart,
  positionAt,
  refused,
  requestBinary,
  requestJson,
  required,
  TITLE_MAX,
  type FetchFn,
  type ProviderClient,
} from "./common.ts";
import { createLinearClient } from "./linear.ts";

export * from "./types.ts";
export {
  attachmentContentPath,
  imageFiles,
  positionAt,
  providerReason,
  type FetchFn,
  type ProviderClient,
} from "./common.ts";
export { createLinearClient, verifyLinearAccount, type LinearClientOptions } from "./linear.ts";

const boardTypeOf = (value: TaskTrackerCreateBoardInput["type"]): "kanban" | "scrum" =>
  value === "scrum" ? "scrum" : "kanban";

/** Plain text as an Atlassian document: one paragraph per line. */
export const jiraDocument = (text: string) => ({
  type: "doc",
  version: 1,
  content: text.split("\n").map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : [],
  })),
});

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
    assignee?: JiraUser | null;
    priority?: { name?: string } | null;
    duedate?: string | null;
    updated?: string;
    project?: { id?: string; key?: string };
    attachment?: Array<{
      id?: string | number;
      filename?: string;
      mimeType?: string;
      size?: number;
      content?: string;
      thumbnail?: string;
      created?: string;
    }>;
    comment?: {
      total?: number;
      comments?: Array<{
        id?: string | number;
        author?: { displayName?: string; avatarUrls?: Record<string, string> };
        body?: unknown;
        created?: string;
      }>;
    };
  };
}

interface JiraUser {
  accountId?: string;
  displayName?: string;
  avatarUrls?: Record<string, string>;
}

const jiraPerson = (user: JiraUser): TaskTrackerPersonDto => ({
  id: String(user.accountId ?? ""),
  name: String(user.displayName ?? ""),
  ...(user.avatarUrls?.["48x48"] ? { avatarUrl: user.avatarUrls["48x48"] } : {}),
});

/** Jira's priority names are configurable; the default scheme's names, and
 *  the usual alternatives, map onto one scale. */
export const jiraPriority = (name: string | undefined): TaskTrackerPriorityDto | undefined => {
  const clean = name?.trim();
  if (!clean) return undefined;
  const level: TaskTrackerPriority = /highest|blocker|critical|urgent/i.test(clean)
    ? "urgent"
    : /high|major/i.test(clean)
      ? "high"
      : /medium|normal/i.test(clean)
        ? "medium"
        : /low|minor|trivial/i.test(clean)
          ? "low"
          : "none";
  return { level, name: clean };
};

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
  const id = String(issue.id ?? key);
  const rawAttachments = Array.isArray(fields.attachment) ? fields.attachment : [];
  const attachments: TaskTrackerAttachmentDto[] = rawAttachments
    .filter((att) => att.id !== undefined && att.id !== null && String(att.id))
    .map((att) => ({
      id: String(att.id),
      name: String(att.filename ?? "attachment"),
      mimeType: String(att.mimeType || "application/octet-stream"),
      ...(typeof att.size === "number" ? { size: att.size } : {}),
      url: attachmentContentPath("jira", id, String(att.id)),
      ...(att.thumbnail ? { thumbnailUrl: attachmentContentPath("jira", id, String(att.id), true) } : {}),
      ...(att.created ? { createdAt: String(att.created) } : {}),
    }));
  const rawComments = Array.isArray(fields.comment?.comments) ? fields.comment.comments : [];
  const comments: TaskTrackerCommentDto[] = rawComments.map((c) => ({
    id: String(c.id ?? ""),
    author: String(c.author?.displayName ?? "Unknown"),
    ...(c.author?.avatarUrls?.["48x48"] ? { authorAvatarUrl: c.author.avatarUrls["48x48"] } : {}),
    text: jiraText(c.body).trim(),
    ...(c.created ? { createdAt: String(c.created) } : {}),
  }));
  const commentCount = typeof fields.comment?.total === "number" ? fields.comment.total : comments.length;
  const assignee = fields.assignee?.displayName ? jiraPerson(fields.assignee) : null;
  const priority = jiraPriority(fields.priority?.name);
  return {
    provider: "jira",
    id,
    key,
    title: String(fields.summary ?? "Untitled Jira issue"),
    description: jiraText(fields.description).trim(),
    url: new URL(`/browse/${encodeURIComponent(key)}`, baseUrl).toString(),
    projectId: fields.project?.id,
    projectKey: fields.project?.key,
    status: jiraStatus(fields.status),
    ...(availableStatuses ? { availableStatuses } : {}),
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    assignees: assignee ? [assignee.name] : [],
    ...(assignee ? { assigneePeople: [assignee] } : {}),
    ...(priority ? { priority } : {}),
    ...(fields.duedate ? { dueAt: fields.duedate } : {}),
    ...(fields.updated ? { updatedAt: fields.updated } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(comments.length > 0 ? { comments } : {}),
    ...(commentCount > 0 ? { commentCount } : {}),
  };
};

const JIRA_ISSUE_FIELDS = "summary,description,status,labels,assignee,priority,duedate,updated,project,attachment,comment";

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
    const fields = JIRA_ISSUE_FIELDS;
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
  const boardColumns = async (boardId: string): Promise<TaskTrackerColumnDto[]> => {
    const id = encodeURIComponent(identifier(boardId, "boardId"));
    const [config, statuses] = await Promise.all([
      request<{
        columnConfig?: { columns?: Array<{ name?: string; statuses?: Array<{ id?: string | number }> }> };
      }>(`/rest/agile/1.0/board/${id}/configuration`),
      // Categories only color the columns; a site that hides the status list
      // still shows the board.
      request<Array<{ id?: string | number; statusCategory?: { key?: string } }>>("/rest/api/3/status")
        .catch(() => []),
    ]);
    const categories = new Map((Array.isArray(statuses) ? statuses : [])
      .map((status) => [String(status.id ?? ""), statusCategory(status.statusCategory?.key)]));
    const seen = new Set<string>();
    return (config.columnConfig?.columns ?? []).map((column, index) => {
      const name = String(column.name ?? "").trim() || `Column ${index + 1}`;
      // Jira columns have no id; the name is stable across reorders.
      const columnId = seen.has(name) ? `${name} (${index + 1})` : name;
      seen.add(columnId);
      const statusIds = (column.statuses ?? []).map((status) => String(status.id ?? "")).filter(Boolean);
      const known = statusIds.map((statusId) => categories.get(statusId)).find((value) => value && value !== "unknown");
      return { id: columnId, name, category: known ?? categoryOfName(name), statusIds };
    });
  };

  return {
    async currentUser() {
      return jiraPerson(await request<JiraUser>("/rest/api/3/myself"));
    },

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
      const fields = JIRA_ISSUE_FIELDS;
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

    async listColumns(boardId) {
      return {
        columns: await boardColumns(boardId),
        // Jira's REST API has no write for board columns; they follow the
        // workflow and are edited in the board settings.
        editable: false,
        manageUrl: new URL(
          `/secure/RapidView.jspa?rapidView=${encodeURIComponent(identifier(boardId, "boardId"))}&tab=columns`,
          baseUrl,
        ).toString(),
      };
    },

    async moveTask(taskId, boardId, columnId) {
      const column = (await boardColumns(boardId)).find((item) => item.id === columnId);
      if (!column) throw error("Jira board column was not found", "not-found");
      const id = encodeURIComponent(identifier(taskId, "taskId"));
      const [issue, transitions] = await Promise.all([
        request<JiraIssue>(`/rest/api/3/issue/${id}`, {}, new URLSearchParams({ fields: "status" })),
        request<{ transitions?: Array<{ id?: string; to?: { id?: string } }> }>(`/rest/api/3/issue/${id}/transitions`),
      ]);
      if (column.statusIds.includes(String(issue.fields?.status?.id ?? ""))) return detail(taskId);
      const transition = (transitions.transitions ?? [])
        .find((item) => item.id && column.statusIds.includes(String(item.to?.id ?? "")));
      if (!transition?.id) {
        throw refused(`Jira's workflow has no transition from ${issue.fields?.status?.name ?? "this status"} to ${column.name}`);
      }
      await request<void>(`/rest/api/3/issue/${id}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: transition.id } }),
      });
      return detail(taskId);
    },

    async archiveTask(taskId) {
      const result = await request<{
        numberOfIssuesUpdated?: number;
        errors?: Record<string, { message?: string }>;
      }>("/rest/api/3/issue/archive", {
        method: "PUT",
        body: JSON.stringify({ issueIdsOrKeys: [identifier(taskId, "taskId")] }),
      }).catch((cause) => deniedWrite(
        cause,
        "The connected Jira account can’t archive this issue",
        "Archiving needs Jira Premium or Enterprise and the Archive issues permission.",
      ));
      if ((result?.numberOfIssuesUpdated ?? 0) < 1) {
        const reason = Object.values(result?.errors ?? {}).map((item) => item?.message).find(Boolean);
        throw refused(`Jira didn’t archive this issue${reason ? `: ${reason}` : ""}`);
      }
    },

    async deleteTask(taskId) {
      await request<void>(`/rest/api/3/issue/${encodeURIComponent(identifier(taskId, "taskId"))}`, {
        method: "DELETE",
      }).catch((cause) => deniedWrite(
        cause,
        "The connected Jira account can’t delete this issue",
        "Ask a project admin for the Delete issues permission.",
      ));
    },

    async updateStatus(taskId, statusId) {
      const id = encodeURIComponent(identifier(taskId, "taskId"));
      await request<void>(`/rest/api/3/issue/${id}/transitions`, {
        method: "POST",
        body: JSON.stringify({ transition: { id: identifier(statusId, "statusId") } }),
      });
      return detail(taskId);
    },

    async updateTask(taskId, input) {
      const id = encodeURIComponent(identifier(taskId, "taskId"));
      const fields: Record<string, unknown> = {};
      if (input.title !== undefined) {
        fields.summary = boundedText(input.title, "title", TITLE_MAX);
      }
      if (input.description !== undefined) {
        const desc = boundedText(input.description, "description", DESCRIPTION_MAX, true);
        fields.description = jiraDocument(desc);
      }
      if (Object.keys(fields).length > 0) {
        await request<void>(`/rest/api/3/issue/${id}`, {
          method: "PUT",
          body: JSON.stringify({ fields }),
        });
      }
      return detail(taskId);
    },

    async createTask(input) {
      const title = boundedText(input.title, "title", TITLE_MAX);
      const description = boundedText(input.description, "description", DESCRIPTION_MAX, true);
      let projectId = input.projectId?.trim() ?? "";
      if (!projectId && input.boardId) {
        const board = await request<{ location?: { projectId?: number | string } }>(
          `/rest/agile/1.0/board/${encodeURIComponent(identifier(input.boardId, "boardId"))}`,
        );
        projectId = String(board.location?.projectId ?? "");
      }
      if (!projectId) throw error("Choose a Jira project or board for the new issue", "invalid-input");
      const meta = await request<{
        issueTypes?: Array<{ id?: string; name?: string; subtask?: boolean }>;
        values?: Array<{ id?: string; name?: string; subtask?: boolean }>;
      }>(`/rest/api/3/issue/createmeta/${encodeURIComponent(identifier(projectId, "projectId"))}/issuetypes`);
      const types = (meta.issueTypes ?? meta.values ?? []).filter((type) => type.id && type.subtask !== true);
      const type = types.find((item) => item.name?.toLowerCase() === "task") ?? types[0];
      if (!type?.id) throw refused("This Jira project has no issue type Polyth can create");
      const created = await request<{ id?: string; key?: string }>("/rest/api/3/issue", {
        method: "POST",
        body: JSON.stringify({
          fields: {
            project: { id: projectId },
            issuetype: { id: type.id },
            summary: title,
            ...(description ? { description: jiraDocument(description) } : {}),
          },
        }),
      }).catch((cause) => deniedWrite(
        cause,
        "The connected Jira account can’t create issues in this project",
        "Ask a Jira admin for the Create issues permission, or choose another project.",
      ));
      const id = String(created.id ?? created.key ?? "");
      const key = String(created.key ?? id);
      // The issue exists now. A failed read-back must not report the create
      // as failed: the user would file it a second time.
      return detail(id).catch((): TaskTrackerTaskDto => ({
        provider: "jira",
        id,
        key,
        title,
        description,
        ...(created.key ? { url: new URL(`/browse/${encodeURIComponent(created.key)}`, baseUrl).toString() } : {}),
        ...(input.boardId ? { boardId: input.boardId } : {}),
        projectId,
        status: { id: "", name: "Unknown", category: "unknown" },
        availableStatuses: [],
        labels: [],
        assignees: [],
      }));
    },

    async createBoard(input) {
      const name = boundedText(input.name, "name", BOARD_NAME_MAX);
      if (!input.projectId?.trim()) throw error("Choose a Jira project for the new board", "invalid-input");
      const projectId = identifier(input.projectId, "projectId");
      const type = boardTypeOf(input.type);
      const project = await request<{ id?: string | number; key?: string }>(
        `/rest/api/3/project/${encodeURIComponent(projectId)}`,
      );
      const key = String(project.key ?? "");
      const id = String(project.id ?? projectId);
      if (!key) throw error("This Jira project has no key", "unavailable");
      // A board needs a saved filter; scope it to the project and share it
      // with the project so teammates see the board too. Filter names are
      // unique per owner, so retry once with a suffix on a name clash.
      const jql = `project = "${key.replaceAll('"', '\\"')}" ORDER BY Rank ASC`;
      const createFilter = (filterName: string) => request<{ id?: string | number }>("/rest/api/3/filter", {
        method: "POST",
        body: JSON.stringify({
          name: filterName,
          jql,
          sharePermissions: [{ type: "project", project: { id } }],
        }),
      });
      const filter = await createFilter(name).catch((cause: Error & { httpStatus?: number }) =>
        cause.httpStatus === 400
          ? createFilter(`${name} (${Date.now().toString(36)})`)
          : Promise.reject(cause));
      if (filter.id === undefined) throw error("Jira did not return the board filter", "unavailable");
      const board = await request<{
        id?: number | string;
        name?: string;
        type?: string;
        location?: { projectId?: number | string; projectKey?: string };
      }>("/rest/agile/1.0/board", {
        method: "POST",
        body: JSON.stringify({
          name,
          type,
          filterId: Number(filter.id),
          location: { type: "project", projectKeyOrId: id },
        }),
      });
      const boardId = String(board.id ?? "");
      if (!boardId) throw error("Jira did not return the new board", "unavailable");
      return {
        provider: "jira",
        id: boardId,
        name: String(board.name ?? name),
        type: board.type === "scrum" ? "scrum" : "kanban",
        projectId: String(board.location?.projectId ?? id),
        projectKey: board.location?.projectKey ?? key,
        url: new URL(`/secure/RapidBoard.jspa?rapidView=${encodeURIComponent(boardId)}`, baseUrl).toString(),
      };
    },

    async addComment(taskId, text) {
      await request<unknown>(`/rest/api/3/issue/${encodeURIComponent(identifier(taskId, "taskId"))}/comment`, {
        method: "POST",
        body: JSON.stringify({ body: jiraDocument(boundedText(text, "comment", COMMENT_MAX)) }),
      });
    },

    async addAttachments(taskId, files) {
      const id = encodeURIComponent(identifier(taskId, "taskId"));
      for (const file of imageFiles(files)) {
        await request<unknown>(`/rest/api/3/issue/${id}/attachments`, {
          method: "POST",
          headers: { "x-atlassian-token": "no-check" },
          body: multipart(file),
          signal: AbortSignal.timeout(60_000),
        });
      }
    },

    async attachmentContent(taskId, attachmentId, preview) {
      const wanted = identifier(attachmentId, "attachmentId");
      // Only attachments of this issue are served, never an arbitrary id.
      const issue = await request<JiraIssue>(
        `/rest/api/3/issue/${encodeURIComponent(identifier(taskId, "taskId"))}`,
        {},
        new URLSearchParams({ fields: "attachment" }),
      );
      const attachment = (issue.fields?.attachment ?? []).find((item) => String(item.id ?? "") === wanted);
      if (!attachment) throw error("Attachment was not found on this task", "not-found");
      const kind = preview && attachment.thumbnail ? "thumbnail" : "content";
      return requestBinary(
        "Jira",
        fetchImpl,
        new URL(`/rest/api/3/attachment/${kind}/${encodeURIComponent(wanted)}`, baseUrl),
        headers,
        String(attachment.filename ?? "attachment"),
        String(attachment.mimeType || "application/octet-stream"),
      );
    },
  };
}

interface TrelloList {
  id?: string;
  name?: string;
  closed?: boolean;
  pos?: number;
}

interface TrelloAttachment {
  id?: string;
  name?: string;
  mimeType?: string;
  bytes?: number | null;
  url?: string;
  isUpload?: boolean;
  previews?: Array<{ url?: string; width?: number; height?: number }>;
  date?: string;
}

const TRELLO_CARD_FIELDS = "id,name,desc,url,idBoard,idList,labels,due,dueComplete,dateLastActivity,badges,idAttachmentCover";
const TRELLO_ATTACHMENT_FIELDS = "id,name,mimeType,bytes,url,isUpload,previews,date";
const TRELLO_MEMBER_FIELDS = "fullName,username,avatarUrl";

/** The smallest preview that still fills a card cover, else the largest one. */
const trelloPreview = (attachment: TrelloAttachment) => {
  const previews = (attachment.previews ?? []).filter((item) => item.url);
  const sorted = [...previews].sort((left, right) => (left.width ?? 0) - (right.width ?? 0));
  return sorted.find((item) => (item.width ?? 0) >= 600) ?? sorted.at(-1);
};

/** Trello's avatar URL is a prefix; a size makes it an image. */
const trelloAvatar = (avatarUrl: string | null | undefined): string | undefined =>
  avatarUrl ? `${avatarUrl}/50.png` : undefined;

const trelloPerson = (member: { id?: string; fullName?: string; username?: string; avatarUrl?: string | null }): TaskTrackerPersonDto => {
  const avatarUrl = trelloAvatar(member.avatarUrl);
  return {
    id: String(member.id ?? ""),
    name: String(member.fullName || member.username || ""),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
};

/** Trello leaves `mimeType` empty on many uploads; the file name still tells. */
const trelloMimeType = (attachment: TrelloAttachment): string => {
  if (attachment.mimeType) return attachment.mimeType;
  return imageTypeOfName(String(attachment.name ?? attachment.url ?? ""))
    ?? (attachment.isUpload === false ? "text/uri-list" : "application/octet-stream");
};

interface TrelloCard {
  id?: string;
  name?: string;
  desc?: string;
  url?: string;
  idBoard?: string;
  idList?: string;
  labels?: Array<{ name?: string; color?: string }>;
  members?: Array<{ id?: string; fullName?: string; username?: string; avatarUrl?: string | null }>;
  due?: string | null;
  dueComplete?: boolean;
  idAttachmentCover?: string | null;
  dateLastActivity?: string;
  badges?: { comments?: number; attachments?: number };
  attachments?: TrelloAttachment[];
  actions?: Array<{
    id?: string;
    date?: string;
    data?: { text?: string };
    memberCreator?: { fullName?: string; username?: string; avatarUrl?: string | null };
  }>;
}

const trelloStatuses = (lists: TrelloList[]): TaskTrackerStatusDto[] =>
  lists.filter((list) => list.id).map((list) => ({
    id: String(list.id),
    name: String(list.name ?? "Untitled list"),
    category: categoryOfName(String(list.name ?? ""), list.closed === true),
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
  const rawAttachments = Array.isArray(card.attachments) ? card.attachments : [];
  const attachments: TaskTrackerAttachmentDto[] = rawAttachments.filter((att) => att.id).map((att) => {
    const attachmentId = String(att.id);
    const mimeType = trelloMimeType(att);
    // Uploaded files need the connection's credentials; links open as they are.
    const upload = att.isUpload !== false;
    const image = mimeType.startsWith("image/");
    return {
      id: attachmentId,
      name: String(att.name || att.url || "attachment"),
      mimeType,
      ...(typeof att.bytes === "number" ? { size: att.bytes } : {}),
      ...(upload
        ? { url: attachmentContentPath("trello", id, attachmentId) }
        : att.url ? { url: att.url } : {}),
      ...(upload && (trelloPreview(att) || image)
        ? { thumbnailUrl: attachmentContentPath("trello", id, attachmentId, true) }
        : {}),
      ...(att.date ? { createdAt: att.date } : {}),
    };
  });
  // Trello lists comments newest first; the card reads oldest first, as Jira does.
  const rawActions = Array.isArray(card.actions) ? [...card.actions].reverse() : [];
  const comments: TaskTrackerCommentDto[] = rawActions.map((act) => ({
    id: String(act.id ?? ""),
    author: String(act.memberCreator?.fullName || act.memberCreator?.username || "Unknown"),
    ...(act.memberCreator?.avatarUrl ? { authorAvatarUrl: trelloAvatar(act.memberCreator.avatarUrl) } : {}),
    text: String(act.data?.text ?? ""),
    ...(act.date ? { createdAt: act.date } : {}),
  }));
  const commentCount = typeof card.badges?.comments === "number" ? card.badges.comments : comments.length;
  const people = (card.members ?? []).map(trelloPerson).filter((person) => person.name);
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
    assignees: people.map((person) => person.name),
    ...(people.length > 0 ? { assigneePeople: people } : {}),
    ...(card.due ? { dueAt: card.due } : {}),
    ...(card.dateLastActivity ? { updatedAt: card.dateLastActivity } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(card.idAttachmentCover && attachments.some((att) => att.id === card.idAttachmentCover)
      ? { coverAttachmentId: card.idAttachmentCover }
      : {}),
    ...(comments.length > 0 ? { comments } : {}),
    ...(commentCount > 0 ? { commentCount } : {}),
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
      fields: TRELLO_CARD_FIELDS,
      members: "true",
      member_fields: TRELLO_MEMBER_FIELDS,
      attachments: "true",
      attachment_fields: TRELLO_ATTACHMENT_FIELDS,
      actions: "commentCard",
      actions_limit: "50",
      action_memberCreator_fields: "fullName,username,avatarUrl",
    }));
    const statuses = trelloStatuses(await lists(String(card.idBoard ?? "")));
    return trelloCard(card, statuses);
  };
  const trelloColumn = (list: TrelloList): TaskTrackerColumnDto => ({
    id: String(list.id),
    name: String(list.name ?? "Untitled list"),
    category: categoryOfName(String(list.name ?? "")),
    statusIds: [String(list.id)],
  });
  const openLists = async (boardId: string): Promise<TrelloList[]> =>
    (await lists(boardId))
      .filter((list) => list.id && list.closed !== true)
      .sort((left, right) => (left.pos ?? 0) - (right.pos ?? 0));
  const openList = async (boardId: string, columnId: string) => {
    const open = await openLists(boardId);
    const list = open.find((item) => item.id === identifier(columnId, "columnId"));
    if (!list) throw error("Trello list was not found on this board", "not-found");
    return { open, list };
  };
  const writeList = (path: string, body: URLSearchParams) => request<TrelloList>(path, {
    method: "PUT",
    body,
  }).catch((cause) => deniedWrite(
    cause,
    "The connected Trello account can’t change lists on this board",
    "Ask a board admin to make it a board member with edit rights.",
  ));
  const moveCard = async (taskId: string, listId: string) => {
    await request<TrelloCard>(
      `/1/cards/${encodeURIComponent(identifier(taskId, "taskId"))}`,
      { method: "PUT" },
      new URLSearchParams({ idList: identifier(listId, "statusId") }),
    );
    return detail(taskId);
  };

  return {
    async currentUser() {
      return trelloPerson(await request<{ id?: string; fullName?: string; username?: string; avatarUrl?: string | null }>(
        "/1/members/me",
        {},
        new URLSearchParams({ fields: TRELLO_MEMBER_FIELDS }),
      ));
    },

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
            fields: TRELLO_CARD_FIELDS,
            members: "true",
            member_fields: TRELLO_MEMBER_FIELDS,
            attachments: "true",
            attachment_fields: TRELLO_ATTACHMENT_FIELDS,
            limit: String(limitOf(query.limit)),
          }),
        ),
        lists(boardId),
      ]);
      const statuses = trelloStatuses(boardLists);
      return cards.map((card) => trelloCard(card, statuses));
    },

    getTask: detail,

    updateStatus: moveCard,

    async updateTask(taskId, input) {
      const body = new URLSearchParams();
      if (input.title !== undefined) {
        body.set("name", boundedText(input.title, "title", TITLE_MAX));
      }
      if (input.description !== undefined) {
        body.set("desc", boundedText(input.description, "description", DESCRIPTION_MAX, true));
      }
      if ([...body.keys()].length > 0) {
        await request<TrelloCard>(
          `/1/cards/${encodeURIComponent(identifier(taskId, "taskId"))}`,
          { method: "PUT" },
          body,
        );
      }
      return detail(taskId);
    },

    async listColumns(boardId) {
      return { columns: (await openLists(boardId)).map(trelloColumn), editable: true, removal: "archive" };
    },

    async createColumn(boardId, input) {
      const name = boundedText(input.name, "name", COLUMN_NAME_MAX);
      const open = await openLists(boardId);
      const pos = positionAt(open.map((list) => list.pos ?? 0), columnPosition(input.position, open.length));
      const created = await request<TrelloList>("/1/lists", {
        method: "POST",
        body: new URLSearchParams({ idBoard: identifier(boardId, "boardId"), name, pos: String(pos) }),
      }).catch((cause) => deniedWrite(
        cause,
        "The connected Trello account can’t add lists to this board",
        "Ask a board admin to make it a board member with edit rights, or choose another board.",
      ));
      if (!created?.id) throw error("Trello did not return the new list", "unavailable");
      return trelloColumn(created);
    },

    async updateColumn(boardId, columnId, input) {
      const { open, list } = await openList(boardId, columnId);
      const body = new URLSearchParams();
      if (input.name !== undefined) body.set("name", boundedText(input.name, "name", COLUMN_NAME_MAX));
      if (input.position !== undefined) {
        const others = open.filter((item) => item.id !== list.id);
        body.set("pos", String(positionAt(others.map((item) => item.pos ?? 0), columnPosition(input.position, others.length))));
      }
      if ([...body.keys()].length === 0) return trelloColumn(list);
      const updated = await writeList(`/1/lists/${encodeURIComponent(String(list.id))}`, body);
      return trelloColumn({ ...list, ...(updated ?? {}) });
    },

    async removeColumn(boardId, columnId) {
      const { list } = await openList(boardId, columnId);
      // Trello archives a list together with its cards; both can be restored
      // from the board's archive.
      await writeList(`/1/lists/${encodeURIComponent(String(list.id))}/closed`, new URLSearchParams({ value: "true" }));
    },

    async moveTask(taskId, boardId, columnId) {
      const { list } = await openList(boardId, columnId);
      return moveCard(taskId, String(list.id));
    },

    async archiveTask(taskId) {
      // A closed card stays restorable from the board's archive.
      await request<TrelloCard>(
        `/1/cards/${encodeURIComponent(identifier(taskId, "taskId"))}`,
        { method: "PUT" },
        new URLSearchParams({ closed: "true" }),
      ).catch((cause) => deniedWrite(
        cause,
        "The connected Trello account can’t archive cards on this board",
        "Ask a board admin to make it a board member with edit rights.",
      ));
    },

    async deleteTask(taskId) {
      await request<unknown>(
        `/1/cards/${encodeURIComponent(identifier(taskId, "taskId"))}`,
        { method: "DELETE" },
      ).catch((cause) => deniedWrite(
        cause,
        "The connected Trello account can’t delete cards on this board",
        "Ask a board admin to make it a board member with edit rights.",
      ));
    },

    async createTask(input) {
      const title = boundedText(input.title, "title", TITLE_MAX);
      const description = boundedText(input.description, "description", DESCRIPTION_MAX, true);
      if (!input.boardId) throw error("Choose a Trello board for the new card", "invalid-input");
      const all = await lists(input.boardId);
      const open = trelloStatuses(all.filter((list) => list.closed !== true));
      let list = open.find((status) => status.category === "todo") ?? open[0];
      if (!list) {
        // A fresh or emptied board has nowhere to put a card; Trello's own UI
        // asks for a list first, so add one rather than refuse.
        const created = await request<TrelloList>("/1/lists", {
          method: "POST",
          body: new URLSearchParams({ idBoard: input.boardId, name: "To Do", pos: "top" }),
        }).catch((cause) => deniedWrite(
          cause,
          "The connected Trello account can’t add lists to this board",
          "Ask a board admin to make it a board member with edit rights, or choose another board.",
        ));
        if (!created?.id) throw error("Trello did not return the new list", "unavailable");
        all.push(created);
        list = trelloStatuses([created])[0]!;
      }
      // Fields go in a form body: in the query string a few thousand
      // non-Latin characters of description outgrow Trello's URL limit.
      const card = await request<TrelloCard>("/1/cards", {
        method: "POST",
        body: new URLSearchParams({
          idList: list.id,
          name: title,
          ...(description ? { desc: description } : {}),
          pos: "top",
        }),
      }).catch((cause) => deniedWrite(
        cause,
        "The connected Trello account can’t add cards to this board",
        "Ask a board admin to make it a board member with edit rights, or choose another board.",
      ));
      if (!card?.id) throw error("Trello did not return the new card", "unavailable");
      // Trello answers with the whole card; reading it back again could fail
      // after the card exists and invite a duplicate.
      return trelloCard({ idList: list.id, idBoard: input.boardId, ...card }, trelloStatuses(all));
    },

    async createBoard(input) {
      const name = boundedText(input.name, "name", BOARD_NAME_MAX);
      const organization = input.projectId?.trim() ? identifier(input.projectId, "projectId") : "";
      const board = await request<{
        id?: string;
        name?: string;
        url?: string;
        idOrganization?: string | null;
      }>("/1/boards", { method: "POST" }, new URLSearchParams({
        name,
        defaultLists: "true",
        ...(organization ? { idOrganization: organization } : {}),
      }));
      const id = String(board.id ?? "");
      if (!id) throw error("Trello did not return the new board", "unavailable");
      return {
        provider: "trello",
        id,
        name: String(board.name ?? name),
        type: "kanban",
        ...(board.idOrganization ? { projectId: board.idOrganization } : organization ? { projectId: organization } : {}),
        ...(board.url ? { url: board.url } : {}),
      };
    },

    async addComment(taskId, text) {
      await request<unknown>(
        `/1/cards/${encodeURIComponent(identifier(taskId, "taskId"))}/actions/comments`,
        { method: "POST", body: new URLSearchParams({ text: boundedText(text, "comment", COMMENT_MAX) }) },
      );
    },

    async addAttachments(taskId, files) {
      const id = encodeURIComponent(identifier(taskId, "taskId"));
      for (const file of imageFiles(files)) {
        await request<unknown>(
          `/1/cards/${id}/attachments`,
          { method: "POST", body: multipart(file), signal: AbortSignal.timeout(60_000) },
          new URLSearchParams({ name: file.name, mimeType: file.mimeType }),
        );
      }
    },

    async attachmentContent(taskId, attachmentId, preview) {
      // Trello answers 404 unless the attachment belongs to this card.
      const attachment = await request<TrelloAttachment>(
        `/1/cards/${encodeURIComponent(identifier(taskId, "taskId"))}/attachments/${encodeURIComponent(identifier(attachmentId, "attachmentId"))}`,
        {},
        new URLSearchParams({ fields: TRELLO_ATTACHMENT_FIELDS }),
      );
      if (attachment.isUpload === false) throw error("Linked attachments open in their own site", "invalid-input");
      const source = (preview ? trelloPreview(attachment)?.url : undefined) ?? attachment.url;
      let url: URL;
      try {
        url = new URL(String(source ?? ""));
      } catch {
        throw error("Trello did not return the attachment's file", "unavailable");
      }
      // The credentials go only to Trello itself.
      const host = url.hostname;
      if (url.protocol !== "https:" && host !== baseUrl.hostname) throw error("Trello returned an unexpected attachment address", "unavailable");
      if (host !== "trello.com" && !host.endsWith(".trello.com") && host !== baseUrl.hostname) {
        throw error("Trello returned an unexpected attachment address", "unavailable");
      }
      return requestBinary(
        "Trello",
        fetchImpl,
        url,
        { authorization: `OAuth oauth_consumer_key="${apiKey}", oauth_token="${apiToken}"` },
        String(attachment.name || "attachment"),
        trelloMimeType(attachment),
      );
    },
  };
}

const DEMO_STATUSES: readonly TaskTrackerStatusDto[] = [
  { id: "demo-todo", name: "To do", category: "todo" },
  { id: "demo-progress", name: "In progress", category: "in_progress" },
  { id: "demo-done", name: "Done", category: "done" },
];

/** The Linear sandbox mirrors a new Linear team's workflow. */
const LINEAR_DEMO_STATUSES: readonly TaskTrackerStatusDto[] = [
  { id: "demo-backlog", name: "Backlog", category: "todo" },
  { id: "demo-todo", name: "Todo", category: "todo" },
  { id: "demo-progress", name: "In Progress", category: "in_progress" },
  { id: "demo-review", name: "In Review", category: "in_progress" },
  { id: "demo-done", name: "Done", category: "done" },
  { id: "demo-canceled", name: "Canceled", category: "done" },
];

const demoStatuses = (provider: TaskTrackerProvider): readonly TaskTrackerStatusDto[] =>
  provider === "linear" ? LINEAR_DEMO_STATUSES : DEMO_STATUSES;

/** The sandbox account per tracker: someone with tasks on the demo board, so
 *  "assigned to me" shows what it does. */
const DEMO_VIEWERS: Record<TaskTrackerProvider, string> = {
  jira: "Alex Rivera",
  trello: "Nina Patel",
  linear: "Iris Novak",
};

const demoPerson = (name: string): TaskTrackerPersonDto => ({
  id: `demo-user-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  name,
});

const DEMO_PROJECTS: Record<TaskTrackerProvider, { key: string; name: string; board: string }> = {
  jira: { key: "POL", name: "Polyth Sandbox", board: "Product delivery" },
  trello: { key: "DEMO", name: "Product Sandbox", board: "Launch planning" },
  linear: { key: "ENG", name: "Engineering", board: "Engineering" },
};

interface DemoTaskSeed {
  id: string;
  key: string;
  title: string;
  description: string;
  statusId: string;
  labels: string[];
  assignees: string[];
  priority?: TaskTrackerPriority;
  dueAt?: string;
  attachments?: TaskTrackerAttachmentDto[];
  comments?: TaskTrackerCommentDto[];
}

const DEMO_PREVIEW_SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270' viewBox='0 0 480 270'><rect width='480' height='270' fill='%231e293b'/><rect x='40' y='40' width='400' height='190' rx='12' fill='%23334155'/><text x='240' y='140' dominant-baseline='middle' text-anchor='middle' fill='%23f8fafc' font-family='system-ui,sans-serif' font-size='20' font-weight='600'>Palette Preview</text></svg>";
const DEMO_RESPONSIVE_SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270' viewBox='0 0 480 270'><rect width='480' height='270' fill='%230f172a'/><rect x='30' y='30' width='120' height='210' rx='8' fill='%231e293b' stroke='%2338bdf8' stroke-width='2'/><rect x='170' y='30' width='280' height='210' rx='8' fill='%231e293b'/><text x='90' y='140' dominant-baseline='middle' text-anchor='middle' fill='%2338bdf8' font-family='system-ui,sans-serif' font-size='14'>Mobile</text><text x='310' y='140' dominant-baseline='middle' text-anchor='middle' fill='%2394a3b8' font-family='system-ui,sans-serif' font-size='16'>Desktop</text></svg>";
const DEMO_FEEDBACK_SVG = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='480' height='270' viewBox='0 0 480 270'><rect width='480' height='270' fill='%2318181b'/><circle cx='120' cy='135' r='50' fill='%2310b981' opacity='0.8'/><circle cx='240' cy='135' r='50' fill='%236366f1' opacity='0.8'/><circle cx='360' cy='135' r='50' fill='%23f59e0b' opacity='0.8'/><text x='240' y='220' dominant-baseline='middle' text-anchor='middle' fill='%23f4f4f5' font-family='system-ui,sans-serif' font-size='16'>Feedback Channels</text></svg>";

const DEMO_TASKS: Record<TaskTrackerProvider, readonly DemoTaskSeed[]> = {
  jira: [
    {
      id: "demo-jira-101",
      priority: "high",
      key: "POL-101",
      title: "Refine the project command palette",
      description: "Make high-frequency project actions faster to find and fully keyboard accessible.",
      statusId: "demo-todo",
      labels: ["UX", "Accessibility"],
      assignees: ["Maya Chen"],
      dueAt: "2026-08-29",
      attachments: [
        {
          id: "demo-att-101",
          name: "command-palette-mockup.png",
          mimeType: "image/png",
          size: 148200,
          url: DEMO_PREVIEW_SVG,
          thumbnailUrl: DEMO_PREVIEW_SVG,
          createdAt: "2026-08-25T11:20:00.000Z",
        },
      ],
      comments: [
        {
          id: "demo-comm-101-1",
          author: "Maya Chen",
          text: "Initial keyboard shortcut layout drafted. Alt+K or Cmd+K opens the quick action palette.",
          createdAt: "2026-08-26T14:30:00.000Z",
        },
        {
          id: "demo-comm-101-2",
          author: "Alex Rivera",
          text: "Verified focus traps and arrow navigation. Looks very clean.",
          createdAt: "2026-08-26T16:45:00.000Z",
        },
      ],
    },
    {
      id: "demo-jira-102",
      priority: "medium",
      key: "POL-102",
      title: "Add retry guidance to failed runs",
      description: "Show a concise recovery path when an agent run fails before producing output.",
      statusId: "demo-todo",
      labels: ["Reliability"],
      assignees: [],
      dueAt: "2026-09-02",
    },
    {
      id: "demo-jira-103",
      priority: "urgent",
      key: "POL-103",
      title: "Polish task tracker responsive layout",
      description: "Keep kanban columns, filters, and task details comfortable from phone to desktop.",
      statusId: "demo-progress",
      labels: ["Frontend", "Mobile"],
      assignees: ["Alex Rivera"],
      dueAt: "2026-08-27",
      attachments: [
        {
          id: "demo-att-103",
          name: "responsive-breakpoint-test.png",
          mimeType: "image/png",
          size: 215400,
          url: DEMO_RESPONSIVE_SVG,
          thumbnailUrl: DEMO_RESPONSIVE_SVG,
          createdAt: "2026-08-24T09:15:00.000Z",
        },
        {
          id: "demo-att-103-doc",
          name: "responsive-specs.pdf",
          mimeType: "application/pdf",
          size: 524000,
          createdAt: "2026-08-24T09:20:00.000Z",
        },
      ],
      comments: [
        {
          id: "demo-comm-103-1",
          author: "Alex Rivera",
          text: "Checked column overflow behavior on 375px mobile screen. Horizontal swipe feels natural.",
          createdAt: "2026-08-25T13:00:00.000Z",
        },
      ],
    },
    {
      id: "demo-jira-104",
      priority: "low",
      key: "POL-104",
      title: "Document session event retention",
      description: "Clarify retention, export, and deletion behavior for project-scoped session events.",
      statusId: "demo-progress",
      labels: ["Docs"],
      assignees: ["Sam Okafor"],
    },
    {
      id: "demo-jira-105",
      priority: "medium",
      key: "POL-105",
      title: "Ship accessible theme presets",
      description: "Validate theme contrast and expose appearance choices without changing palette identity.",
      statusId: "demo-done",
      labels: ["Themes", "Accessibility"],
      assignees: ["Priya Shah"],
    },
  ],
  trello: [
    {
      id: "demo-trello-21",
      key: "TR-21",
      title: "Collect launch feedback",
      description: "Group early feedback by workflow and turn repeated friction into actionable cards.",
      statusId: "demo-todo",
      labels: ["Research"],
      assignees: ["Jordan Lee"],
      dueAt: "2026-08-31",
      attachments: [
        {
          id: "demo-att-21",
          name: "feedback-clusters.png",
          mimeType: "image/png",
          size: 184000,
          url: DEMO_FEEDBACK_SVG,
          thumbnailUrl: DEMO_FEEDBACK_SVG,
          createdAt: "2026-08-28T10:00:00.000Z",
        },
      ],
      comments: [
        {
          id: "demo-comm-21-1",
          author: "Jordan Lee",
          text: "Grouped into 3 main buckets: on-boarding, keyboard shortcuts, and dark mode contrast.",
          createdAt: "2026-08-29T11:15:00.000Z",
        },
      ],
    },
    {
      id: "demo-trello-22",
      key: "TR-22",
      title: "Prepare onboarding checklist",
      description: "Create a concise first-project checklist for connecting tools and starting a session.",
      statusId: "demo-todo",
      labels: ["Onboarding"],
      assignees: [],
    },
    {
      id: "demo-trello-23",
      key: "TR-23",
      title: "Review empty-state copy",
      description: "Make every empty state explain what happened and provide one clear next action.",
      statusId: "demo-progress",
      labels: ["Content", "UX"],
      assignees: ["Nina Patel"],
      dueAt: "2026-08-28",
    },
    {
      id: "demo-trello-24",
      key: "TR-24",
      title: "Verify tablet touch targets",
      description: "Confirm primary controls remain at least 44 pixels across compact workspace layouts.",
      statusId: "demo-done",
      labels: ["QA", "Mobile"],
      assignees: ["Theo Martin"],
    },
  ],
  linear: [
    {
      id: "demo-linear-41",
      key: "ENG-41",
      title: "Sync offline edits when the app reconnects",
      description: "Queue edits made offline and replay them in order once the connection is back, without duplicating a write that already landed.",
      statusId: "demo-progress",
      labels: ["Mobile", "Bug"],
      assignees: ["Iris Novak"],
      priority: "urgent",
      dueAt: "2026-10-20",
      comments: [
        {
          id: "demo-comm-41-1",
          author: "Leo Park",
          text: "Repro: edit a title in airplane mode, reconnect — the edit applies twice.",
          createdAt: "2026-10-12T09:10:00.000Z",
        },
      ],
    },
    {
      id: "demo-linear-42",
      key: "ENG-42",
      title: "Swipe between kanban columns on phones",
      description: "One column per screen with a column switcher above it, so a board reads well one-handed.",
      statusId: "demo-todo",
      labels: ["Mobile", "UX"],
      assignees: ["Iris Novak"],
      priority: "high",
    },
    {
      id: "demo-linear-43",
      key: "ENG-43",
      title: "Back off when the API rate limit is reached",
      description: "Read the rate-limit headers and retry reads after the reset instead of failing the board.",
      statusId: "demo-backlog",
      labels: ["Backend"],
      assignees: [],
      priority: "medium",
    },
    {
      id: "demo-linear-44",
      key: "ENG-44",
      title: "Filter task boards by assignee",
      description: "Quick filters for my tasks, unassigned tasks and any teammate, on every board size.",
      statusId: "demo-review",
      labels: ["Feature"],
      assignees: ["Leo Park"],
      priority: "high",
      attachments: [
        {
          id: "demo-att-44",
          name: "assignee-filter.png",
          mimeType: "image/png",
          size: 162400,
          url: DEMO_RESPONSIVE_SVG,
          thumbnailUrl: DEMO_RESPONSIVE_SVG,
          createdAt: "2026-10-13T15:40:00.000Z",
        },
      ],
    },
    {
      id: "demo-linear-45",
      key: "ENG-45",
      title: "Audit dark mode contrast",
      description: "Check every status color against the dark surfaces and fix anything under 4.5:1.",
      statusId: "demo-done",
      labels: ["Design"],
      assignees: ["Mia Santos"],
      priority: "low",
    },
    {
      id: "demo-linear-46",
      key: "ENG-46",
      title: "Document the API error codes",
      description: "List each error code the client can see and what the board shows for it.",
      statusId: "demo-todo",
      labels: ["Docs"],
      assignees: [],
      priority: "none",
    },
    {
      id: "demo-linear-47",
      key: "ENG-47",
      title: "Keyboard shortcuts for the list view",
      description: "J and K move between rows, Enter opens the task, X selects it for agents.",
      statusId: "demo-backlog",
      labels: ["Accessibility"],
      assignees: ["Leo Park"],
      priority: "low",
    },
  ],
};

const DEMO_PRIORITY_NAMES: Record<TaskTrackerProvider, Record<TaskTrackerPriority, string>> = {
  jira: { urgent: "Highest", high: "High", medium: "Medium", low: "Low", none: "None" },
  trello: { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" },
  linear: { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" },
};

export function createDemoClient(provider: TaskTrackerProvider): ProviderClient {
  const projectId = `demo-${provider}-workspace`;
  const boardId = `demo-${provider}-board`;
  const project = DEMO_PROJECTS[provider];
  const boards: TaskTrackerBoardDto[] = [{
    provider,
    id: boardId,
    name: project.board,
    type: "kanban",
    projectId,
    ...(provider !== "trello" ? { projectKey: project.key } : {}),
  }];
  const boardOf = (id: string | undefined): TaskTrackerBoardDto | undefined =>
    boards.find((board) => board.id === id);
  // Each board keeps its own columns; a task's statuses are its board's.
  const columns = new Map<string, TaskTrackerStatusDto[]>();
  const columnsOf = (id: string | undefined): TaskTrackerStatusDto[] => {
    const key = id || boardId;
    let list = columns.get(key);
    if (!list) {
      list = demoStatuses(provider).map((status) => ({ ...status }));
      columns.set(key, list);
    }
    return list;
  };
  let columnSeq = 0;
  const statuses = columnsOf(boardId);
  const tasks = DEMO_TASKS[provider].map((seed): TaskTrackerTaskDto => ({
    provider,
    id: seed.id,
    key: seed.key,
    title: seed.title,
    description: seed.description,
    boardId,
    projectId,
    projectKey: project.key,
    status: { ...statuses.find((status) => status.id === seed.statusId)! },
    availableStatuses: statuses.map((status) => ({ ...status })),
    labels: [...seed.labels],
    assignees: [...seed.assignees],
    ...(seed.assignees.length > 0 ? { assigneePeople: seed.assignees.map(demoPerson) } : {}),
    ...(seed.priority ? { priority: { level: seed.priority, name: DEMO_PRIORITY_NAMES[provider][seed.priority] } } : {}),
    ...(seed.dueAt ? { dueAt: seed.dueAt } : {}),
    ...(seed.attachments ? { attachments: seed.attachments.map((a) => ({ ...a })) } : {}),
    ...(seed.comments ? { comments: seed.comments.map((c) => ({ ...c })) } : {}),
  }));
  let created = 0;
  const clone = (task: TaskTrackerTaskDto): TaskTrackerTaskDto => ({
    ...task,
    status: { ...task.status },
    availableStatuses: columnsOf(task.boardId).map((status) => ({ ...status })),
    labels: [...task.labels],
    assignees: [...task.assignees],
    ...(task.assigneePeople ? { assigneePeople: task.assigneePeople.map((person) => ({ ...person })) } : {}),
    ...(task.priority ? { priority: { ...task.priority } } : {}),
    ...(task.attachments ? { attachments: task.attachments.map((a) => ({ ...a })) } : {}),
    ...(task.comments ? { comments: task.comments.map((c) => ({ ...c })) } : {}),
  });
  const taskById = (taskId: string): TaskTrackerTaskDto => {
    const task = tasks.find((item) => item.id === taskId || item.key === taskId);
    if (!task) throw error(`${provider} demo task was not found`, "not-found");
    return task;
  };
  const demoColumn = (status: TaskTrackerStatusDto): TaskTrackerColumnDto => ({
    ...status,
    statusIds: [status.id],
  });
  const editableColumns = (id: string): TaskTrackerStatusDto[] => {
    if (!boardOf(id)) throw error(`${provider} demo board was not found`, "not-found");
    if (provider !== "trello") {
      throw refused(provider === "linear"
        ? "Linear statuses belong to the team; edit them in Linear"
        : "Jira board columns follow the project workflow; edit them in Jira");
    }
    return columnsOf(id);
  };
  return {
    async currentUser() {
      return demoPerson(DEMO_VIEWERS[provider]);
    },
    async listProjects() {
      return [{
        provider,
        id: projectId,
        key: project.key,
        name: project.name,
      }];
    },
    async listBoards(selectedProjectId) {
      return boards
        .filter((board) => !selectedProjectId || board.projectId === selectedProjectId)
        .map((board) => ({ ...board }));
    },
    async listTasks(query) {
      if (
        (query.boardId && !boardOf(query.boardId))
        || (query.projectId && query.projectId !== projectId)
      ) return [];
      return tasks
        .filter((task) => !query.boardId || task.boardId === query.boardId)
        .slice(0, limitOf(query.limit))
        .map(clone);
    },
    async getTask(taskId) {
      return clone(taskById(taskId));
    },
    async updateStatus(taskId, statusId) {
      const task = taskById(taskId);
      const status = columnsOf(task.boardId).find((item) => item.id === identifier(statusId, "statusId"));
      if (!status) throw error("demo status was not found", "not-found");
      task.status = { ...status };
      task.updatedAt = new Date().toISOString();
      return clone(task);
    },
    async createTask(input) {
      const title = boundedText(input.title, "title", TITLE_MAX);
      const description = boundedText(input.description, "description", DESCRIPTION_MAX, true);
      if (
        (input.boardId && !boardOf(input.boardId))
        || (input.projectId && input.projectId !== projectId)
      ) throw error(`${provider} demo board was not found`, "not-found");
      created += 1;
      const prefix = provider === "trello" ? "TR" : project.key;
      const number = (provider === "jira" ? 105 : provider === "linear" ? 47 : 24) + created;
      const task: TaskTrackerTaskDto = {
        provider,
        id: `demo-${provider}-new-${created}`,
        key: `${prefix}-${number}`,
        title,
        description,
        boardId: input.boardId || boardId,
        projectId,
        projectKey: project.key,
        status: { ...columnsOf(input.boardId || boardId)[0]! },
        labels: [],
        assignees: [],
        updatedAt: new Date().toISOString(),
      };
      tasks.unshift(task);
      return clone(task);
    },
    async createBoard(input) {
      const name = boundedText(input.name, "name", BOARD_NAME_MAX);
      if (input.projectId && input.projectId !== projectId) {
        throw error(`${provider} demo workspace was not found`, "not-found");
      }
      const board: TaskTrackerBoardDto = {
        provider,
        id: `demo-${provider}-board-${boards.length + 1}`,
        name,
        type: provider === "jira" ? boardTypeOf(input.type) : "kanban",
        projectId,
        ...(provider !== "trello" ? { projectKey: project.key } : {}),
      };
      boards.push(board);
      return { ...board };
    },
    async listColumns(id) {
      if (!boardOf(id)) throw error(`${provider} demo board was not found`, "not-found");
      return {
        columns: columnsOf(id).map(demoColumn),
        // The sandbox mirrors the tracker: Jira columns follow its workflow.
        editable: provider === "trello",
        ...(provider === "trello" ? { removal: "delete-empty" as const } : {}),
      };
    },
    async createColumn(id, input) {
      const list = editableColumns(id);
      const name = boundedText(input.name, "name", COLUMN_NAME_MAX);
      columnSeq += 1;
      const column = { id: `demo-${provider}-column-${columnSeq}`, name, category: categoryOfName(name) };
      list.splice(columnPosition(input.position, list.length), 0, column);
      return demoColumn(column);
    },
    async updateColumn(id, columnId, input) {
      const list = editableColumns(id);
      const index = list.findIndex((item) => item.id === columnId);
      if (index < 0) throw error("demo column was not found", "not-found");
      const column = list[index]!;
      if (input.name !== undefined) {
        column.name = boundedText(input.name, "name", COLUMN_NAME_MAX);
        column.category = categoryOfName(column.name);
        for (const task of tasks) {
          if (task.boardId === id && task.status.id === column.id) task.status = { ...column };
        }
      }
      if (input.position !== undefined) {
        list.splice(index, 1);
        list.splice(columnPosition(input.position, list.length), 0, column);
      }
      return demoColumn(column);
    },
    async removeColumn(id, columnId) {
      const list = editableColumns(id);
      const index = list.findIndex((item) => item.id === columnId);
      if (index < 0) throw error("demo column was not found", "not-found");
      if (tasks.some((task) => task.boardId === id && task.status.id === columnId)) {
        throw refused("Move this column’s tasks to another column first");
      }
      if (list.length === 1) throw refused("A board needs at least one column");
      list.splice(index, 1);
    },
    async moveTask(taskId, id, columnId) {
      const task = taskById(taskId);
      if (task.boardId !== id) throw error(`${provider} demo task is not on this board`, "not-found");
      return this.updateStatus(taskId, columnId);
    },
    async archiveTask(taskId) {
      tasks.splice(tasks.indexOf(taskById(taskId)), 1);
    },
    async deleteTask(taskId) {
      tasks.splice(tasks.indexOf(taskById(taskId)), 1);
    },
    async addComment(taskId, text) {
      const task = taskById(taskId);
      const clean = boundedText(text, "comment", COMMENT_MAX);
      if (!task.comments) task.comments = [];
      task.comments.push({
        id: `demo-comment-${Date.now()}-${task.comments.length + 1}`,
        author: "You",
        text: clean,
        createdAt: new Date().toISOString(),
      });
      task.updatedAt = new Date().toISOString();
    },
    async addAttachments(taskId, files) {
      const task = taskById(taskId);
      const list = imageFiles(files);
      if (!task.attachments) task.attachments = [];
      for (let i = 0; i < list.length; i++) {
        const file = list[i]!;
        const dataUrl = `data:${file.mimeType};base64,${Buffer.from(file.bytes).toString("base64")}`;
        task.attachments.push({
          id: `demo-att-${Date.now()}-${task.attachments.length + 1}`,
          name: file.name,
          mimeType: file.mimeType,
          size: file.bytes.length,
          url: dataUrl,
          thumbnailUrl: dataUrl,
          createdAt: new Date().toISOString(),
        });
      }
      task.updatedAt = new Date().toISOString();
    },
    async updateTask(taskId, input) {
      const task = taskById(taskId);
      if (input.title !== undefined) {
        task.title = boundedText(input.title, "title", TITLE_MAX);
      }
      if (input.description !== undefined) {
        task.description = boundedText(input.description, "description", DESCRIPTION_MAX, true);
      }
      task.updatedAt = new Date().toISOString();
      return clone(task);
    },
  };
}

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface TrelloCredentials {
  apiKey: string;
  apiToken: string;
}

export interface LinearCredentials {
  apiKey: string;
}

type CredentialSource = "personal" | "connection" | "env";

/** Where a provider's credentials came from and whose account they are.
 *  `connectedBy` is the Polyth user who connected a shared account. */
interface CredentialOrigin {
  source: CredentialSource;
  account?: TaskTrackerAccountDto;
  connectedBy?: string;
}

/** Live credentials resolved by the caller (Space connection first, then env). */
export interface TaskTrackerCredentials {
  jira?: JiraCredentials & CredentialOrigin;
  trello?: TrelloCredentials & CredentialOrigin;
  linear?: LinearCredentials & CredentialOrigin;
}

export interface TaskTrackerServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchFn;
  /** Overrides env-derived credentials per provider when present. */
  credentials?: TaskTrackerCredentials;
  preferences?: TaskTrackerPreferences;
  /** Supplies the sandbox client so its in-memory edits outlive one service. */
  demoClient?: (provider: TaskTrackerProvider) => ProviderClient;
  /** The Polyth user the service acts for; decides whose "me" a shared
   *  account is. */
  viewerUserId?: string;
}

export const TASK_TRACKER_REQUIRED_ENV: Record<TaskTrackerProvider, readonly string[]> = {
  jira: ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN"],
  trello: ["TRELLO_API_KEY", "TRELLO_API_TOKEN"],
  linear: ["LINEAR_API_KEY"],
};

export const PROVIDER_NAMES: Record<TaskTrackerProvider, string> = {
  jira: "Jira",
  trello: "Trello",
  linear: "Linear",
};

export function isTaskTrackerProvider(value: string): value is TaskTrackerProvider {
  return (TASK_TRACKER_PROVIDERS as readonly string[]).includes(value);
}

/** Credentials from process env only; Space connections take precedence. */
export function envCredentials(env: NodeJS.ProcessEnv): TaskTrackerCredentials {
  const value = (name: string) => env[name]?.trim() ?? "";
  return {
    ...(value("JIRA_BASE_URL") && value("JIRA_EMAIL") && value("JIRA_API_TOKEN")
      ? {
          jira: {
            baseUrl: value("JIRA_BASE_URL"),
            email: value("JIRA_EMAIL"),
            apiToken: value("JIRA_API_TOKEN"),
            source: "env" as const,
          },
        }
      : {}),
    ...(value("TRELLO_API_KEY") && value("TRELLO_API_TOKEN")
      ? {
          trello: {
            apiKey: value("TRELLO_API_KEY"),
            apiToken: value("TRELLO_API_TOKEN"),
            source: "env" as const,
          },
        }
      : {}),
    ...(value("LINEAR_API_KEY")
      ? { linear: { apiKey: value("LINEAR_API_KEY"), source: "env" as const } }
      : {}),
  };
}

export function createTaskTrackerService(
  options: TaskTrackerServiceOptions = {},
): TaskTrackerService {
  const credentials = options.credentials ?? envCredentials(options.env ?? process.env);
  const preferences = options.preferences ?? DEFAULT_TASK_TRACKER_PREFERENCES;
  const fetchOption = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
  const demo = options.demoClient ?? createDemoClient;
  const clients: Partial<Record<TaskTrackerProvider, ProviderClient>> = {};
  const sources = Object.fromEntries(TASK_TRACKER_PROVIDERS.map((provider) => [provider, "none"])) as
    Record<TaskTrackerProvider, TaskTrackerProviderSource>;
  const live: { [K in TaskTrackerProvider]: (value: NonNullable<TaskTrackerCredentials[K]>) => ProviderClient } = {
    jira: (value) => createJiraClient({ ...value, ...fetchOption }),
    trello: (value) => createTrelloClient({ ...value, ...fetchOption }),
    linear: (value) => createLinearClient({ ...value, ...fetchOption }),
  };
  for (const provider of TASK_TRACKER_PROVIDERS) {
    const value = credentials[provider];
    if (value) {
      clients[provider] = (live[provider] as (input: typeof value) => ProviderClient)(value);
      sources[provider] = value.source;
    } else if (preferences.demo) {
      clients[provider] = demo(provider);
      sources[provider] = "demo";
    }
  }
  const providerInfo = (provider: TaskTrackerProvider): TaskTrackerProviderDto => {
    const live = sources[provider] === "personal" || sources[provider] === "connection" || sources[provider] === "env";
    const account = credentials[provider]?.account;
    return {
      provider,
      mode: sources[provider] === "demo" ? "demo" : "live",
      configured: live,
      requiredEnv: [...TASK_TRACKER_REQUIRED_ENV[provider]],
      enabled: preferences.providers[provider],
      source: sources[provider],
      ...(account ? { account: { ...account } } : {}),
    };
  };
  /** A member's own account, the shared one they connected, or the sandbox.
   *  Server env credentials and someone else's shared account are nobody's
   *  "me" here. */
  const ownAccount = (provider: TaskTrackerProvider): boolean => {
    const source = sources[provider];
    if (source === "personal" || source === "demo") return true;
    return source === "connection"
      && Boolean(options.viewerUserId)
      && credentials[provider]?.connectedBy === options.viewerUserId;
  };
  const client = (provider: TaskTrackerProvider): ProviderClient => {
    if (!preferences.providers[provider]) {
      throw refused(`${PROVIDER_NAMES[provider]} is turned off in Task tracker settings`);
    }
    const value = clients[provider];
    if (!value) throw refused(`${PROVIDER_NAMES[provider]} is not connected`);
    return value;
  };
  type ColumnMethod = "listColumns" | "createColumn" | "updateColumn" | "removeColumn" | "moveTask";
  const columns = <K extends ColumnMethod>(provider: TaskTrackerProvider, method: K): NonNullable<ProviderClient[K]> => {
    const value = client(provider);
    const fn = value[method];
    if (!fn) throw refused(`${PROVIDER_NAMES[provider]} board columns are not available on this server`);
    return fn.bind(value) as NonNullable<ProviderClient[K]>;
  };
  const removal = (provider: TaskTrackerProvider, method: "archiveTask" | "deleteTask") => {
    const value = client(provider);
    const fn = value[method];
    if (!fn) throw refused(`${method === "archiveTask" ? "Archiving" : "Deleting"} ${PROVIDER_NAMES[provider]} tasks is not available on this server`);
    return fn.bind(value);
  };
  return {
    providers: () => TASK_TRACKER_PROVIDERS.map(providerInfo),
    listProjects: async (provider) => client(provider).listProjects(),
    listBoards: async (provider, projectId) => client(provider).listBoards(projectId),
    listTasks: async (provider, query) => client(provider).listTasks(query),
    getTask: async (provider, taskId) => client(provider).getTask(taskId),
    updateStatus: async (provider, taskId, statusId) => client(provider).updateStatus(taskId, statusId),
    attachmentContent: async (provider, taskId, attachmentId, preview) => {
      const value = client(provider);
      if (!value.attachmentContent) throw refused(`${PROVIDER_NAMES[provider]} attachments can’t be previewed on this server`);
      return value.attachmentContent(taskId, attachmentId, preview);
    },
    updateTask: async (provider, taskId, input) => {
      const value = client(provider);
      if (!value.updateTask) throw refused(`Editing ${PROVIDER_NAMES[provider]} task details is not available on this server`);
      return value.updateTask(taskId, input);
    },
    createTask: async (provider, input) => client(provider).createTask(input),
    createBoard: async (provider, input) => client(provider).createBoard(input),
    addComment: async (provider, taskId, text) => client(provider).addComment(taskId, text),
    addAttachments: async (provider, taskId, files) => client(provider).addAttachments(taskId, files),
    listColumns: async (provider, boardId) => columns(provider, "listColumns")(boardId),
    createColumn: async (provider, boardId, input) => columns(provider, "createColumn")(boardId, input),
    updateColumn: async (provider, boardId, columnId, input) =>
      columns(provider, "updateColumn")(boardId, columnId, input),
    removeColumn: async (provider, boardId, columnId) => columns(provider, "removeColumn")(boardId, columnId),
    moveTask: async (provider, taskId, boardId, columnId) =>
      columns(provider, "moveTask")(taskId, boardId, columnId),
    archiveTask: async (provider, taskId) => removal(provider, "archiveTask")(taskId),
    deleteTask: async (provider, taskId) => removal(provider, "deleteTask")(taskId),
    currentUser: async (provider) => {
      const value = client(provider);
      if (!value.currentUser) throw refused(`${PROVIDER_NAMES[provider]} can’t name the connected account on this server`);
      return { person: await value.currentUser(), own: ownAccount(provider) };
    },
  };
}

const rejected = (cause: unknown, message: string): never => {
  const status = (cause as { httpStatus?: number }).httpStatus;
  if (status === 401 || status === 403) throw error(message, "invalid-input");
  throw cause;
};

/** Confirms Jira credentials and returns the public account identity. */
export async function verifyJiraAccount(
  credentials: JiraCredentials & { fetchImpl?: FetchFn },
): Promise<TaskTrackerAccountDto> {
  const baseUrl = new URL(required(credentials.baseUrl, "Jira site"));
  if (baseUrl.protocol !== "https:" && baseUrl.hostname !== "localhost" && baseUrl.hostname !== "127.0.0.1") {
    throw error("Jira site must use HTTPS", "invalid-input");
  }
  const authorization = `Basic ${Buffer.from(
    `${required(credentials.email, "Email")}:${required(credentials.apiToken, "API token")}`,
  ).toString("base64")}`;
  const me = await requestJson<{
    displayName?: string;
    emailAddress?: string;
    avatarUrls?: Record<string, string>;
  }>("Jira", credentials.fetchImpl ?? fetch, new URL("/rest/api/3/myself", baseUrl), {
    headers: { authorization },
  }).catch((cause) => rejected(cause, "Jira rejected this email and API token"));
  return {
    name: String(me.displayName || me.emailAddress || credentials.email),
    ...(me.emailAddress ? { email: me.emailAddress } : { email: credentials.email.trim() }),
    ...(me.avatarUrls?.["48x48"] ? { avatarUrl: me.avatarUrls["48x48"] } : {}),
    site: baseUrl.origin,
  };
}

/** Confirms a Trello key/token pair and returns the public account identity. */
export async function verifyTrelloAccount(
  credentials: TrelloCredentials & { fetchImpl?: FetchFn; baseUrl?: string },
): Promise<TaskTrackerAccountDto> {
  const url = new URL("/1/members/me", credentials.baseUrl ?? "https://api.trello.com");
  url.search = new URLSearchParams({
    fields: "fullName,username,avatarUrl",
    key: required(credentials.apiKey, "API key"),
    token: required(credentials.apiToken, "Token"),
  }).toString();
  const me = await requestJson<{ fullName?: string; username?: string; avatarUrl?: string | null }>(
    "Trello",
    credentials.fetchImpl ?? fetch,
    url,
    {},
  ).catch((cause) => rejected(cause, "Trello rejected this API key and token"));
  return {
    name: String(me.fullName || me.username || "Trello member"),
    ...(me.username ? { email: `@${me.username}` } : {}),
    ...(me.avatarUrl ? { avatarUrl: `${me.avatarUrl}/50.png` } : {}),
  };
}

const TASK_NOUNS: Record<TaskTrackerProvider, string> = {
  jira: "Jira issue",
  trello: "Trello card",
  linear: "Linear issue",
};

export function buildTaskWorkPrompt(task: TaskTrackerTaskDto, instructions = ""): string {
  const custom = instructions.trim();
  return [
    `Work on ${TASK_NOUNS[task.provider]} ${task.key}: ${task.title}`,
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
    "If the polyth_tasks tools are available, re-read the task with polyth_tasks and, when the work is done, post a short result comment with polyth_task_update.",
  ].join("\n");
}

export type TaskLifecycleState = TaskTrackerSessionTaskDto;

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
      // A status change out of done reopens the task; the route appends
      // task/completed right after a change into done.
      completed: event.type === "task/completed"
        || (event.type !== "task/status-changed" && previous?.completed === true),
      selectedAtSeq: previous?.selectedAtSeq ?? event.seq,
      updatedAtSeq: event.seq,
    });
  }
  return [...linked.values()].sort((a, b) => a.selectedAtSeq - b.selectedAtSeq);
}
