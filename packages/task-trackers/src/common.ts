import type {
  TaskTrackerAttachmentContent,
  TaskTrackerAttachmentInput,
  TaskTrackerBoardColumnsDto,
  TaskTrackerBoardDto,
  TaskTrackerColumnDto,
  TaskTrackerColumnInput,
  TaskTrackerCreateBoardInput,
  TaskTrackerCreateTaskInput,
  TaskTrackerPersonDto,
  TaskTrackerProjectDto,
  TaskTrackerProvider,
  TaskTrackerStatusCategory,
  TaskTrackerTaskDto,
  TaskTrackerTaskQuery,
  TaskTrackerUpdateTaskInput,
} from "@polyth/contracts";

/**
 * What every tracker client shares: the client contract, input bounds,
 * request helpers and the failure shapes the routes and the board read
 * (`code`, `httpStatus`, `trackerReason`, `mutationOutcome`).
 */

export type FetchFn = typeof fetch;

export interface ProviderClient {
  listProjects(): Promise<TaskTrackerProjectDto[]>;
  listBoards(projectId?: string): Promise<TaskTrackerBoardDto[]>;
  listTasks(query: TaskTrackerTaskQuery): Promise<TaskTrackerTaskDto[]>;
  getTask(taskId: string): Promise<TaskTrackerTaskDto>;
  updateStatus(taskId: string, statusId: string): Promise<TaskTrackerTaskDto>;
  updateTask?(taskId: string, input: TaskTrackerUpdateTaskInput): Promise<TaskTrackerTaskDto>;
  createTask(input: TaskTrackerCreateTaskInput): Promise<TaskTrackerTaskDto>;
  createBoard(input: TaskTrackerCreateBoardInput): Promise<TaskTrackerBoardDto>;
  addComment(taskId: string, text: string): Promise<void>;
  addAttachments(taskId: string, files: TaskTrackerAttachmentInput[]): Promise<void>;
  attachmentContent?(taskId: string, attachmentId: string, preview: boolean): Promise<TaskTrackerAttachmentContent>;
  listColumns?(boardId: string): Promise<TaskTrackerBoardColumnsDto>;
  createColumn?(boardId: string, input: TaskTrackerColumnInput): Promise<TaskTrackerColumnDto>;
  updateColumn?(boardId: string, columnId: string, input: TaskTrackerColumnInput): Promise<TaskTrackerColumnDto>;
  removeColumn?(boardId: string, columnId: string): Promise<void>;
  moveTask?(taskId: string, boardId: string, columnId: string): Promise<TaskTrackerTaskDto>;
  archiveTask?(taskId: string): Promise<void>;
  deleteTask?(taskId: string): Promise<void>;
  /** The account these credentials act as. */
  currentUser?(): Promise<TaskTrackerPersonDto>;
}

export const BOARD_NAME_MAX = 255;
export const TITLE_MAX = 255;
export const COLUMN_NAME_MAX = 255;
export const DESCRIPTION_MAX = 20_000;
export const COMMENT_MAX = 10_000;

export const error = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

/** A precondition failed before any tracker write, so retrying is safe. */
export const refused = (message: string): Error =>
  Object.assign(error(message, "unavailable"), { mutationOutcome: "not-started" });

export const required = (value: string | undefined, name: string): string => {
  const clean = value?.trim();
  if (!clean) throw refused(`${name} is not configured`);
  return clean;
};

export const identifier = (value: string, field: string): string => {
  const clean = value.trim();
  if (!clean || clean.length > 256) {
    throw error(`${field} is required and must be at most 256 characters`, "invalid-input");
  }
  return clean;
};

export const boundedText = (value: string | undefined, field: string, max: number, optional = false): string => {
  const clean = (value ?? "").trim();
  if (!clean && !optional) throw error(`${field} is required`, "invalid-input");
  if (clean.length > max) throw error(`${field} must be at most ${max} characters`, "invalid-input");
  return clean;
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGES_MAX = 10;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Validated image uploads, ready for a multipart form. */
export const imageFiles = (files: unknown): Array<{ name: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> }> => {
  if (!Array.isArray(files) || files.length === 0) throw error("Choose at least one image", "invalid-input");
  if (files.length > IMAGES_MAX) throw error(`Attach at most ${IMAGES_MAX} images`, "invalid-input");
  return files.map((file: Partial<TaskTrackerAttachmentInput>) => {
    const mimeType = String(file?.mimeType ?? "").toLowerCase();
    if (!IMAGE_TYPES.has(mimeType)) throw error("Only PNG, JPEG, GIF and WebP images can be attached", "invalid-input");
    const data = String(file?.data ?? "");
    if (!data || data.length % 4 !== 0 || !BASE64.test(data)) throw error("Image data is not valid base64", "invalid-input");
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    if (bytes.length > IMAGE_MAX_BYTES) throw error("Each image must be at most 10 MB", "invalid-input");
    // Keep only a plain file name; trackers show it to everyone on the task.
    const name = String(file?.name ?? "").replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 255);
    return { name: name || `image.${mimeType.slice(6)}`, mimeType, bytes };
  });
};

export const multipart = (file: ReturnType<typeof imageFiles>[number]): FormData => {
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.mimeType }), file.name);
  return form;
};

/** Where an item lands at `index` among ascending sort positions. */
export const positionAt = (positions: readonly number[], index: number): number => {
  const at = Math.max(0, Math.min(Math.trunc(index), positions.length));
  const before = positions[at - 1];
  const after = positions[at];
  if (before === undefined && after === undefined) return 65_536;
  if (before === undefined) return after! / 2;
  if (after === undefined) return before + 65_536;
  return (before + after) / 2;
};

export const columnPosition = (value: number | undefined, count: number): number => {
  if (value === undefined) return count;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw error("position must be a non-negative integer", "invalid-input");
  }
  return Math.min(value, count);
};

export const limitOf = (value: number | undefined): number => {
  if (value === undefined) return 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw error("limit must be an integer between 1 and 100", "invalid-input");
  }
  return value;
};

/** The tracker's own short explanation ("unauthorized permission requested",
 *  Jira's errorMessages), without markup or anything credential-shaped. */
export const providerReason = (text: string): string => {
  if (/^\s*</.test(text)) return "";
  let reason = text;
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown; errorMessages?: unknown; errors?: unknown };
    const parts = [
      body?.message,
      body?.error,
      ...(Array.isArray(body?.errorMessages) ? body.errorMessages : []),
      ...(body?.errors && typeof body.errors === "object" ? Object.values(body.errors) : []),
    ];
    reason = parts.filter((part): part is string => typeof part === "string" && part.trim() !== "").join("; ");
  } catch {
    // Trello answers in plain text.
  }
  return cleanReason(reason);
};

/** One short line without markup-length tokens a credential could hide in. */
export const cleanReason = (reason: string): string => {
  const clean = reason.replace(/[A-Za-z0-9_-]{32,}/g, "…").replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
};

/** The failure for an HTTP status a tracker answered with. */
export const statusError = (provider: string, status: number, statusText: string, method: string, reason: string): Error => {
  const code = status === 404
    ? "not-found"
    : status === 400 || status === 422
      ? "invalid-input"
      : "unavailable";
  return Object.assign(
    error(`${provider} request failed (${status} ${statusText || "HTTP error"})${reason ? `: ${reason}` : ""}`, code),
    {
      httpStatus: status,
      ...(reason ? { trackerReason: reason } : {}),
      // A 4xx answer to a write means the tracker refused it and applied
      // nothing. Without this, a refusal such as Trello's 401 for a board the
      // account can't edit reads as an unknown outcome and hides the reason.
      ...(method !== "GET" && status >= 400 && status < 500 ? { mutationOutcome: "rejected" } : {}),
    },
  );
};

export const apiError = (provider: string, response: Response, method: string, reason: string): Error =>
  statusError(provider, response.status, response.statusText, method, reason);

/** Board or project permissions refused a write the token itself may make. */
export const deniedWrite = (cause: unknown, denied: string, advice: string): never => {
  const { httpStatus: status, trackerReason } = cause as { httpStatus?: number; trackerReason?: string };
  if (status === 401 || status === 403) {
    const detail = trackerReason ? ` (${status}: ${trackerReason})` : ` (${status})`;
    throw Object.assign(error(`${denied}${detail}. ${advice}`, "unavailable"), {
      httpStatus: status,
      mutationOutcome: "rejected",
    });
  }
  throw cause;
};

export async function requestJson<T>(
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
        // FormData bodies set their own multipart boundary.
        ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
  } catch {
    throw error(`${provider} is unreachable`, "unavailable");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw apiError(provider, response, (init.method ?? "GET").toUpperCase(), providerReason(text));
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw error(`${provider} returned invalid JSON`, "unavailable");
  }
}

const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** Where the board loads an attachment. Tracker file URLs answer only to an
 *  authenticated request, so Polyth reads them with the connection's
 *  credentials instead of handing the browser a link it can't open. */
export const attachmentContentPath = (
  provider: TaskTrackerProvider,
  taskId: string,
  attachmentId: string,
  preview = false,
): string =>
  `/api/task-trackers/${provider}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}/content${preview ? "?preview=1" : ""}`;

export async function requestBinary(
  provider: string,
  fetchImpl: FetchFn,
  url: URL,
  headers: Record<string, string>,
  name: string,
  mimeType: string,
): Promise<TaskTrackerAttachmentContent> {
  let response: Response;
  try {
    // Fetch drops the authorization header when a tracker redirects to its
    // file storage on another origin.
    response = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw error(`${provider} is unreachable`, "unavailable");
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw apiError(provider, response, "GET", providerReason(text));
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (declared > ATTACHMENT_MAX_BYTES) throw error("The attachment is too large to show here", "invalid-input");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw error("The attachment is too large to show here", "invalid-input");
  const served = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  return {
    name,
    mimeType: served && served !== "application/octet-stream" ? served : mimeType,
    bytes,
  };
}

export const categoryOfName = (name: string, closed = false): TaskTrackerStatusCategory => {
  if (closed || /\b(done|complete|completed|closed|shipped|released)\b/i.test(name)) return "done";
  if (/\b(doing|progress|active|review|testing|qa|blocked)\b/i.test(name)) return "in_progress";
  if (/\b(todo|to do|backlog|open|ready|planned?)\b/i.test(name)) return "todo";
  return "unknown";
};

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

/** An image type from a file name, for trackers that don't report one. */
export const imageTypeOfName = (name: string): string | undefined => {
  const extension = IMAGE_EXTENSION.exec(name.split(/[?#]/)[0] ?? "")?.[1]?.toLowerCase();
  return extension ? `image/${extension === "jpg" ? "jpeg" : extension}` : undefined;
};

/** Only web links reach the board; anything else (javascript:, data:) is
 *  dropped rather than rendered as a link. */
export const webUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};
