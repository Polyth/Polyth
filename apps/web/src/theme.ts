// F15 themes: a JSON token schema (surface/line/ink/brand/signal/syntax roles)
// resolved to CSS custom properties at one apply point. Bundled presets plus
// custom themes pasted as JSON (stored in localStorage polyth.customThemes);
// theme "system" follows prefers-color-scheme live. Pure parts (validation,
// resolution, CSS-var mapping) are DOM-free and tested.

export interface ThemeTokens {
  /* surfaces */
  bg: string; panel: string; elevated: string; raised: string; sunken: string; inputBg: string;
  /* lines */
  border: string; borderSoft: string;
  /* ink */
  text: string; textDim: string; muted: string; faint: string;
  /* brand */
  accent: string; accentInk: string; accentHi: string;
  /* signals */
  green: string; amber: string; red: string; blue: string; purple: string;
}

/** Optional syntax-role overrides; defaults derive from the signal tokens. */
export interface ThemeSyntax { kw?: string; str?: string; cmt?: string; num?: string; punc?: string }

export interface ThemeSpec {
  id: string;
  name: string;
  appearance: "dark" | "light";
  tokens: ThemeTokens;
  syntax?: ThemeSyntax;
}

export const TOKEN_KEYS: ReadonlyArray<keyof ThemeTokens> = [
  "bg", "panel", "elevated", "raised", "sunken", "inputBg",
  "border", "borderSoft",
  "text", "textDim", "muted", "faint",
  "accent", "accentInk", "accentHi",
  "green", "amber", "red", "blue", "purple",
];

const SYNTAX_KEYS: ReadonlyArray<keyof ThemeSyntax> = ["kw", "str", "cmt", "num", "punc"];

// ---- presets -----------------------------------------------------------------

interface PresetPalette {
  bg: string;
  panel: string;
  elevated: string;
  raised: string;
  sunken: string;
  inputBg: string;
  border: string;
  borderSoft: string;
  accent: string;
  accentHi: string;
}

const darkPreset = (id: string, name: string, palette: PresetPalette): ThemeSpec => ({
  id,
  name,
  appearance: "dark",
  tokens: {
    ...palette,
    text: "#f2f4f7",
    textDim: "#d0d5dc",
    muted: "#aab2bd",
    faint: "#a0a9b5",
    accentInk: "#101216",
    green: "#8ecf78",
    amber: "#e5bd68",
    red: "#f1847b",
    blue: "#82bdf2",
    purple: "#c2a7eb",
  },
});

const lightPreset = (id: string, name: string, palette: PresetPalette): ThemeSpec => ({
  id,
  name,
  appearance: "light",
  tokens: {
    ...palette,
    text: "#202832",
    textDim: "#39434f",
    muted: "#46505c",
    faint: "#525c68",
    accentInk: "#ffffff",
    green: "#337c3e",
    amber: "#946800",
    red: "#b83d37",
    blue: "#28679f",
    purple: "#704aa2",
  },
});

/** ids "dark" and "light" are the pre-F15 settings values and must stay stable. */
export const PRESET_THEMES: ThemeSpec[] = [
  // UX-FIXTURE-VISUAL P1: `faint` (and in light themes `muted`) labels
  // meaningful status metadata (sidebar status/time, header subtitle), so
  // every bundled value holds ≥4.5:1 against its worst-case surface — the
  // accent-wash selected row over the panel.
  {
    id: "dark", name: "Ember Dark", appearance: "dark",
    tokens: {
      bg: "#121110", panel: "#191816", elevated: "#221f1c", raised: "#2a2724", sunken: "#0e0d0c", inputBg: "#161513",
      border: "#35322c", borderSoft: "#2a2723",
      text: "#f0eee8", textDim: "#cbc6bc", muted: "#9c9890", faint: "#96928a",
      accent: "#f49b5b", accentInk: "#1c1109", accentHi: "#f8a869",
      green: "#8bcf6b", amber: "#e4bb62", red: "#f07c71", blue: "#82bff4", purple: "#c4a7ee",
    },
  },
  {
    id: "midnight", name: "Midnight", appearance: "dark",
    tokens: {
      bg: "#0f1115", panel: "#14171d", elevated: "#1a1e26", raised: "#222732", sunken: "#0a0c10", inputBg: "#12151b",
      border: "#2c3240", borderSoft: "#232837",
      text: "#e8eaf0", textDim: "#c2c7d4", muted: "#8f96a8", faint: "#8990a1",
      accent: "#7aa2f7", accentInk: "#0a0f1a", accentHi: "#8fb3ff",
      green: "#9ece6a", amber: "#e0af68", red: "#f7768e", blue: "#7dcfff", purple: "#bb9af7",
    },
  },
  {
    id: "forest", name: "Forest", appearance: "dark",
    tokens: {
      bg: "#0e1310", panel: "#131a15", elevated: "#19241c", raised: "#223027", sunken: "#0a0e0b", inputBg: "#111812",
      border: "#2b3a30", borderSoft: "#223028",
      text: "#e6efe7", textDim: "#c3d2c6", muted: "#8fa396", faint: "#889a8e",
      accent: "#7fd08a", accentInk: "#0b130d", accentHi: "#93e09e",
      green: "#8bcf6b", amber: "#dcbb6a", red: "#ec8074", blue: "#7fb8e6", purple: "#b8a3e6",
    },
  },
  {
    // White action ink matches the light shell and reaches ≥4.5:1 over both
    // accessible orange gradient endpoints.
    id: "light", name: "Parchment", appearance: "light",
    tokens: {
      bg: "#faf8f4", panel: "#f1ede6", elevated: "#ffffff", raised: "#f3efe8", sunken: "#e9e4da", inputBg: "#ffffff",
      border: "#d5cec1", borderSoft: "#e2dcd2",
      text: "#2a2620", textDim: "#4d473e", muted: "#5b564e", faint: "#6a6357",
      accent: "#b54d00", accentInk: "#ffffff", accentHi: "#bd5700",
      green: "#4d9432", amber: "#a97d14", red: "#c4453a", blue: "#2f6fae", purple: "#7a53b8",
    },
  },
  {
    // UX-A390: mid-tone blues fail 4.5:1 against both black and white, so the
    // accents darken until the near-white ink passes both gradient endpoints
    // (5.65 vs accent, 4.77 vs accentHi).
    id: "mist", name: "Mist", appearance: "light",
    tokens: {
      bg: "#f4f6f8", panel: "#e9edf1", elevated: "#ffffff", raised: "#eef1f5", sunken: "#dde3e9", inputBg: "#ffffff",
      border: "#c6cfd8", borderSoft: "#d8dfe6",
      text: "#24292f", textDim: "#454c54", muted: "#4d535a", faint: "#57616c",
      accent: "#2d64ae", accentInk: "#f7fafc", accentHi: "#3870bb",
      green: "#3e8636", amber: "#9a6d00", red: "#c03d33", blue: "#2f6fae", purple: "#7a53b8",
    },
  },
  {
    // UX-A390: accentInk is Solarized base03 so Send/primary-action text
    // reaches ≥4.5:1 over both endpoints (4.75 vs accent, 5.85 vs accentHi).
    id: "solar", name: "Solar", appearance: "light",
    tokens: {
      bg: "#fdf6e3", panel: "#f3ecd9", elevated: "#fffdf5", raised: "#f5eeda", sunken: "#e9e2cd", inputBg: "#fffdf5",
      border: "#d5cdb4", borderSoft: "#e2dbc4",
      text: "#3b4a51", textDim: "#586e75", muted: "#4b575c", faint: "#56656b",
      accent: "#2aa198", accentInk: "#002b36", accentHi: "#35b3aa",
      green: "#859900", amber: "#b58900", red: "#dc322f", blue: "#268bd2", purple: "#6c71c4",
    },
  },
  darkPreset("ocean", "Deep Ocean", {
    bg: "#091419", panel: "#0e1c22", elevated: "#14262e", raised: "#1b3039", sunken: "#061014", inputBg: "#0b181e",
    border: "#29414a", borderSoft: "#20343d", accent: "#69c8d4", accentHi: "#80d7e1",
  }),
  darkPreset("violet", "Velvet Violet", {
    bg: "#15111c", panel: "#1c1725", elevated: "#261f31", raised: "#30273d", sunken: "#100c16", inputBg: "#191320",
    border: "#443653", borderSoft: "#372c45", accent: "#c3a6ff", accentHi: "#d0b8ff",
  }),
  darkPreset("graphite", "Graphite", {
    bg: "#111315", panel: "#181a1d", elevated: "#202328", raised: "#292d32", sunken: "#0c0e10", inputBg: "#15171a",
    border: "#393e45", borderSoft: "#2e3339", accent: "#d0d4dc", accentHi: "#e1e4ea",
  }),
  darkPreset("nord", "Nord Night", {
    bg: "#171c24", panel: "#1d2430", elevated: "#252e3b", raised: "#2c3745", sunken: "#11161d", inputBg: "#1a202a",
    border: "#3c495a", borderSoft: "#303b49", accent: "#88c0d0", accentHi: "#9acbd8",
  }),
  darkPreset("contrast-dark", "High Contrast Dark", {
    bg: "#050505", panel: "#0c0c0c", elevated: "#151515", raised: "#202020", sunken: "#000000", inputBg: "#090909",
    border: "#4b4b4b", borderSoft: "#323232", accent: "#ffd447", accentHi: "#ffe074",
  }),
  darkPreset("rose-night", "Rose Night", {
    bg: "#180f14", panel: "#21151c", elevated: "#2b1d25", raised: "#36252e", sunken: "#10090d", inputBg: "#1d1118",
    border: "#49333d", borderSoft: "#3a2932", accent: "#f19ab2", accentHi: "#f6aec2",
  }),
  darkPreset("copper", "Copper Forge", {
    bg: "#17110d", panel: "#201813", elevated: "#2a211a", raised: "#352a21", sunken: "#100b08", inputBg: "#1b140f",
    border: "#493a2e", borderSoft: "#3a2e25", accent: "#e9a66f", accentHi: "#f1b884",
  }),
  lightPreset("cloud", "Cloud", {
    bg: "#f9fbfd", panel: "#f1f4f7", elevated: "#ffffff", raised: "#eef1f4", sunken: "#e2e7ec", inputBg: "#ffffff",
    border: "#c9d1d9", borderSoft: "#dbe1e7", accent: "#285b91", accentHi: "#326ba6",
  }),
  lightPreset("sage", "Soft Sage", {
    bg: "#f5f8f4", panel: "#ebf1e9", elevated: "#ffffff", raised: "#edf3eb", sunken: "#dfe8dc", inputBg: "#ffffff",
    border: "#c4d0c0", borderSoft: "#d7e0d4", accent: "#2f6f52", accentHi: "#3b7b5f",
  }),
  lightPreset("lavender", "Lavender", {
    bg: "#f8f7fb", panel: "#efedf5", elevated: "#ffffff", raised: "#eceaf2", sunken: "#dfdce8", inputBg: "#ffffff",
    border: "#ccc7d8", borderSoft: "#dedbe6", accent: "#68449a", accentHi: "#7654a7",
  }),
  lightPreset("sand", "Warm Sand", {
    bg: "#fbf8f1", panel: "#f2ece0", elevated: "#fffefa", raised: "#f4eee3", sunken: "#e8dfcf", inputBg: "#fffefa",
    border: "#d2c6b2", borderSoft: "#e1d8c8", accent: "#81551d", accentHi: "#936528",
  }),
  lightPreset("contrast-light", "High Contrast Light", {
    bg: "#ffffff", panel: "#f4f4f4", elevated: "#ffffff", raised: "#ececec", sunken: "#dedede", inputBg: "#ffffff",
    border: "#9c9c9c", borderSoft: "#c8c8c8", accent: "#111111", accentHi: "#282828",
  }),
  lightPreset("rosewater", "Rosewater", {
    bg: "#fff8fa", panel: "#f7ecef", elevated: "#ffffff", raised: "#f8eef1", sunken: "#eadde1", inputBg: "#ffffff",
    border: "#d8c3ca", borderSoft: "#e7d8dd", accent: "#8c3d5b", accentHi: "#9a4967",
  }),
  lightPreset("glacier", "Glacier", {
    bg: "#f4fafb", panel: "#e8f2f4", elevated: "#ffffff", raised: "#eaf4f5", sunken: "#d9e8eb", inputBg: "#ffffff",
    border: "#bdd0d5", borderSoft: "#d3e0e3", accent: "#176675", accentHi: "#257382",
  }),
];

export const DEFAULT_THEME: ThemeSpec = PRESET_THEMES.find((theme) => theme.id === "light")!;

// ---- validation ---------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type ThemeValidation = { ok: true; theme: ThemeSpec } | { ok: false; error: string };

/** Validate untrusted theme JSON; failures carry the reason (F15 accept). */
export function validateTheme(raw: unknown, opts: { allowPresetIds?: boolean } = {}): ThemeValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "theme must be a JSON object" };
  }
  const t = raw as Partial<ThemeSpec> & { tokens?: Record<string, unknown>; syntax?: Record<string, unknown> };
  if (typeof t.id !== "string" || !ID_RE.test(t.id)) {
    return { ok: false, error: "id must be a lowercase slug (letters, digits, dashes; max 32 chars)" };
  }
  if (!opts.allowPresetIds && PRESET_THEMES.some((p) => p.id === t.id)) {
    return { ok: false, error: `id "${t.id}" is reserved by a built-in theme` };
  }
  if (typeof t.name !== "string" || !t.name.trim() || t.name.length > 40) {
    return { ok: false, error: "name must be a non-empty string (max 40 chars)" };
  }
  if (t.appearance !== "dark" && t.appearance !== "light") {
    return { ok: false, error: 'appearance must be "dark" or "light"' };
  }
  if (typeof t.tokens !== "object" || t.tokens === null) {
    return { ok: false, error: "tokens must be an object of color roles" };
  }
  const tokens = {} as ThemeTokens;
  for (const key of TOKEN_KEYS) {
    const v = t.tokens[key];
    if (v === undefined) return { ok: false, error: `tokens.${key} is missing` };
    if (typeof v !== "string" || !HEX_RE.test(v)) {
      return { ok: false, error: `tokens.${key} must be a hex color like #aabbcc` };
    }
    tokens[key] = v;
  }
  let syntax: ThemeSyntax | undefined;
  if (t.syntax !== undefined) {
    if (typeof t.syntax !== "object" || t.syntax === null) return { ok: false, error: "syntax must be an object" };
    syntax = {};
    for (const key of SYNTAX_KEYS) {
      const v = t.syntax[key];
      if (v === undefined) continue;
      if (typeof v !== "string" || !HEX_RE.test(v)) {
        return { ok: false, error: `syntax.${key} must be a hex color like #aabbcc` };
      }
      syntax[key] = v;
    }
  }
  return {
    ok: true,
    theme: { id: t.id, name: t.name.trim(), appearance: t.appearance, tokens, ...(syntax ? { syntax } : {}) },
  };
}

/** Parse pasted theme JSON; JSON errors are reported with their reason. */
export function parseThemeJson(text: string): ThemeValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  return validateTheme(raw);
}

// ---- token → CSS variable mapping (pure) --------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

const rgba = (hex: string, alpha: number): string => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** Opaque blend of fg over bg — used for the user-bubble surface so it tracks
 *  the theme's accent instead of a hardcoded brown. */
const blend = (fg: string, bg: string, amount: number): string => {
  const [fr, fg_, fb] = hexToRgb(fg);
  const [br, bg_, bb] = hexToRgb(bg);
  const mix = (a: number, b: number) => Math.round(b + (a - b) * amount);
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(mix(fr, br))}${to2(mix(fg_, bg_))}${to2(mix(fb, bb))}`;
};

/** Resolve a theme to the CSS custom properties it sets. One place derives
 *  every wash/hairline/rgb variant so custom themes only supply base roles. */
export function themeCssVars(spec: ThemeSpec): Record<string, string> {
  const t = spec.tokens;
  const dark = spec.appearance === "dark";
  const accentRgb = hexToRgb(t.accent).join(", ");
  const amberRgb = hexToRgb(t.amber).join(", ");
  return {
    "--bg": t.bg, "--panel": t.panel, "--elevated": t.elevated, "--raised": t.raised,
    "--sunken": t.sunken, "--input-bg": t.inputBg,
    "--border": t.border, "--border-soft": t.borderSoft,
    "--hair": rgba(t.text, dark ? 0.055 : 0.07),
    "--hair-strong": rgba(t.text, dark ? 0.09 : 0.12),
    "--text": t.text, "--text-dim": t.textDim, "--muted": t.muted, "--faint": t.faint,
    "--accent": t.accent, "--accent-ink": t.accentInk, "--accent-hi": t.accentHi,
    "--accent-wash": rgba(t.accent, dark ? 0.13 : 0.12),
    "--accent-line": rgba(t.accent, dark ? 0.32 : 0.4),
    "--accent-rgb": accentRgb,
    "--green": t.green, "--amber": t.amber, "--amber-rgb": amberRgb,
    "--red": t.red, "--blue": t.blue, "--purple": t.purple,
    "--scrim": dark ? "rgba(9, 8, 7, 0.62)" : "rgba(60, 50, 35, 0.4)",
    "--shadow-lg": dark
      ? "0 40px 90px -24px rgba(0, 0, 0, 0.72), 0 8px 28px -12px rgba(0, 0, 0, 0.6)"
      : "0 40px 90px -24px rgba(60, 45, 25, 0.35), 0 8px 28px -12px rgba(60, 45, 25, 0.25)",
    "--inset-hi": dark ? "inset 0 1px 0 rgba(255, 255, 255, 0.045)" : "inset 0 1px 0 rgba(255, 255, 255, 0.6)",
    "--bubble-user-bg": blend(t.accent, t.panel, 0.13),
    "--bubble-user-line": blend(t.accent, t.panel, 0.33),
    "--syntax-kw": spec.syntax?.kw ?? t.purple,
    "--syntax-str": spec.syntax?.str ?? t.green,
    "--syntax-cmt": spec.syntax?.cmt ?? t.faint,
    "--syntax-num": spec.syntax?.num ?? t.amber,
    "--syntax-punc": spec.syntax?.punc ?? t.muted,
  };
}

// ---- custom theme store (localStorage polyth.customThemes) --------------------

export const CUSTOM_THEMES_KEY = "polyth.customThemes";
const MAX_CUSTOM_THEMES = 20;

export function parseCustomThemes(raw: string | null): ThemeSpec[] {
  try {
    const list = JSON.parse(raw ?? "") as unknown;
    if (!Array.isArray(list)) return [];
    const out: ThemeSpec[] = [];
    for (const entry of list) {
      const res = validateTheme(entry);
      if (res.ok && !out.some((t) => t.id === res.theme.id)) out.push(res.theme);
      if (out.length >= MAX_CUSTOM_THEMES) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function loadCustomThemes(): ThemeSpec[] {
  try { return parseCustomThemes(localStorage.getItem(CUSTOM_THEMES_KEY)); } catch { return []; }
}

function persistCustomThemes(themes: ThemeSpec[]): void {
  try { localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes)); } catch { /* private mode */ }
}

/** Add or replace (by id); returns the new list. */
export function addCustomTheme(theme: ThemeSpec): ThemeSpec[] {
  const next = [...loadCustomThemes().filter((t) => t.id !== theme.id), theme].slice(-MAX_CUSTOM_THEMES);
  persistCustomThemes(next);
  return next;
}

export function removeCustomTheme(id: string): ThemeSpec[] {
  const next = loadCustomThemes().filter((t) => t.id !== id);
  persistCustomThemes(next);
  return next;
}

// ---- resolution + apply --------------------------------------------------------

/** Map the persisted theme setting to a concrete theme. "system" follows the
 *  OS scheme; unknown ids (e.g. a deleted custom theme) fall back to default. */
export function resolveTheme(
  setting: string,
  opts: { systemDark?: boolean; custom?: ThemeSpec[] } = {},
): ThemeSpec {
  if (setting === "system") {
    const wantDark = opts.systemDark !== false;
    return PRESET_THEMES.find((p) => p.appearance === (wantDark ? "dark" : "light")) ?? DEFAULT_THEME;
  }
  return (
    PRESET_THEMES.find((p) => p.id === setting) ??
    (opts.custom ?? []).find((t) => t.id === setting) ??
    DEFAULT_THEME
  );
}

/** Apply a concrete theme to <html>: CSS variables, the .light class for
 *  legacy light-only rules, color-scheme, and a "polyth:theme" event so
 *  canvas-style consumers (Mermaid) can re-render. */
export function applyTheme(spec: ThemeSpec): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  for (const [name, value] of Object.entries(themeCssVars(spec))) html.style.setProperty(name, value);
  html.classList.toggle("light", spec.appearance === "light");
  html.dataset.theme = spec.id;
  html.style.colorScheme = spec.appearance;
  window.dispatchEvent(new Event("polyth:theme"));
}

let appliedSetting: string | null = null;
let systemWatch: MediaQueryList | null = null;

/** Apply the persisted theme setting; installs the prefers-color-scheme
 *  listener once so "system" flips live without a reload. */
export function applyThemeSetting(setting: string): void {
  if (typeof document === "undefined") return;
  appliedSetting = setting;
  if (systemWatch === null && typeof matchMedia === "function") {
    systemWatch = matchMedia("(prefers-color-scheme: dark)");
    systemWatch.addEventListener?.("change", () => {
      if (appliedSetting === "system") applyThemeSetting("system");
    });
  }
  applyTheme(resolveTheme(setting, { systemDark: systemWatch?.matches ?? true, custom: loadCustomThemes() }));
}

/** Re-apply whatever setting is active (used to end a hover preview). */
export function reapplyTheme(): void {
  if (appliedSetting !== null) applyThemeSetting(appliedSetting);
}
