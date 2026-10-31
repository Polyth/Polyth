import type {
  TaskTrackerAccountDto,
  TaskTrackerProvider,
  TaskTrackerProviderDto,
} from "@polyth/contracts";

/**
 * Browser-safe management contract shared by the server routes and the web
 * entry. Nothing here may carry a credential value: secrets live only in the
 * Credential Vault opaque store on the server.
 */

export const TASK_TRACKER_PROVIDERS: readonly TaskTrackerProvider[] = ["jira", "trello", "linear"];

export const TASK_TRACKER_WIDGET_IDS = [
  "task-trackers.board",
  "task-trackers.linked-task",
  "task-trackers.overview",
] as const;

export type TaskTrackerWidgetId = (typeof TASK_TRACKER_WIDGET_IDS)[number];

export interface TaskTrackerPreferences {
  /** Per-provider on/off. A disabled provider is hidden and its routes refuse work. */
  providers: Record<TaskTrackerProvider, boolean>;
  /** Offer the in-memory sample board for providers that are not connected. */
  demo: boolean;
  /** Allow "Link & start agent" to send a work prompt into the session. */
  agentHandoff: boolean;
  /** Allow status changes to be written back to the tracker. */
  statusUpdates: boolean;
  widgets: Record<TaskTrackerWidgetId, boolean>;
}

export interface TaskTrackerPreferencesPatch {
  providers?: Partial<Record<TaskTrackerProvider, boolean>>;
  demo?: boolean;
  agentHandoff?: boolean;
  statusUpdates?: boolean;
  widgets?: Partial<Record<TaskTrackerWidgetId, boolean>>;
}

export type TaskTrackerConnectionMethod = "api-token" | "authorize";

/**
 * `space` is the Space's shared *service account*, connected by admins. People
 * use it in the UI; agents and system work only when the Space policy allows.
 * `personal` is a person's own account (owned by the person, not the Space),
 * used in a Space only after they enable it there. It acts for that person
 * (and agents acting for them) and is never lent to anyone else.
 */
export type TaskTrackerConnectionScope = "space" | "personal";

export const TASK_TRACKER_CONNECTION_SCOPES: readonly TaskTrackerConnectionScope[] = ["space", "personal"];

/** Public, Space-owned connection metadata. */
export interface TaskTrackerConnectionDto {
  provider: TaskTrackerProvider;
  method: TaskTrackerConnectionMethod;
  account: TaskTrackerAccountDto;
  connectedAt: number;
  verifiedAt: number;
  revision: number;
}

/** One of the caller's own accounts; it belongs to them across Spaces. */
export interface TaskTrackerPersonalConnectionDto extends TaskTrackerConnectionDto {
  /** Stable id of this connection in the person's account list. */
  id?: string;
  /** Turned on in the Space this snapshot was read in. Absent on older servers (on). */
  enabled?: boolean;
}

export interface TaskTrackerManagementDto {
  preferences: TaskTrackerPreferences;
  /** The Space's shared service accounts. */
  connections: TaskTrackerConnectionDto[];
  /** All of the caller's own accounts, each with its enablement here. Absent on older servers. */
  personalConnections?: TaskTrackerPersonalConnectionDto[];
  providers: TaskTrackerProviderDto[];
  /** False when the Credential Vault service is unavailable: the Space account can't be saved. */
  vaultAvailable: boolean;
  /** False when this server can't store person-owned accounts. Absent on older servers. */
  personalAvailable?: boolean;
  /** Space admins only: may agents and system work use the Space service accounts? */
  agentsMayUseService?: boolean;
  /** False when the caller's Space role cannot change settings or shared connections. */
  canManage: boolean;
  /** False when the caller's Space role cannot connect a personal account or write to trackers. */
  canConnect?: boolean;
}

/** A Polyth session that a task was linked or dispatched to. */
export interface TaskTrackerTaskLinkDto {
  provider: TaskTrackerProvider;
  taskId: string;
  taskKey: string;
  sessionId: string;
  linkedAt: number;
}

export interface TaskTrackerDispatchResultDto {
  provider: TaskTrackerProvider;
  taskId: string;
  taskKey?: string;
  sessionId?: string;
  /** Present when this task could not be started; the others still ran. */
  error?: string;
}

export interface JiraConnectInput {
  site: string;
  email: string;
  apiToken: string;
}

export interface TrelloConnectInput {
  apiKey: string;
  token: string;
}

export interface LinearConnectInput {
  apiKey: string;
}

export const DEFAULT_TASK_TRACKER_PREFERENCES: TaskTrackerPreferences = Object.freeze({
  providers: Object.freeze({ jira: true, trello: true, linear: true }),
  demo: true,
  agentHandoff: true,
  statusUpdates: true,
  widgets: Object.freeze({
    "task-trackers.board": true,
    "task-trackers.linked-task": true,
    "task-trackers.overview": true,
  }),
}) as TaskTrackerPreferences;

const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** Tolerates missing, older, or malformed stored state; unknown keys are dropped. */
export function normalizePreferences(value: unknown): TaskTrackerPreferences {
  const input = record(value);
  const providers = record(input.providers);
  const widgets = record(input.widgets);
  const base = DEFAULT_TASK_TRACKER_PREFERENCES;
  return {
    providers: Object.fromEntries(TASK_TRACKER_PROVIDERS.map((provider) =>
      [provider, flag(providers[provider], base.providers[provider])])) as Record<TaskTrackerProvider, boolean>,
    demo: flag(input.demo, base.demo),
    agentHandoff: flag(input.agentHandoff, base.agentHandoff),
    statusUpdates: flag(input.statusUpdates, base.statusUpdates),
    widgets: Object.fromEntries(TASK_TRACKER_WIDGET_IDS.map((id) =>
      [id, flag(widgets[id], base.widgets[id])])) as Record<TaskTrackerWidgetId, boolean>,
  };
}

export function mergePreferences(
  current: TaskTrackerPreferences,
  patch: TaskTrackerPreferencesPatch,
): TaskTrackerPreferences {
  return normalizePreferences({
    ...current,
    ...patch,
    providers: { ...current.providers, ...record(patch.providers) },
    widgets: { ...current.widgets, ...record(patch.widgets) },
  });
}

/**
 * Accepts `acme`, `acme.atlassian.net`, or a full URL and returns the HTTPS
 * site origin. Returns null for anything that is not a plausible site.
 */
export function normalizeJiraSite(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > 253) return null;
  const candidate = /^[a-z0-9-]+$/i.test(raw)
    ? `https://${raw}.atlassian.net`
    : /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    if (url.username || url.password || !url.hostname.includes(".") && !local) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Trello's own authorize page; it posts the token back to `origin`. */
export function trelloAuthorizeUrl(apiKey: string, origin: string, appName = "Polyth"): string {
  const query = new URLSearchParams({
    expiration: "never",
    name: appName,
    scope: "read,write",
    response_type: "token",
    key: apiKey.trim(),
    callback_method: "postMessage",
    return_url: origin,
  });
  return `https://trello.com/1/authorize?${query}`;
}

export const JIRA_TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";
export const TRELLO_KEY_PAGE = "https://trello.com/power-ups/admin";
/** Linear → Settings → Security & access, where personal API keys are made. */
export const LINEAR_KEY_PAGE = "https://linear.app/settings/account/security";

/** A personal API key, or an OAuth token pasted instead: one opaque word. */
export const looksLikeLinearKey = (value: string): boolean =>
  /^lin_(api|oauth)_[A-Za-z0-9]{16,}$/.test(value.trim());
