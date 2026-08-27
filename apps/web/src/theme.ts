// F15 themes: a JSON token schema (surface/line/ink/brand/signal/syntax roles)
// resolved to CSS custom properties at one apply point. Bundled presets plus
// custom themes pasted as JSON (stored in localStorage polyth.customThemes).
// Palette identity and light/dark appearance are independent settings. Pure
// parts (validation, adaptation, resolution, CSS-var mapping) are DOM-free.
import { tr } from "./i18n/index.ts";

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

export type AppearanceMode = "system" | "dark" | "light";

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
    green: "#245f2b",
    amber: "#684900",
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
      green: "#347426", amber: "#7d5900", red: "#c4453a", blue: "#2f6fae", purple: "#7a53b8",
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
      green: "#2f7428", amber: "#785400", red: "#c03d33", blue: "#2f6fae", purple: "#7a53b8",
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
      green: "#586b00", amber: "#765900", red: "#dc322f", blue: "#268bd2", purple: "#6c71c4",
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
  darkPreset("oled", "OLED Black", {
    bg: "#000000", panel: "#050505", elevated: "#0d0d0d", raised: "#181818", sunken: "#000000", inputBg: "#080808",
    border: "#3f3f3f", borderSoft: "#292929", accent: "#f49b5b", accentHi: "#f8a869",
  }),
  darkPreset("rose-night", "Rose Night", {
    bg: "#180f14", panel: "#21151c", elevated: "#2b1d25", raised: "#36252e", sunken: "#10090d", inputBg: "#1d1118",
    border: "#49333d", borderSoft: "#3a2932", accent: "#f19ab2", accentHi: "#f6aec2",
  }),
  darkPreset("copper", "Copper Forge", {
    bg: "#17110d", panel: "#201813", elevated: "#2a211a", raised: "#352a21", sunken: "#100b08", inputBg: "#1b140f",
    border: "#493a2e", borderSoft: "#3a2e25", accent: "#e9a66f", accentHi: "#f1b884",
  }),
  darkPreset("aurora", "Aurora", {
    bg: "#071615", panel: "#0d201e", elevated: "#142b28", raised: "#1c3733", sunken: "#04100f", inputBg: "#091b19",
    border: "#2c4b46", borderSoft: "#203c38", accent: "#75dfca", accentHi: "#91ead8",
  }),
  darkPreset("obsidian", "Obsidian Gold", {
    bg: "#0d0d0f", panel: "#151519", elevated: "#1d1d23", raised: "#28272e", sunken: "#08080a", inputBg: "#111114",
    border: "#3a3942", borderSoft: "#2c2b33", accent: "#eac66d", accentHi: "#f0d487",
  }),
  darkPreset("blackberry", "Blackberry", {
    bg: "#160d18", panel: "#201324", elevated: "#2a1a30", raised: "#35223d", sunken: "#0f0811", inputBg: "#1b0f1e",
    border: "#4a3152", borderSoft: "#3b2742", accent: "#dba2ed", accentHi: "#e5b6f2",
  }),
  darkPreset("tokyo", "Tokyo Night", {
    bg: "#10131c", panel: "#171b28", elevated: "#1e2433", raised: "#283044", sunken: "#0a0d14", inputBg: "#131725",
    border: "#39435b", borderSoft: "#2c3448", accent: "#8aadf4", accentHi: "#9bb8fa",
  }),
  darkPreset("plum", "Electric Plum", {
    bg: "#160f1c", panel: "#201628", elevated: "#2a1e34", raised: "#352641", sunken: "#100a15", inputBg: "#1a121f",
    border: "#4b3659", borderSoft: "#3a2a46", accent: "#d5a6ff", accentHi: "#e0b8ff",
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
  lightPreset("citrus", "Citrus Grove", {
    bg: "#fbfaef", panel: "#f1f0d9", elevated: "#fffef8", raised: "#f4f3df", sunken: "#e5e4c9", inputBg: "#fffef8",
    border: "#cfceb0", borderSoft: "#dfdec6", accent: "#526d12", accentHi: "#617d1d",
  }),
  lightPreset("terracotta", "Terracotta", {
    bg: "#fcf7f3", panel: "#f4e9e2", elevated: "#ffffff", raised: "#f7ece6", sunken: "#eadbd2", inputBg: "#ffffff",
    border: "#d5beb1", borderSoft: "#e5d5cc", accent: "#934225", accentHi: "#a34f30",
  }),
  lightPreset("lilac-haze", "Lilac Haze", {
    bg: "#faf7fc", panel: "#f1eaf5", elevated: "#ffffff", raised: "#f3edf7", sunken: "#e5daeb", inputBg: "#ffffff",
    border: "#cfc0d7", borderSoft: "#dfd4e5", accent: "#704187", accentHi: "#805095",
  }),
  lightPreset("paper", "Clean Paper", {
    bg: "#fbfbfa", panel: "#f0f0ed", elevated: "#ffffff", raised: "#f3f3f0", sunken: "#e5e5e0", inputBg: "#ffffff",
    border: "#c9c9c2", borderSoft: "#ddddd7", accent: "#315b89", accentHi: "#3b6796",
  }),
  lightPreset("peach", "Soft Peach", {
    bg: "#fff9f5", panel: "#f7ede6", elevated: "#ffffff", raised: "#f8eee8", sunken: "#ebddd3", inputBg: "#ffffff",
    border: "#d7c3b6", borderSoft: "#e7d8ce", accent: "#7c4328", accentHi: "#8b5033",
  }),
];

export const DEFAULT_THEME: ThemeSpec = PRESET_THEMES.find((theme) => theme.id === "dark")!;

// ---- validation ---------------------------------------------------------------

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type ThemeValidation = { ok: true; theme: ThemeSpec } | { ok: false; error: string };

/** Validate untrusted theme JSON; failures carry the reason (F15 accept). */
export function validateTheme(raw: unknown, opts: { allowPresetIds?: boolean } = {}): ThemeValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: tr("theme.mustBeJsonObject") };
  }
  const t = raw as Partial<ThemeSpec> & { tokens?: Record<string, unknown>; syntax?: Record<string, unknown> };
  if (typeof t.id !== "string" || !ID_RE.test(t.id)) {
    return { ok: false, error: tr("theme.idMustBeLowercaseSlug") };
  }
  if (!opts.allowPresetIds && PRESET_THEMES.some((p) => p.id === t.id)) {
    return { ok: false, error: tr("theme.idReserved", { id: t.id }) };
  }
  if (typeof t.name !== "string" || !t.name.trim() || t.name.length > 40) {
    return { ok: false, error: tr("theme.nameMustBeNonEmpty") };
  }
  if (t.appearance !== "dark" && t.appearance !== "light") {
    return { ok: false, error: tr("theme.appearanceMustBeDarkOrLight") };
  }
  if (typeof t.tokens !== "object" || t.tokens === null) {
    return { ok: false, error: tr("theme.tokensMustBeObject") };
  }
  const tokens = {} as ThemeTokens;
  for (const key of TOKEN_KEYS) {
    const v = t.tokens[key];
    if (v === undefined) return { ok: false, error: tr("theme.tokenMissing", { key }) };
    if (typeof v !== "string" || !HEX_RE.test(v)) {
      return { ok: false, error: tr("theme.tokenMustBeHex", { key }) };
    }
    tokens[key] = v;
  }
  let syntax: ThemeSyntax | undefined;
  if (t.syntax !== undefined) {
    if (typeof t.syntax !== "object" || t.syntax === null) {
      return { ok: false, error: tr("theme.syntaxMustBeObject") };
    }
    syntax = {};
    for (const key of SYNTAX_KEYS) {
      const v = t.syntax[key];
      if (v === undefined) continue;
      if (typeof v !== "string" || !HEX_RE.test(v)) {
        return { ok: false, error: tr("theme.syntaxMustBeHex", { key }) };
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
    return {
      ok: false,
      error: tr("theme.invalidJson", { reason: e instanceof Error ? e.message : String(e) }),
    };
  }
  return validateTheme(raw);
}

// ---- token → CSS variable mapping (pure) --------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function rgbToHsl(hex: string): [number, number, number] {
  const [r8, g8, b8] = hexToRgb(hex);
  const [r, g, b] = [r8 / 255, g8 / 255, b8 / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === r
    ? ((g - b) / delta + (g < b ? 6 : 0)) / 6
    : max === g
      ? ((b - r) / delta + 2) / 6
      : ((r - g) / delta + 4) / 6;
  return [hue, saturation, lightness];
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const hueToRgb = (p: number, q: number, t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channels = saturation === 0
    ? [lightness, lightness, lightness]
    : [hueToRgb(p, q, hue + 1 / 3), hueToRgb(p, q, hue), hueToRgb(p, q, hue - 1 / 3)];
  return `#${channels.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}

function withLightness(source: string, lightness: number, saturationCap = 1): string {
  const [hue, saturation] = rgbToHsl(source);
  return hslToHex(hue, Math.min(saturation, saturationCap), lightness);
}

function relativeLuminance(hex: string): number {
  const channels = hexToRgb(hex).map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function readableInk(background: string): string {
  const darkInk = "#101216";
  const lightInk = "#ffffff";
  return contrastRatio(darkInk, background) >= contrastRatio(lightInk, background) ? darkInk : lightInk;
}

function accessibleColor(source: string, ink: string, start: number, lighten: boolean): string {
  let lightness = start;
  let color = withLightness(source, lightness);
  while (contrastRatio(color, ink) < 4.5 && lightness > 0.02 && lightness < 0.98) {
    lightness += lighten ? 0.01 : -0.01;
    color = withLightness(source, lightness);
  }
  return color;
}

/** Convert a palette's native preset to the requested appearance while keeping
 * its hue identity. Native variants stay byte-for-byte stable; generated
 * variants use role-specific luminance and re-check primary-action contrast. */
export function adaptThemeAppearance(spec: ThemeSpec, appearance: "dark" | "light"): ThemeSpec {
  if (spec.appearance === appearance) return spec;
  const source = spec.tokens;
  const dark = appearance === "dark";
  const accentInk = dark ? "#101216" : "#ffffff";
  const surface = (key: keyof ThemeTokens, darkL: number, lightL: number) =>
    withLightness(source[key], dark ? darkL : lightL, 0.22);
  const ink = (key: keyof ThemeTokens, darkL: number, lightL: number) =>
    withLightness(source[key], dark ? darkL : lightL, 0.14);
  const signal = (key: "green" | "amber" | "red" | "blue" | "purple") =>
    withLightness(source[key], dark ? 0.7 : 0.38);
  const syntax = spec.syntax
    ? Object.fromEntries(Object.entries(spec.syntax).map(([key, color]) => [
        key,
        withLightness(color, dark ? 0.7 : 0.38),
      ])) as ThemeSyntax
    : undefined;
  return {
    ...spec,
    appearance,
    tokens: {
      bg: surface("bg", 0.055, 0.97),
      panel: surface("panel", 0.085, 0.93),
      elevated: surface("elevated", 0.12, 0.99),
      raised: surface("raised", 0.16, 0.95),
      sunken: surface("sunken", 0.035, 0.88),
      inputBg: surface("inputBg", 0.07, 0.99),
      border: surface("border", 0.23, 0.76),
      borderSoft: surface("borderSoft", 0.17, 0.85),
      text: ink("text", 0.94, 0.13),
      textDim: ink("textDim", 0.8, 0.24),
      muted: ink("muted", 0.7, 0.31),
      faint: ink("faint", 0.66, 0.35),
      accent: accessibleColor(source.accent, accentInk, dark ? 0.67 : 0.37, dark),
      accentInk,
      accentHi: accessibleColor(source.accentHi, accentInk, dark ? 0.73 : 0.41, dark),
      green: signal("green"),
      amber: signal("amber"),
      red: signal("red"),
      blue: signal("blue"),
      purple: signal("purple"),
    },
    ...(syntax ? { syntax } : {}),
  };
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

/** Signal foreground adjusted against the real 18% wash on every app surface. */
const signalOnWash = (signal: string, surfaces: string[], lighten: boolean): string => {
  let lightness = rgbToHsl(signal)[2];
  let color = signal;
  const backgrounds = surfaces.map((surface) => blend(signal, surface, 0.18));
  while (backgrounds.some((background) => contrastRatio(color, background) < 4.5)
    && lightness > 0.02 && lightness < 0.98) {
    lightness += lighten ? 0.01 : -0.01;
    color = withLightness(signal, lightness);
  }
  return color;
};

/** Theme-aware ANSI 16-color palette for the terminal: chromatic slots come
 *  from the theme's signal tokens (red/green/amber/blue/purple; cyan blends
 *  green+blue), monochrome slots from the ink/surface roles. Bright variants
 *  shift lightness toward the readable direction for the appearance. */
export function termAnsiPalette(spec: ThemeSpec): string[] {
  const t = spec.tokens;
  const dark = spec.appearance === "dark";
  const bright = (hex: string): string => {
    const [, , lightness] = rgbToHsl(hex);
    return withLightness(hex, Math.max(0.06, Math.min(0.96, lightness + (dark ? 0.09 : -0.07))));
  };
  const cyan = blend(t.green, t.blue, 0.5);
  const black = dark ? blend(t.text, t.sunken, 0.32) : blend(t.text, t.sunken, 0.88);
  const brightBlack = dark ? blend(t.text, t.sunken, 0.5) : blend(t.text, t.sunken, 0.7);
  const white = dark ? t.textDim : blend(t.text, t.sunken, 0.35);
  const brightWhite = dark ? withLightness(t.text, 0.97) : withLightness(t.text, 0.08);
  return [
    black, t.red, t.green, t.amber, t.blue, t.purple, cyan, white,
    brightBlack, bright(t.red), bright(t.green), bright(t.amber), bright(t.blue), bright(t.purple), bright(cyan), brightWhite,
  ];
}

/** Resolve a theme to the CSS custom properties it sets. One place derives
 *  every wash/hairline/rgb variant so custom themes only supply base roles. */
export function themeCssVars(spec: ThemeSpec): Record<string, string> {
  const t = spec.tokens;
  const dark = spec.appearance === "dark";
  const accentRgb = hexToRgb(t.accent).join(", ");
  const ansi = termAnsiPalette(spec);
  const termVars: Record<string, string> = {
    "--term-bg": t.sunken,
    "--term-fg": t.text,
    "--term-cursor": t.accent,
    "--term-sel": rgba(t.accent, dark ? 0.34 : 0.28),
    "--term-find": rgba(t.amber, dark ? 0.4 : 0.45),
    "--term-find-cur": rgba(t.accent, dark ? 0.55 : 0.4),
    "--term-link": t.blue,
  };
  for (let i = 0; i < 16; i++) termVars[`--term-a${i}`] = ansi[i]!;
  const amberRgb = hexToRgb(t.amber).join(", ");
  const surfaces = [t.bg, t.panel, t.elevated, t.raised, t.sunken, t.inputBg];
  return {
    "--bg": t.bg, "--panel": t.panel, "--elevated": t.elevated, "--raised": t.raised,
    "--sunken": t.sunken, "--input-bg": t.inputBg,
    "--border": t.border, "--border-soft": t.borderSoft,
    "--control-border": dark ? t.border : blend(t.text, t.elevated, 0.6),
    "--surface-divider": t.borderSoft,
    "--hair": rgba(t.text, dark ? 0.055 : 0.07),
    "--hair-strong": rgba(t.text, dark ? 0.09 : 0.12),
    "--text": t.text, "--text-dim": t.textDim, "--muted": t.muted, "--faint": t.faint,
    "--accent": t.accent, "--accent-ink": t.accentInk, "--accent-hi": t.accentHi,
    "--accent-wash": rgba(t.accent, dark ? 0.13 : 0.12),
    "--accent-line": rgba(t.accent, dark ? 0.32 : 0.4),
    "--focus-wash": rgba(t.accent, 0.1),
    "--accent-rgb": accentRgb,
    "--green": t.green, "--amber": t.amber,
    "--green-on-wash": signalOnWash(t.green, surfaces, dark),
    "--amber-on-wash": signalOnWash(t.amber, surfaces, dark),
    "--amber-rgb": amberRgb,
    "--red": t.red, "--blue": t.blue, "--purple": t.purple,
    "--red-ink": readableInk(t.red),
    "--surface-overlay": rgba(t.text, dark ? 0.022 : 0.025),
    "--surface-overlay-hover": rgba(t.text, dark ? 0.045 : 0.04),
    "--surface-overlay-strong": rgba(t.text, dark ? 0.09 : 0.08),
    "--green-wash": rgba(t.green, 0.18),
    "--amber-wash": rgba(t.amber, 0.18),
    "--red-wash": rgba(t.red, 0.18),
    "--blue-wash": rgba(t.blue, 0.18),
    "--purple-wash": rgba(t.purple, 0.18),
    "--scrim": dark ? "rgba(9, 8, 7, 0.62)" : "rgba(60, 50, 35, 0.4)",
    "--shadow-lg": dark
      ? "0 40px 90px -24px rgba(0, 0, 0, 0.72), 0 8px 28px -12px rgba(0, 0, 0, 0.6)"
      : "0 40px 90px -24px rgba(60, 45, 25, 0.35), 0 8px 28px -12px rgba(60, 45, 25, 0.25)",
    "--shadow-sm": dark
      ? "0 4px 14px -10px rgba(0, 0, 0, 0.55)"
      : "0 4px 14px -10px rgba(60, 45, 25, 0.28)",
    "--shadow-md": dark
      ? "0 14px 36px -22px rgba(0, 0, 0, 0.66)"
      : "0 14px 36px -22px rgba(60, 45, 25, 0.32)",
    "--inset-hi": dark ? "inset 0 1px 0 rgba(255, 255, 255, 0.045)" : "inset 0 1px 0 rgba(255, 255, 255, 0.6)",
    "--bubble-user-bg": blend(t.accent, t.panel, 0.13),
    "--bubble-user-line": blend(t.accent, t.panel, 0.33),
    "--syntax-kw": spec.syntax?.kw ?? t.purple,
    "--syntax-str": spec.syntax?.str ?? t.green,
    "--syntax-cmt": spec.syntax?.cmt ?? t.faint,
    "--syntax-num": spec.syntax?.num ?? t.amber,
    "--syntax-punc": spec.syntax?.punc ?? t.muted,
    ...termVars,
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

/** Map a persisted palette and appearance mode to one concrete theme. Unknown
 * palette ids (for example a deleted custom theme) fall back to Ember. */
export function resolveTheme(
  paletteId: string,
  appearanceMode: AppearanceMode,
  opts: { systemDark?: boolean; custom?: ThemeSpec[] } = {},
): ThemeSpec {
  const palette = PRESET_THEMES.find((preset) => preset.id === paletteId)
    ?? (opts.custom ?? []).find((theme) => theme.id === paletteId)
    ?? DEFAULT_THEME;
  const appearance = appearanceMode === "system"
    ? (opts.systemDark !== false ? "dark" : "light")
    : appearanceMode;
  return adaptThemeAppearance(palette, appearance);
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
  html.dataset.appearance = spec.appearance;
  html.style.colorScheme = spec.appearance;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", spec.tokens.bg);
  document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
    ?.setAttribute("content", spec.appearance === "dark" ? "black-translucent" : "default");
  window.dispatchEvent(new Event("polyth:theme"));
}

let appliedSetting: { paletteId: string; appearanceMode: AppearanceMode } | null = null;
let systemWatch: MediaQueryList | null = null;

/** Apply persisted palette + mode; System follows OS changes live. */
export function applyThemeSetting(paletteId: string, appearanceMode: AppearanceMode): void {
  if (typeof document === "undefined") return;
  appliedSetting = { paletteId, appearanceMode };
  if (systemWatch === null && typeof matchMedia === "function") {
    systemWatch = matchMedia("(prefers-color-scheme: dark)");
    systemWatch.addEventListener?.("change", () => {
      if (appliedSetting?.appearanceMode === "system") {
        applyThemeSetting(appliedSetting.paletteId, appliedSetting.appearanceMode);
      }
    });
  }
  applyTheme(resolveTheme(paletteId, appearanceMode, {
    systemDark: systemWatch?.matches ?? true,
    custom: loadCustomThemes(),
  }));
}

/** Re-apply whatever setting is active (used to end a hover preview). */
export function reapplyTheme(): void {
  if (appliedSetting !== null) applyThemeSetting(appliedSetting.paletteId, appliedSetting.appearanceMode);
}
