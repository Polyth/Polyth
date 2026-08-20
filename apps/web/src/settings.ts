// Local UI preferences persisted under localStorage["polyth.settings"],
// plus DOM-free error-message helpers. Pure parts are covered by smoke tests.
import { applyThemeSetting } from "./theme.ts";

export interface PolythSettings {
  /** Theme setting (F15): a preset id ("dark", "light", "midnight", …),
   *  a custom theme id from polyth.customThemes, or "system" to follow the
   *  OS scheme. Unknown ids resolve to the default dark preset. */
  theme: string;
  density: "comfortable" | "compact";
  fontSize: number; // px, 12–18; scales the UI, not code blocks
  productName: string; // brand label in the sidebar + document title
  relativeTime: boolean; // "2m ago" vs absolute times in the session list
  sendOnEnter: boolean; // Enter sends; off → Enter is newline, Mod+Enter sends
  defaultModel: string; // "providerID/modelID", or "" for server default
  autoTitleSessions: boolean; // derive a title from the first prompt
  showArchived: boolean; // show archived sessions in the sidebar
  branchTemplate: string; // git preference, e.g. "feat/{slug}"
}

export const SETTINGS_KEY = "polyth.settings";

export const DEFAULT_SETTINGS: PolythSettings = {
  theme: "dark",
  density: "comfortable",
  fontSize: 14,
  productName: "Polyth",
  relativeTime: true,
  sendOnEnter: true,
  defaultModel: "",
  autoTitleSessions: true,
  showArchived: true,
  branchTemplate: "feat/{slug}",
};

function pickNumber(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}
function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function pickString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

// Accepts anything (old versions, hand-edited JSON) and returns a valid shape.
export function normalizeSettings(raw: unknown): PolythSettings {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    theme: pickString(r.theme, d.theme).trim() || d.theme,
    density: r.density === "compact" ? "compact" : "comfortable",
    fontSize: pickNumber(r.fontSize, d.fontSize, 12, 18),
    productName: pickString(r.productName, d.productName).trim() || d.productName,
    relativeTime: pickBool(r.relativeTime, d.relativeTime),
    sendOnEnter: pickBool(r.sendOnEnter, d.sendOnEnter),
    defaultModel: pickString(r.defaultModel, d.defaultModel),
    autoTitleSessions: pickBool(r.autoTitleSessions, d.autoTitleSessions),
    showArchived: pickBool(r.showArchived, d.showArchived),
    branchTemplate: pickString(r.branchTemplate, d.branchTemplate),
  };
}

export function parseSettings(json: string | null | undefined): PolythSettings {
  if (!json) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(json));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function serializeSettings(s: PolythSettings): string {
  return JSON.stringify(s);
}

export function loadSettings(): PolythSettings {
  try {
    if (typeof localStorage !== "undefined") return parseSettings(localStorage.getItem(SETTINGS_KEY));
  } catch {
    // storage unavailable (private mode, node)
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: PolythSettings): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(SETTINGS_KEY, serializeSettings(s));
  } catch {
    // storage unavailable — settings stay in-memory for the tab
  }
}

// Theme tokens, density attribute, UI font size, and title on <html>/<title>.
export function applySettingsToDom(s: PolythSettings): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  applyThemeSetting(s.theme);
  html.dataset.density = s.density;
  html.style.setProperty("--ui-font-size", `${s.fontSize}px`);
  document.title = s.productName;
}

// ---- model ref preference ---------------------------------------------------

export function parseModelRef(value: string): { providerID: string; modelID: string } | undefined {
  const i = value.indexOf("/");
  if (i <= 0 || i === value.length - 1) return undefined;
  return { providerID: value.slice(0, i), modelID: value.slice(i + 1) };
}

export function formatModelRef(ref: { providerID: string; modelID: string }): string {
  return `${ref.providerID}/${ref.modelID}`;
}

// ---- error display ----------------------------------------------------------

const RECONNECT_RE = /\b503\b|unavailable|reconnect|fetch failed|econnrefused|socket hang up|network error/i;
const MAX_ERR_LEN = 160;

function truncate(s: string): string {
  return s.length > MAX_ERR_LEN ? `${s.slice(0, MAX_ERR_LEN - 1).trimEnd()}…` : s;
}

// API errors look like: `HTTP 500 Internal Server Error — {"error":"…"}`.
// Pull the human part out of the JSON body when present.
function shortMessage(raw: string): string {
  const dash = raw.indexOf("—");
  if (dash >= 0) {
    const head = raw.slice(0, dash).trim();
    const tail = raw.slice(dash + 1).trim();
    if (tail.startsWith("{")) {
      try {
        const body = JSON.parse(tail) as Record<string, unknown>;
        const inner = body.error ?? body.message;
        if (typeof inner === "string" && inner.trim() !== "") return truncate(`${head} — ${inner.trim()}`);
      } catch {
        // not JSON; fall through to the head
      }
      return truncate(head);
    }
  }
  return truncate(raw.trim());
}

// Human-readable failure line for the error banner. Transport-level failures
// (503, fetch failed, refused) collapse into one calm reconnect message.
export function friendlyError(action: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (RECONNECT_RE.test(raw)) return "OpenCode is reconnecting. Try again in a moment.";
  const short = shortMessage(raw);
  return short ? `${action}: ${short}` : action;
}

// "⌘" on Apple platforms, "Ctrl" elsewhere; DOM-guarded for tests.
export function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  const hint = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(hint) ? "⌘" : "Ctrl";
}

// Compact one-chip shortcut label: "⌘K" on Apple platforms, "Ctrl+K" elsewhere.
export function shortcutLabel(key: string): string {
  const mod = modKeyLabel();
  return mod === "⌘" ? `⌘${key}` : `${mod}+${key}`;
}
