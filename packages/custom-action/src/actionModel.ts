// Custom actions: the shared, browser-safe data model. The server store, the
// routes and every web surface read the same shapes and the same validation,
// so an action can never be valid in one place and refused in another.

export const CUSTOM_ACTION_PACKAGE_ID = "custom-action";

/** How a press runs the command. */
export const ACTION_RUN_MODES = ["background", "terminal", "chat"] as const;
export type ActionRunMode = typeof ACTION_RUN_MODES[number];

/** When a `chat` action hands its result to a new chat. */
export const ACTION_CHAT_WHEN = ["always", "failure", "success"] as const;
export type ActionChatWhen = typeof ACTION_CHAT_WHEN[number];

/** Tile tints; each maps to a canonical signal token, never a literal. */
export const ACTION_COLORS = ["neutral", "accent", "blue", "green", "amber", "red", "purple"] as const;
export type ActionColor = typeof ACTION_COLORS[number];

/** Semantic glyph ids. The web package maps each to one curated UI icon; the
 *  id (not an SVG) is what is stored. */
export const ACTION_ICON_IDS = [
  "zap", "play", "terminal", "rocket", "build", "wrench", "bug", "flask",
  "code", "command", "workflow", "package", "container", "server", "database", "cloud",
  "infrastructure", "globe", "network", "cpu", "gauge", "activity", "chart", "webhook",
  "branch", "commit", "pull-request", "merge", "push", "pull", "sync", "refresh",
  "tag", "folder", "file", "download", "upload", "archive", "trash", "eraser",
  "search", "sparkles", "brain", "bot", "wand", "chat", "send", "mail",
  "bell", "clock", "calendar", "flag", "target", "star", "heart", "lightbulb",
  "key", "lock", "shield", "power", "plug", "home", "monitor", "smartphone",
  "image", "camera", "music", "palette", "coffee", "flame",
] as const;
export type ActionIconId = typeof ACTION_ICON_IDS[number];

export const ACTION_LIMITS = {
  name: 60,
  command: 20_000,
  prompt: 20_000,
  actions: 200,
  harnessId: 120,
  modelId: 240,
  confirmMessage: 500,
} as const;

export interface ActionModelRef {
  providerID: string;
  modelID: string;
  variant?: string;
}

/** Hand-off settings for `chat` actions. Kept while another mode is chosen,
 *  so switching back restores them. */
export interface ActionChatOptions {
  /** Pinned harness; absent means Polyth Auto. */
  harnessId?: string;
  /** Model on that harness; absent means the harness default. */
  model?: ActionModelRef;
  /** Text the agent receives before the command output. `{{output}}` places
   *  the output block instead of appending it. */
  prompt: string;
  when: ActionChatWhen;
}

/** Present when every press asks before running. */
export interface ActionConfirmOptions {
  /** Shown in the confirmation; empty means the default text (the command). */
  message: string;
}

export interface CustomActionDto {
  id: string;
  name: string;
  icon: ActionIconId;
  color: ActionColor;
  command: string;
  mode: ActionRunMode;
  /** The one project the action belongs to; `null` = every project in the Space. */
  projectId: string | null;
  chat?: ActionChatOptions;
  confirm?: ActionConfirmOptions;
  createdAt: number;
  updatedAt: number;
}

export type CustomActionInput = Omit<CustomActionDto, "id" | "createdAt" | "updatedAt">;

export interface CustomActionListDto {
  actions: CustomActionDto[];
  /** The caller may create, edit, reorder and delete actions. */
  canManage: boolean;
  /** The caller may run actions (background, Terminal). */
  canRun: boolean;
  /** The caller may start chats from a run. */
  canChat: boolean;
}

// ---- runs ---------------------------------------------------------------------

export type ActionRunStatus = "running" | "succeeded" | "failed" | "stopped" | "timed-out" | "error";
/** `chat` runs first run the command, then hand the result to a new chat. */
export type ActionRunPhase = "command" | "chat" | "done";

export interface ActionRunDto {
  id: string;
  actionId: string;
  projectId: string;
  /** The chat the action was launched from, when there was one. */
  sessionId: string | null;
  name: string;
  icon: ActionIconId;
  color: ActionColor;
  mode: Exclude<ActionRunMode, "terminal">;
  status: ActionRunStatus;
  phase: ActionRunPhase;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
  /** The chat a `chat` run started. */
  chatSessionId: string | null;
  /** True when the `when` condition did not ask for a chat this time. */
  chatSkipped: boolean;
  /** Human-readable reason for `error`, or a chat hand-off that failed. */
  error: string | null;
  /** Characters of output produced so far (absolute offset). */
  outputEnd: number;
  /** Older output fell out of the bounded buffer. */
  truncated: boolean;
}

export interface ActionRunOutputDto {
  run: ActionRunDto;
  command: string;
  /** Absolute offset of `text` (>= the requested `from` when trimmed). */
  start: number;
  end: number;
  text: string;
}

// ---- validation ---------------------------------------------------------------

export class ActionInputError extends Error {
  readonly code = "invalid-input";
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "ActionInputError";
    this.field = field;
  }
}

const fail = (field: string, message: string): never => {
  throw new ActionInputError(field, message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/** Collapse whitespace runs so a name stays one tidy line. */
export const tidyName = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Commands keep their own text; only trailing blank lines are dropped. */
export const tidyCommand = (value: string): string => value.replace(/\r\n?/g, "\n").replace(/\s+$/u, "");

function modelRef(value: unknown): ActionModelRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return fail("chat.model", "Model must be an object.");
  const providerID = typeof value.providerID === "string" ? value.providerID.trim() : "";
  const modelID = typeof value.modelID === "string" ? value.modelID.trim() : "";
  if (!providerID || !modelID) return fail("chat.model", "Model needs a provider and a model id.");
  if (providerID.length > ACTION_LIMITS.modelId || modelID.length > ACTION_LIMITS.modelId) {
    return fail("chat.model", "Model id is too long.");
  }
  const variant = typeof value.variant === "string" && value.variant.trim() ? value.variant.trim() : undefined;
  if (variant && variant.length > ACTION_LIMITS.modelId) return fail("chat.model", "Model variant is too long.");
  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

function chatOptions(value: unknown): ActionChatOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) return fail("chat", "Chat options must be an object.");
  const harnessId = typeof value.harnessId === "string" && value.harnessId.trim() && value.harnessId.trim() !== "auto"
    ? value.harnessId.trim()
    : undefined;
  if (harnessId && (harnessId.length > ACTION_LIMITS.harnessId || !/^[A-Za-z0-9._:-]+$/.test(harnessId))) {
    return fail("chat.harnessId", "Harness id is invalid.");
  }
  const prompt = typeof value.prompt === "string" ? value.prompt.replace(/\r\n?/g, "\n").trim() : "";
  if (prompt.length > ACTION_LIMITS.prompt) return fail("chat.prompt", `Instructions must be ${ACTION_LIMITS.prompt} characters or fewer.`);
  const when = value.when === undefined ? "always" : value.when;
  if (!oneOf(ACTION_CHAT_WHEN, when)) return fail("chat.when", "Choose when the chat starts.");
  const model = modelRef(value.model);
  return {
    ...(harnessId ? { harnessId } : {}),
    ...(model ? { model } : {}),
    prompt,
    when,
  };
}

function confirmOptions(value: unknown): ActionConfirmOptions | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return { message: "" };
  if (!isRecord(value)) return fail("confirm", "Confirmation must be an object.");
  const message = typeof value.message === "string" ? value.message.replace(/\r\n?/g, "\n").trim() : "";
  if (message.length > ACTION_LIMITS.confirmMessage) {
    return fail("confirm.message", `Confirmation message must be ${ACTION_LIMITS.confirmMessage} characters or fewer.`);
  }
  return { message };
}

/**
 * Validate a create/update body into a complete action input. Unknown fields
 * are dropped; every refusal names its field so the editor can point at it.
 */
export function normalizeActionInput(raw: unknown): CustomActionInput {
  if (!isRecord(raw)) return fail("action", "Action must be an object.");
  const name = typeof raw.name === "string" ? tidyName(raw.name) : "";
  if (!name) return fail("name", "Give the action a name.");
  if (name.length > ACTION_LIMITS.name) return fail("name", `Name must be ${ACTION_LIMITS.name} characters or fewer.`);
  const command = typeof raw.command === "string" ? tidyCommand(raw.command) : "";
  if (!command.trim()) return fail("command", "Enter a command to run.");
  if (command.length > ACTION_LIMITS.command) return fail("command", `Command must be ${ACTION_LIMITS.command} characters or fewer.`);
  if (command.includes("\0")) return fail("command", "Command contains an invalid character.");
  const mode = raw.mode === undefined ? "background" : raw.mode;
  if (!oneOf(ACTION_RUN_MODES, mode)) return fail("mode", "Choose how the action runs.");
  const icon = oneOf(ACTION_ICON_IDS, raw.icon) ? raw.icon : "zap";
  const color = oneOf(ACTION_COLORS, raw.color) ? raw.color : "accent";
  let projectId: string | null = null;
  if (raw.projectId !== undefined && raw.projectId !== null && raw.projectId !== "") {
    if (typeof raw.projectId !== "string" || raw.projectId.length > 200 || /[\s/\\]/.test(raw.projectId)) {
      return fail("projectId", "Project is invalid.");
    }
    projectId = raw.projectId;
  }
  const chat = chatOptions(raw.chat);
  const confirm = confirmOptions(raw.confirm);
  return {
    name,
    icon,
    color,
    command,
    mode,
    projectId,
    ...(chat ? { chat } : mode === "chat" ? { chat: { prompt: "", when: "always" as const } } : {}),
    ...(confirm ? { confirm } : {}),
  };
}

/** Read a stored record leniently: a damaged field falls back, a record
 *  without identity or command is skipped. */
export function readStoredAction(raw: unknown): CustomActionDto | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id) return null;
  try {
    const input = normalizeActionInput(raw);
    const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
    const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
    return { id: raw.id, ...input, createdAt, updatedAt };
  } catch {
    return null;
  }
}

// ---- scope --------------------------------------------------------------------

/** True when the action may run in `projectId`. */
export const actionAvailableIn = (action: Pick<CustomActionDto, "projectId">, projectId: string | null | undefined): boolean =>
  !!projectId && (action.projectId === null || action.projectId === projectId);

/** Every action a project offers, in the user's order. */
export const actionsForProject = <T extends Pick<CustomActionDto, "projectId">>(
  actions: readonly T[],
  projectId: string | null | undefined,
): T[] => actions.filter((action) => actionAvailableIn(action, projectId));

/** Split a project's actions into its own and the Space-wide ones. */
export function groupActions<T extends Pick<CustomActionDto, "projectId">>(
  actions: readonly T[],
  projectId: string | null | undefined,
): { project: T[]; global: T[] } {
  return {
    project: projectId ? actions.filter((action) => action.projectId === projectId) : [],
    global: actions.filter((action) => action.projectId === null),
  };
}

/**
 * Move `id` within the subset that shares its scope, keeping every other
 * action where it was. Returns the complete new id order.
 */
export function moveWithinScope(
  actions: readonly Pick<CustomActionDto, "id" | "projectId">[],
  id: string,
  toIndex: number,
): string[] {
  const moving = actions.find((action) => action.id === id);
  if (!moving) return actions.map((action) => action.id);
  const peers = actions.filter((action) => action.projectId === moving.projectId);
  const slots = actions.map((action, index) => action.projectId === moving.projectId ? index : -1).filter((index) => index >= 0);
  const ordered = peers.filter((action) => action.id !== id);
  const target = Math.max(0, Math.min(toIndex, ordered.length));
  ordered.splice(target, 0, moving);
  const next = actions.map((action) => action.id);
  slots.forEach((slot, index) => { next[slot] = ordered[index]!.id; });
  return next;
}

export const isTerminalRunStatus = (status: ActionRunStatus): boolean => status !== "running";
