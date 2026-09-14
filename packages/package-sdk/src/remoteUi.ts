export const REMOTE_UI_MAX_NODES = 200;
export const REMOTE_UI_MAX_DEPTH = 12;
export const REMOTE_UI_MAX_STRING = 4_000;
export const REMOTE_UI_MAX_UPDATES_PER_SEC = 10;
export const REMOTE_UI_MAX_OPTIONS = 64;
export const REMOTE_UI_MAX_TABLE_ROWS = 100;
export const REMOTE_UI_MAX_TABLE_COLUMNS = 12;

export type RemoteUiType =
  | "stack"
  | "inline"
  | "text"
  | "heading"
  | "button"
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "radioGroup"
  | "badge"
  | "card"
  | "list"
  | "listItem"
  | "table"
  | "code"
  | "progress"
  | "spinner"
  | "separator"
  | "empty";

export interface RemoteUiOption {
  value: string;
  label: string;
  detail?: string;
}

export interface RemoteUiNode {
  type: RemoteUiType;
  id?: string;
  text?: string;
  label?: string;
  title?: string;
  subtitle?: string;
  body?: string;
  action?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  tone?: "muted" | "faint" | "success" | "warning" | "danger" | "info";
  variant?: "primary" | "ghost" | "danger";
  gap?: "sm" | "md" | "lg";
  level?: 1 | 2 | 3;
  language?: string;
  progress?: number;
  max?: number;
  options?: RemoteUiOption[];
  columns?: string[];
  rows?: string[][];
  children?: RemoteUiNode[];
  trailing?: { type: "badge" | "text"; text?: string; label?: string; tone?: RemoteUiNode["tone"] };
}

const TYPES = new Set<string>([
  "stack", "inline", "text", "heading", "button", "input", "textarea",
  "select", "checkbox", "radioGroup", "badge", "card", "list", "listItem",
  "table", "code", "progress", "spinner", "separator", "empty",
]);

const clampString = (value: unknown, fallback = ""): string => {
  if (typeof value !== "string") return fallback;
  return value.length > REMOTE_UI_MAX_STRING ? value.slice(0, REMOTE_UI_MAX_STRING) : value;
};

const boundedId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(id)) return undefined;
  return id;
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_REQUEST" });
}

export function parseRemoteUiTree(value: unknown): RemoteUiNode {
  const stats = { nodes: 0 };
  const node = parseNode(value, 0, stats);
  if (!node) invalid("Remote UI tree is invalid");
  return node;
}

function parseTrailing(value: unknown, depth: number, stats: { nodes: number }): RemoteUiNode["trailing"] | undefined {
  if (depth > REMOTE_UI_MAX_DEPTH) invalid("Remote UI tree exceeds depth limit");
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "badge" && raw.type !== "text") return undefined;
  stats.nodes += 1;
  if (stats.nodes > REMOTE_UI_MAX_NODES) invalid("Remote UI tree exceeds node limit");
  const tone = raw.tone === "muted" || raw.tone === "faint" || raw.tone === "success"
    || raw.tone === "warning" || raw.tone === "danger" || raw.tone === "info"
    ? raw.tone
    : undefined;
  return {
    type: raw.type,
    ...(raw.text !== undefined ? { text: clampString(raw.text) } : {}),
    ...(raw.label !== undefined ? { label: clampString(raw.label) } : {}),
    ...(tone ? { tone } : {}),
  };
}

function parseOptions(value: unknown): RemoteUiOption[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > REMOTE_UI_MAX_OPTIONS) invalid("Remote UI options are invalid");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalid("Remote UI option is invalid");
    const raw = item as Record<string, unknown>;
    const optionValue = clampString(raw.value).trim();
    const label = clampString(raw.label).trim();
    if (!optionValue || !label || optionValue.length > 240) invalid("Remote UI option value and label are required");
    if (seen.has(optionValue)) invalid("Remote UI option values must be unique");
    seen.add(optionValue);
    return {
      value: optionValue,
      label,
      ...(raw.detail !== undefined ? { detail: clampString(raw.detail) } : {}),
    };
  });
}

function parseTable(raw: Record<string, unknown>): Pick<RemoteUiNode, "columns" | "rows"> {
  if (raw.columns === undefined && raw.rows === undefined) return {};
  if (!Array.isArray(raw.columns) || raw.columns.length === 0 || raw.columns.length > REMOTE_UI_MAX_TABLE_COLUMNS) {
    invalid("Remote UI table columns are invalid");
  }
  const columns = raw.columns.map((column) => clampString(column).slice(0, 240));
  if (columns.some((column) => !column)) invalid("Remote UI table column labels are required");
  if (!Array.isArray(raw.rows) || raw.rows.length > REMOTE_UI_MAX_TABLE_ROWS) invalid("Remote UI table rows are invalid");
  const rows = raw.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) invalid("Remote UI table row width does not match columns");
    return row.map((cell) => clampString(cell));
  });
  return { columns, rows };
}

function parseNode(value: unknown, depth: number, stats: { nodes: number }): RemoteUiNode | null {
  if (depth > REMOTE_UI_MAX_DEPTH) invalid("Remote UI tree exceeds depth limit");
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.type !== "string" || !TYPES.has(raw.type)) return null;
  stats.nodes += 1;
  if (stats.nodes > REMOTE_UI_MAX_NODES) invalid("Remote UI tree exceeds node limit");
  const children = Array.isArray(raw.children)
    ? raw.children.map((child) => {
      const parsed = parseNode(child, depth + 1, stats);
      if (!parsed) invalid("Remote UI child node is invalid");
      return parsed;
    })
    : undefined;
  const trailing = raw.trailing !== undefined ? parseTrailing(raw.trailing, depth + 1, stats) : undefined;
  const level = raw.level === 1 || raw.level === 2 || raw.level === 3 ? raw.level : undefined;
  const gap = raw.gap === "sm" || raw.gap === "md" || raw.gap === "lg" ? raw.gap : undefined;
  const tone = raw.tone === "muted" || raw.tone === "faint" || raw.tone === "success"
    || raw.tone === "warning" || raw.tone === "danger" || raw.tone === "info"
    ? raw.tone
    : undefined;
  const variant = raw.variant === "primary" || raw.variant === "ghost" || raw.variant === "danger"
    ? raw.variant
    : undefined;
  const id = boundedId(raw.id);
  const action = boundedId(raw.action);
  const options = parseOptions(raw.options);
  const table = raw.type === "table" ? parseTable(raw) : {};
  const progress = typeof raw.progress === "number" && Number.isFinite(raw.progress) ? raw.progress : undefined;
  const max = typeof raw.max === "number" && Number.isFinite(raw.max) && raw.max > 0 ? raw.max : undefined;
  if (raw.type === "progress" && progress !== undefined && progress < 0) invalid("Remote UI progress value is invalid");
  return {
    type: raw.type as RemoteUiType,
    ...(id ? { id } : {}),
    ...(raw.text !== undefined ? { text: clampString(raw.text) } : {}),
    ...(raw.label !== undefined ? { label: clampString(raw.label) } : {}),
    ...(raw.title !== undefined ? { title: clampString(raw.title) } : {}),
    ...(raw.subtitle !== undefined ? { subtitle: clampString(raw.subtitle) } : {}),
    ...(raw.body !== undefined ? { body: clampString(raw.body) } : {}),
    ...(action ? { action } : {}),
    ...(raw.placeholder !== undefined ? { placeholder: clampString(raw.placeholder) } : {}),
    ...(raw.value !== undefined ? { value: clampString(raw.value) } : {}),
    ...(typeof raw.checked === "boolean" ? { checked: raw.checked } : {}),
    ...(typeof raw.disabled === "boolean" ? { disabled: raw.disabled } : {}),
    ...(tone ? { tone } : {}),
    ...(variant ? { variant } : {}),
    ...(gap ? { gap } : {}),
    ...(level ? { level } : {}),
    ...(raw.language !== undefined ? { language: clampString(raw.language).slice(0, 80) } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(options?.length ? { options } : {}),
    ...table,
    ...(children?.length ? { children } : {}),
    ...(trailing ? { trailing } : {}),
  };
}

export interface RemoteUiAction {
  id: string;
  value?: string | boolean;
}
