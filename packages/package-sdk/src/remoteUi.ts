export const REMOTE_UI_MAX_NODES = 200;
export const REMOTE_UI_MAX_DEPTH = 12;
export const REMOTE_UI_MAX_STRING = 4_000;
export const REMOTE_UI_MAX_UPDATES_PER_SEC = 10;

export type RemoteUiType =
  | "stack"
  | "inline"
  | "text"
  | "heading"
  | "button"
  | "input"
  | "badge"
  | "card"
  | "list"
  | "listItem"
  | "empty";

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
  disabled?: boolean;
  tone?: "muted" | "faint" | "success" | "warning" | "danger" | "info";
  variant?: "primary" | "ghost" | "danger";
  gap?: "sm" | "md" | "lg";
  level?: 1 | 2 | 3;
  children?: RemoteUiNode[];
  trailing?: { type: "badge" | "text"; text?: string; label?: string; tone?: RemoteUiNode["tone"] };
}

const TYPES = new Set<string>([
  "stack", "inline", "text", "heading", "button", "input",
  "badge", "card", "list", "listItem", "empty",
]);

const clampString = (value: unknown, fallback = ""): string => {
  if (typeof value !== "string") return fallback;
  return value.length > REMOTE_UI_MAX_STRING ? value.slice(0, REMOTE_UI_MAX_STRING) : value;
};

export function parseRemoteUiTree(value: unknown): RemoteUiNode {
  const stats = { nodes: 0 };
  const node = parseNode(value, 0, stats);
  if (!node) {
    throw Object.assign(new Error("Remote UI tree is invalid"), { code: "INVALID_REQUEST" });
  }
  return node;
}

function parseTrailing(value: unknown, depth: number, stats: { nodes: number }): RemoteUiNode["trailing"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "badge" && raw.type !== "text") return undefined;
  stats.nodes += 1;
  if (stats.nodes > REMOTE_UI_MAX_NODES) {
    throw Object.assign(new Error("Remote UI tree exceeds node limit"), { code: "INVALID_REQUEST" });
  }
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

function parseNode(value: unknown, depth: number, stats: { nodes: number }): RemoteUiNode | null {
  if (depth > REMOTE_UI_MAX_DEPTH) {
    throw Object.assign(new Error("Remote UI tree exceeds depth limit"), { code: "INVALID_REQUEST" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.type !== "string" || !TYPES.has(raw.type)) return null;
  stats.nodes += 1;
  if (stats.nodes > REMOTE_UI_MAX_NODES) {
    throw Object.assign(new Error("Remote UI tree exceeds node limit"), { code: "INVALID_REQUEST" });
  }
  const children = Array.isArray(raw.children)
    ? raw.children.map((child) => parseNode(child, depth + 1, stats)).filter((child): child is RemoteUiNode => !!child)
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
  return {
    type: raw.type as RemoteUiType,
    ...(typeof raw.id === "string" ? { id: clampString(raw.id) } : {}),
    ...(raw.text !== undefined ? { text: clampString(raw.text) } : {}),
    ...(raw.label !== undefined ? { label: clampString(raw.label) } : {}),
    ...(raw.title !== undefined ? { title: clampString(raw.title) } : {}),
    ...(raw.subtitle !== undefined ? { subtitle: clampString(raw.subtitle) } : {}),
    ...(raw.body !== undefined ? { body: clampString(raw.body) } : {}),
    ...(typeof raw.action === "string" ? { action: clampString(raw.action) } : {}),
    ...(raw.placeholder !== undefined ? { placeholder: clampString(raw.placeholder) } : {}),
    ...(raw.value !== undefined ? { value: clampString(raw.value) } : {}),
    ...(typeof raw.disabled === "boolean" ? { disabled: raw.disabled } : {}),
    ...(tone ? { tone } : {}),
    ...(variant ? { variant } : {}),
    ...(gap ? { gap } : {}),
    ...(level ? { level } : {}),
    ...(children && children.length > 0 ? { children } : {}),
    ...(trailing ? { trailing } : {}),
  };
}

export interface RemoteUiAction {
  id: string;
  value?: string | boolean;
}
