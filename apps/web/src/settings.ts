// Product-level preferences have their own versioned storage record. Older
// builds shared `polyth.settings` with UI preferences, so load performs a
// one-time copy without ever writing the legacy key again.
import { applyThemeSetting, type AppearanceMode } from "./theme.ts";
import { tr } from "./i18n/index.ts";

export const INTERFACE_FONTS = [
  { id: "sans", label: "Inter", stack: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', mono: false },
  { id: "geist", label: "Geist", stack: 'Geist, Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "system", label: "System UI", stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', mono: false },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", stack: '"IBM Plex Sans", Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "source-sans", label: "Source Sans 3", stack: '"Source Sans 3", "Source Sans Pro", Inter, ui-sans-serif, sans-serif', mono: false },
  { id: "atkinson", label: "Atkinson Hyperlegible", stack: '"Atkinson Hyperlegible", Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "serif", label: "Charter", stack: 'Charter, "Bitstream Charter", "Sitka Text", Georgia, serif', mono: false },
  { id: "mono", label: "System Monospace", stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace', mono: true },
  { id: "berkeley-mono", label: "Berkeley Mono", stack: '"Berkeley Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "geist-mono", label: "Geist Mono", stack: '"Geist Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "jetbrains-mono", label: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "commit-mono", label: "Commit Mono", stack: '"Commit Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "cascadia-mono", label: "Cascadia Mono", stack: '"Cascadia Mono", Cascadia, Consolas, ui-monospace, monospace', mono: true },
  { id: "fira-code", label: "Fira Code", stack: '"Fira Code", "Fira Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "iosevka", label: "Iosevka", stack: 'Iosevka, "Iosevka Term", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", stack: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "source-code-pro", label: "Source Code Pro", stack: '"Source Code Pro", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "roboto-mono", label: "Roboto Mono", stack: '"Roboto Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "inconsolata", label: "Inconsolata", stack: 'Inconsolata, ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "ubuntu-mono", label: "Ubuntu Mono", stack: '"Ubuntu Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "menlo", label: "Menlo", stack: 'Menlo, "SF Mono", ui-monospace, Consolas, monospace', mono: true },
  { id: "consolas", label: "Consolas", stack: 'Consolas, "Cascadia Mono", ui-monospace, Menlo, monospace', mono: true },
  { id: "monaco", label: "Monaco", stack: 'Monaco, Menlo, "SF Mono", ui-monospace, Consolas, monospace', mono: true },
  { id: "deja-vu-sans-mono", label: "DejaVu Sans Mono", stack: '"DejaVu Sans Mono", "Liberation Mono", ui-monospace, monospace', mono: true },
] as const;

export type InterfaceFont = (typeof INTERFACE_FONTS)[number]["id"];

export function isInterfaceFont(value: unknown): value is InterfaceFont {
  return typeof value === "string" && INTERFACE_FONTS.some((font) => font.id === value);
}

function interfaceFont(value: InterfaceFont) {
  return INTERFACE_FONTS.find((font) => font.id === value) ?? INTERFACE_FONTS[0];
}

export interface PolythSettings {
  /** Color-palette identity: a preset id or custom theme id. */
  theme: string;
  /** Light/dark rendering is independent from the selected palette. */
  appearanceMode: AppearanceMode;
  density: "comfortable" | "balanced" | "compact";
  fontSize: number; // px, 12–18; scales interface text, not code blocks
  fontFamily: InterfaceFont;
  productName: string; // brand label in the sidebar + document title
  relativeTime: boolean; // "2m ago" vs absolute times in the session list
  /** @deprecated Migrated to desktopSendShortcut. */
  sendOnEnter: boolean;
  desktopSendShortcut: "enter" | "shift-enter";
  mobileSendShortcut: "none" | "enter" | "shift-enter";
  defaultModel: string; // "providerID/modelID", or "" for server default
  autoTitleSessions: boolean; // derive a title from the first prompt
  showArchived: boolean; // show archived sessions in the sidebar
  branchTemplate: string; // git preference, e.g. "feat/{slug}"
  conflictAgentPrompt: string; // hidden model prompt used for PR conflict handoffs
  conflictAgentTarget: "new-session" | "current-session";
}

export const SETTINGS_KEY = "polyth.productSettings.v1";
export const LEGACY_SETTINGS_KEY = "polyth.settings";

export const DEFAULT_SETTINGS: PolythSettings = {
  theme: "dark",
  appearanceMode: "system",
  density: "comfortable",
  fontSize: 14,
  fontFamily: "sans",
  productName: "Polyth",
  relativeTime: true,
  sendOnEnter: true,
  desktopSendShortcut: "enter",
  mobileSendShortcut: "none",
  defaultModel: "",
  autoTitleSessions: true,
  showArchived: false,
  branchTemplate: "feat/{slug}",
  conflictAgentPrompt: "Walk through the merge conflicts in this worktree and resolve them, explaining each decision.",
  conflictAgentTarget: "new-session",
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
  const oldTheme = pickString(r.theme, d.theme).trim() || d.theme;
  const legacySystemTheme = oldTheme === "system";
  const appearanceMode: AppearanceMode = legacySystemTheme
    ? "system"
    : r.appearanceMode === "dark" || r.appearanceMode === "light" || r.appearanceMode === "system"
      ? r.appearanceMode
      : d.appearanceMode;
  return {
    // Pre-appearance-mode builds stored "system" in the palette field. Keep
    // following the OS, with Ember as the migrated palette identity.
    theme: legacySystemTheme ? "dark" : oldTheme,
    appearanceMode,
    density: r.density === "compact" || r.density === "balanced" ? r.density : "comfortable",
    fontSize: pickNumber(r.fontSize, d.fontSize, 12, 18),
    fontFamily: isInterfaceFont(r.fontFamily) ? r.fontFamily : d.fontFamily,
    productName: pickString(r.productName, d.productName).trim() || d.productName,
    relativeTime: pickBool(r.relativeTime, d.relativeTime),
    sendOnEnter: pickBool(r.sendOnEnter, d.sendOnEnter),
    desktopSendShortcut: r.desktopSendShortcut === "shift-enter"
      ? "shift-enter"
      : r.desktopSendShortcut === "enter" || pickBool(r.sendOnEnter, d.sendOnEnter)
        ? "enter"
        : "shift-enter",
    mobileSendShortcut: r.mobileSendShortcut === "enter" || r.mobileSendShortcut === "shift-enter"
      ? r.mobileSendShortcut
      : "none",
    defaultModel: pickString(r.defaultModel, d.defaultModel),
    autoTitleSessions: pickBool(r.autoTitleSessions, d.autoTitleSessions),
    showArchived: pickBool(r.showArchived, d.showArchived),
    branchTemplate: pickString(r.branchTemplate, d.branchTemplate),
    conflictAgentPrompt: pickString(r.conflictAgentPrompt, d.conflictAgentPrompt),
    conflictAgentTarget: r.conflictAgentTarget === "current-session" ? "current-session" : "new-session",
  };
}

/** Coarse bucket for the discrete Interface scale segment (12–18px). CSS keys
 *  off `html[data-interface-size]` when a rule must target one step — e.g. the
 *  compact-shell nav that reads a touch small at the default (medium) size. */
export function interfaceSizeBucket(px: number): "small" | "medium" | "large" {
  if (px <= 13) return "small";
  if (px >= 16) return "large";
  return "medium";
}

export function matchesSendShortcut(shortcut: PolythSettings["desktopSendShortcut"] | PolythSettings["mobileSendShortcut"], shiftKey: boolean): boolean {
  return shortcut === (shiftKey ? "shift-enter" : "enter");
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
    if (typeof localStorage !== "undefined") {
      const current = localStorage.getItem(SETTINGS_KEY);
      if (current !== null) return parseSettings(current);
      const migrated = parseSettings(localStorage.getItem(LEGACY_SETTINGS_KEY));
      localStorage.setItem(SETTINGS_KEY, serializeSettings(migrated));
      return migrated;
    }
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
  applyThemeSetting(s.theme, s.appearanceMode);
  html.dataset.density = s.density;
  html.dataset.interfaceSize = interfaceSizeBucket(s.fontSize);
  html.dataset.font = s.fontFamily;
  const font = interfaceFont(s.fontFamily);
  html.dataset.fontKind = font.mono ? "mono" : "prose";
  html.style.setProperty("--ui-font-family", font.stack);
  const effectiveSize = Math.max(11, s.fontSize - 1);
  html.style.setProperty("--ui-font-size", `${effectiveSize}px`);
  html.style.setProperty("--ui-font-scale", String(effectiveSize / DEFAULT_SETTINGS.fontSize));
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
const EPOCH_IDENTITY_RE = /epoch-pending|confirmation-required|binding-mismatch|epoch-proof-required/i;
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
  const code = typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : "";
  if (EPOCH_IDENTITY_RE.test(raw) || EPOCH_IDENTITY_RE.test(code)) {
    const short = shortMessage(raw);
    return short ? `${action}: ${short}` : action;
  }
  if (RECONNECT_RE.test(raw)) return tr("settings.openCodeReconnecting");
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
