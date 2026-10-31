// Product-level preferences have their own versioned storage record. Older
// builds shared `polyth.settings` with UI preferences, so load performs a
// one-time copy without ever writing the legacy key again.
import { THEME_STYLE_CHOICES, applyThemeSetting, type AppearanceMode, type ThemeStyleChoice } from "./theme.ts";
import { readErrorDiagnostics } from "@polyth/contracts";
import { isRequestAbort, isTransportFailure, shortMessage } from "./errorPresentation.ts";
import { tr } from "./i18n/index.ts";

// `theme` is the face the theme style draws in (SF Pro on macOS and Liquid
// Glass, Segoe on Fluent, Open Sans on Classic); every other id is that exact
// face on every style. The stack here is Classic's — styles override it in CSS.
export const INTERFACE_FONTS = [
  { id: "theme", label: "Theme font", stack: '"Open Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', mono: false },
  { id: "inter", label: "Inter", stack: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', mono: false },
  { id: "opensans", label: "Open Sans", stack: '"Open Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', mono: false },
  { id: "montserrat", label: "Montserrat", stack: 'Montserrat, Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "roboto", label: "Roboto", stack: 'Roboto, Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "noto-sans", label: "Noto Sans", stack: '"Noto Sans", Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "geist", label: "Geist", stack: 'Geist, Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "plus-jakarta-sans", label: "Plus Jakarta Sans", stack: '"Plus Jakarta Sans", Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "figtree", label: "Figtree", stack: 'Figtree, Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "outfit", label: "Outfit", stack: 'Outfit, Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "dm-sans", label: "DM Sans", stack: '"DM Sans", Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "manrope", label: "Manrope", stack: 'Manrope, Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "atkinson", label: "Atkinson Hyperlegible", stack: '"Atkinson Hyperlegible", Inter, ui-sans-serif, system-ui, sans-serif', mono: false },
  { id: "system", label: "System UI", stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', mono: false },
  { id: "serif", label: "Source Serif 4", stack: '"Source Serif 4", Charter, "Bitstream Charter", "Sitka Text", Georgia, serif', mono: false },
  { id: "jetbrains-mono", label: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "fira-code", label: "Fira Code", stack: '"Fira Code", "Fira Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "geist-mono", label: "Geist Mono", stack: '"Geist Mono", ui-monospace, Menlo, Consolas, monospace', mono: true },
  { id: "cascadia-mono", label: "Cascadia Code", stack: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace', mono: true },
  { id: "mono", label: "System Monospace", stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace', mono: true },
] as const;

export type InterfaceFont = (typeof INTERFACE_FONTS)[number]["id"];

/** Visible name of an interface font: the generic choices read in the active
 *  language, named faces stay as their foundries publish them. */
export function interfaceFontLabel(id: string): string {
  if (id === "theme") return tr("settings.pages.themeFont");
  if (id === "system") return tr("settings.pages.systemUi");
  if (id === "mono") return tr("settings.pages.systemMonospace");
  return INTERFACE_FONTS.find((font) => font.id === id)?.label ?? id;
}

const LEGACY_FONT_ALIASES: Record<string, InterfaceFont> = {
  // "sans" and "open-sans" were swapped for the style's own face on every
  // style but Classic, so what their records actually showed is the theme font.
  "sans": "theme",
  "open-sans": "theme",
  "ibm-plex-sans": "theme",
  "source-sans": "theme",
  "berkeley-mono": "jetbrains-mono",
  "commit-mono": "jetbrains-mono",
  "iosevka": "fira-code",
  "ibm-plex-mono": "geist-mono",
  "source-code-pro": "jetbrains-mono",
  "roboto-mono": "geist-mono",
  "inconsolata": "fira-code",
  "ubuntu-mono": "jetbrains-mono",
  "menlo": "mono",
  "consolas": "mono",
  "monaco": "mono",
  "deja-vu-sans-mono": "mono",
};

export function isInterfaceFont(value: unknown): value is InterfaceFont {
  return typeof value === "string" && INTERFACE_FONTS.some((font) => font.id === value);
}

function interfaceFont(value: InterfaceFont) {
  return INTERFACE_FONTS.find((font) => font.id === value) ?? INTERFACE_FONTS[0];
}

export const DEFAULT_VISIBLE_SESSION_COUNT = 6;
/** Large values remain available; the settings UI asks for confirmation first. */
export const VISIBLE_SESSION_WARNING_THRESHOLD = 20;
export const MAX_VISIBLE_SESSION_COUNT = 1_000;

export interface PolythSettings {
  /** Color-palette identity: a preset id or custom theme id. */
  theme: string;
  /** Light/dark rendering is independent from the selected palette. */
  appearanceMode: AppearanceMode;
  /** Design language the palette is drawn in, independent of the colours.
   *  `auto` (records saved before the split) follows the palette's own. */
  themeStyle: ThemeStyleChoice;
  /** Accent source colour (#rrggbb) over any palette; "" keeps the palette's. */
  accentColor: string;
  density: "comfortable" | "balanced" | "compact";
  /** Menu and shell text size in px: navigation, labels, settings, panels. */
  fontSize: number;
  /** Conversation text size in px: messages, composer, and chat activity. */
  chatFontSize: number;
  fontFamily: InterfaceFont;
  productName: string; // brand label in the sidebar + document title
  relativeTime: boolean; // "2m ago" vs absolute times in the session list
  /** @deprecated Migrated to desktopSendShortcut. */
  sendOnEnter: boolean;
  desktopSendShortcut: "enter" | "shift-enter";
  mobileSendShortcut: "none" | "enter" | "shift-enter";
  defaultModel: string; // "providerID/modelID", or "" for server default
  autoTitleSessions: boolean; // derive a title from the first prompt
  /** Delete a newly-created session after a confirmed first-turn startup
   * failure when the canonical log contains no assistant output. */
  autoDeleteFailedStartupSessions: boolean;
  showArchived: boolean; // show archived sessions in the sidebar
  /** Number of sessions the navigator shows before the user expands it. */
  defaultVisibleSessionCount: number;
  branchTemplate: string; // git preference, e.g. "feat/{slug}"
  conflictAgentPrompt: string; // hidden model prompt used for PR conflict handoffs
  conflictAgentTarget: "new-session" | "current-session";
}

export const SETTINGS_KEY = "polyth.productSettings.v1";
export const LEGACY_SETTINGS_KEY = "polyth.settings";

/** Bounds for both text-size controls. Shared so the sliders and the stored
 *  record cannot disagree about what a legal size is. */
export const TEXT_SIZE_MIN = 10;
export const TEXT_SIZE_MAX = 32;
/** The text size the token scale is designed at (scale 1). Independent of the
 *  default sizes, so changing a default never resizes anyone's saved text. */
export const TEXT_SCALE_BASE = 15;

export const DEFAULT_SETTINGS: PolythSettings = {
  theme: "liquid-glass",
  // Light or dark follows the operating system until the person picks one.
  appearanceMode: "system",
  themeStyle: "liquid-glass",
  accentColor: "",
  density: "compact",
  fontSize: 14,
  chatFontSize: 15,
  fontFamily: "theme",
  productName: "Polyth",
  relativeTime: true,
  sendOnEnter: true,
  desktopSendShortcut: "enter",
  mobileSendShortcut: "none",
  defaultModel: "",
  autoTitleSessions: true,
  autoDeleteFailedStartupSessions: true,
  showArchived: false,
  defaultVisibleSessionCount: DEFAULT_VISIBLE_SESSION_COUNT,
  branchTemplate: "feat/{slug}",
  conflictAgentPrompt: "Walk through the merge conflicts in this worktree and resolve them, explaining each decision.",
  conflictAgentTarget: "new-session",
};

const ACCENT_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

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
/** Appearance a saved record had before these fields' defaults changed. A
 *  record that lacks one keeps it; only a fresh install (no record at all)
 *  starts from DEFAULT_SETTINGS, so a new default never restyles anyone. */
const LEGACY_APPEARANCE = {
  theme: "midnight",
  appearanceMode: "system",
  themeStyle: "auto",
  density: "comfortable",
  fontSize: 15,
  chatFontSize: 15,
  fontFamily: "theme",
} as const satisfies Partial<PolythSettings>;

export function normalizeSettings(raw: unknown): PolythSettings {
  const r = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = { ...DEFAULT_SETTINGS, ...LEGACY_APPEARANCE };
  const oldTheme = pickString(r.theme, d.theme).trim() || d.theme;
  const legacySystemTheme = oldTheme === "system";
  const appearanceMode: AppearanceMode = legacySystemTheme
    ? "system"
    : r.appearanceMode === "dark" || r.appearanceMode === "light" || r.appearanceMode === "system"
      ? r.appearanceMode
      : d.appearanceMode;
  return {
    // Pre-appearance-mode builds stored "system" in the palette field. Keep
    // following the OS, with the previous default palette as the migrated
    // identity so an existing record is not restyled by a new base theme.
    theme: legacySystemTheme ? "midnight" : oldTheme,
    appearanceMode,
    // A record from before style and colours split keeps drawing its palette
    // in the palette's own style until the user picks a style.
    themeStyle: r.themeStyle === "auto" || THEME_STYLE_CHOICES.includes(r.themeStyle as Exclude<ThemeStyleChoice, "auto">)
      ? r.themeStyle as ThemeStyleChoice
      : d.themeStyle,
    accentColor: typeof r.accentColor === "string" && ACCENT_COLOR_RE.test(r.accentColor) ? r.accentColor.toLowerCase() : "",
    density: r.density === "compact" || r.density === "balanced" ? r.density : "comfortable",
    fontSize: pickNumber(r.fontSize, d.fontSize, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
    // Chat and menu text were one control until they split. A record written
    // before the split carries no chat size, so it keeps the caliber that
    // record already had instead of resetting a transcript to the default.
    chatFontSize: pickNumber(
      r.chatFontSize,
      pickNumber(r.fontSize, d.chatFontSize, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
      TEXT_SIZE_MIN,
      TEXT_SIZE_MAX,
    ),
    fontFamily: isInterfaceFont(r.fontFamily)
      ? r.fontFamily
      : (typeof r.fontFamily === "string" && LEGACY_FONT_ALIASES[r.fontFamily]) || d.fontFamily,
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
    autoDeleteFailedStartupSessions: pickBool(r.autoDeleteFailedStartupSessions, d.autoDeleteFailedStartupSessions),
    showArchived: pickBool(r.showArchived, d.showArchived),
    defaultVisibleSessionCount: pickNumber(
      r.defaultVisibleSessionCount,
      d.defaultVisibleSessionCount,
      1,
      MAX_VISIBLE_SESSION_COUNT,
    ),
    branchTemplate: pickString(r.branchTemplate, d.branchTemplate),
    conflictAgentPrompt: pickString(r.conflictAgentPrompt, d.conflictAgentPrompt),
    conflictAgentTarget: r.conflictAgentTarget === "current-session" ? "current-session" : "new-session",
  };
}

/** Compatibility bucket for older CSS consumers. Typography itself is now
 *  continuous; new styles should consume the font-size variables directly. */
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

// Theme tokens, density metadata, continuous UI font size, and title on <html>/<title>.
export function applySettingsToDom(s: PolythSettings): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  applyThemeSetting(s.theme, s.appearanceMode, { style: s.themeStyle, accent: s.accentColor });
  html.dataset.density = s.density;
  html.dataset.interfaceSize = interfaceSizeBucket(s.fontSize);
  html.dataset.font = s.fontFamily;
  const font = interfaceFont(s.fontFamily);
  html.dataset.fontKind = font.mono ? "mono" : "prose";
  html.style.setProperty("--ui-font-family", font.stack);
  // Menu text size: published as the size and as the multiplier that
  // `--text-scale` reads everywhere outside a conversation.
  html.style.setProperty("--ui-font-size", `${s.fontSize}px`);
  html.style.setProperty("--ui-font-scale", String(s.fontSize / TEXT_SCALE_BASE));
  // Chat text size: the same pair, bound to the conversation surfaces in
  // tokens.css so a transcript can be resized without the menus around it.
  html.style.setProperty("--chat-font-size", `${s.chatFontSize}px`);
  html.style.setProperty("--chat-font-scale", String(s.chatFontSize / TEXT_SCALE_BASE));
}

// ---- model ref preference ---------------------------------------------------

export function parseModelRef(value: string): { providerID: string; modelID: string } | undefined {
  const i = value.indexOf("/");
  if (i <= 0 || i === value.length - 1) return undefined;
  return { providerID: value.slice(0, i), modelID: value.slice(i + 1) };
}

// ---- error display ----------------------------------------------------------

const EPOCH_IDENTITY_RE = /epoch-pending|confirmation-required|binding-mismatch|epoch-proof-required/i;

/** The write may or may not have happened: the server (or the client, after a
 *  lost response) could not prove either outcome. */
export function isMutationOutcomeUnknown(err: unknown): boolean {
  const diagnostic = readErrorDiagnostics(err);
  return diagnostic.mutationOutcome === "unknown" || diagnostic.code === "outcome-unknown";
}

/** True for a banner built from an unknown write outcome. Such a banner is
 *  never held back: hiding it could let someone believe the write went through. */
export function isMutationOutcomeUnknownMessage(message: string): boolean {
  return message.includes(tr("settings.mutationOutcomeUnknown"))
    || message.includes(tr("composer.newChatOutcomeUnknown"));
}

// Only explicit recovery state may claim that the harness is reconnecting.
// An unknown outcome is described in context-free words: the same helper backs
// archive, git, files and settings actions, where no session or draft exists.
export function friendlyError(action: string, err: unknown): string {
  const diagnostic = readErrorDiagnostics(err);
  if (isMutationOutcomeUnknown(err)) {
    return `${action}: ${tr("settings.mutationOutcomeUnknown")}`;
  }
  if (diagnostic.component === "harness-transport" && diagnostic.recovery === "reconnecting") {
    return tr("settings.harnessReconnecting");
  }
  // A read that hit its deadline is the same lost answer as a dropped socket;
  // WebKit's bare "Fetch is aborted" must never reach the user.
  if (!diagnostic.component && (isTransportFailure(err) || isRequestAbort(err))) return `${action}: ${tr("settings.polythConnectionLost")}`;
  const raw = err instanceof Error ? err.message : String(err);
  const code = typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : "";
  if (EPOCH_IDENTITY_RE.test(raw) || EPOCH_IDENTITY_RE.test(code)) {
    const short = shortMessage(raw);
    return short ? `${action}: ${short}` : action;
  }
  const short = shortMessage(raw);
  return short ? `${action}: ${short}` : action;
}

// "⌘" on Apple platforms, "Ctrl" elsewhere; DOM-guarded for tests.
export function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Ctrl";
  const hint = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(hint) ? "⌘" : "Ctrl";
}
