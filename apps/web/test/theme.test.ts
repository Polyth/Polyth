// F15 themes: schema validation reasons, setting resolution (incl. system
// follow), token → CSS variable mapping, and the custom-theme parser.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESET_THEMES, TOKEN_KEYS, parseCustomThemes, parseThemeJson, resolveTheme,
  themeCssVars, validateTheme, type ThemeSpec,
} from "../src/theme.ts";

const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16) / 255);
  const [r, g, b] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

const validTheme = (): Record<string, unknown> => ({
  id: "my-theme",
  name: "My theme",
  appearance: "dark",
  tokens: { ...PRESET_THEMES[0]!.tokens },
});

test("preset set: six themes, unique stable ids, both appearances, valid tokens", () => {
  assert.equal(PRESET_THEMES.length, 6);
  assert.equal(new Set(PRESET_THEMES.map((t) => t.id)).size, 6);
  // pre-F15 settings values keep resolving
  assert.ok(PRESET_THEMES.some((t) => t.id === "dark" && t.appearance === "dark"));
  assert.ok(PRESET_THEMES.some((t) => t.id === "light" && t.appearance === "light"));
  assert.equal(PRESET_THEMES.filter((t) => t.appearance === "dark").length, 3);
  for (const preset of PRESET_THEMES) {
    for (const key of TOKEN_KEYS) assert.match(preset.tokens[key], HEX, `${preset.id}.${key}`);
  }
});

test("every bundled theme's primary-action pair meets 4.5:1 at both gradient endpoints", () => {
  // Send (and every accent-ink-on-accent control) paints text over the
  // accent-hi → accent gradient, so both endpoints must clear 4.5:1.
  for (const t of PRESET_THEMES) {
    const overAccent = contrast(t.tokens.accentInk, t.tokens.accent);
    const overHi = contrast(t.tokens.accentInk, t.tokens.accentHi);
    assert.ok(overAccent >= 4.5, `${t.id}: accent-ink over accent is ${overAccent.toFixed(2)} < 4.5`);
    assert.ok(overHi >= 4.5, `${t.id}: accent-ink over accent-hi is ${overHi.toFixed(2)} < 4.5`);
  }
});

test("preset secondary text tokens meet readable contrast on app surfaces", () => {
  for (const theme of PRESET_THEMES) {
    const surfaces = [
      theme.tokens.bg,
      theme.tokens.panel,
      theme.tokens.elevated,
      theme.tokens.raised,
      theme.tokens.sunken,
      theme.tokens.inputBg,
    ];
    for (const token of ["muted", "faint"] as const) {
      for (const surface of surfaces) {
        assert.ok(
          contrast(theme.tokens[token], surface) >= 4.5,
          `${theme.id}.${token} must meet 4.5:1 on ${surface}`,
        );
      }
    }
  }
});

test("validateTheme accepts a complete theme and reports precise reasons", () => {
  const ok = validateTheme(validTheme());
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.theme.id, "my-theme");

  const cases: Array<[unknown, RegExp]> = [
    ["nope", /must be a JSON object/],
    [{ ...validTheme(), id: "Bad Id!" }, /lowercase slug/],
    [{ ...validTheme(), id: "dark" }, /reserved by a built-in/],
    [{ ...validTheme(), name: "" }, /name must be/],
    [{ ...validTheme(), appearance: "sepia" }, /appearance must be/],
    [{ ...validTheme(), tokens: null }, /tokens must be an object/],
    [{ ...validTheme(), syntax: { kw: "purple" } }, /syntax\.kw must be a hex color/],
  ];
  for (const [raw, re] of cases) {
    const res = validateTheme(raw);
    assert.ok(!res.ok);
    assert.match(!res.ok ? res.error : "", re);
  }

  const missing = validTheme();
  delete (missing.tokens as Record<string, unknown>).accent;
  const res = validateTheme(missing);
  assert.ok(!res.ok && /tokens\.accent is missing/.test(res.error));

  const badHex = validTheme();
  (badHex.tokens as Record<string, unknown>).bg = "red";
  const res2 = validateTheme(badHex);
  assert.ok(!res2.ok && /tokens\.bg must be a hex color/.test(res2.error));
});

test("parseThemeJson reports the JSON parse reason", () => {
  const res = parseThemeJson("{ not json");
  assert.ok(!res.ok);
  assert.match(!res.ok ? res.error : "", /^invalid JSON: /);
});

test("resolveTheme: system follows the OS, ids resolve, unknown falls back", () => {
  assert.equal(resolveTheme("system", { systemDark: true }).appearance, "dark");
  assert.equal(resolveTheme("system", { systemDark: false }).appearance, "light");
  assert.equal(resolveTheme("midnight").id, "midnight");
  assert.equal(resolveTheme("light").id, "light");
  const custom: ThemeSpec = { ...(PRESET_THEMES[1]!), id: "my-theme", name: "Mine" };
  assert.equal(resolveTheme("my-theme", { custom: [custom] }).name, "Mine");
  assert.equal(resolveTheme("deleted-theme").id, "dark"); // default fallback
});

test("themeCssVars maps roles, derives washes/rgb, and honors syntax overrides", () => {
  const dark = themeCssVars(PRESET_THEMES[0]!);
  assert.equal(dark["--bg"], "#121110");
  assert.equal(dark["--accent-rgb"], "244, 155, 91");
  assert.equal(dark["--accent-wash"], "rgba(244, 155, 91, 0.13)");
  assert.match(dark["--hair"]!, /^rgba\(240, 238, 232, 0.055\)$/);
  // syntax defaults derive from signal tokens
  assert.equal(dark["--syntax-kw"], PRESET_THEMES[0]!.tokens.purple);
  assert.equal(dark["--syntax-str"], PRESET_THEMES[0]!.tokens.green);
  // user bubble derives from accent over panel (a hex, not the raw accent)
  assert.match(dark["--bubble-user-bg"]!, HEX);
  assert.notEqual(dark["--bubble-user-bg"], PRESET_THEMES[0]!.tokens.accent);

  const light = themeCssVars(PRESET_THEMES.find((t) => t.id === "light")!);
  assert.equal(light["--accent-wash"], "rgba(217, 130, 43, 0.12)"); // light alpha differs

  const withSyntax: ThemeSpec = { ...PRESET_THEMES[0]!, id: "s", syntax: { kw: "#ff0000" } };
  const vars = themeCssVars(withSyntax);
  assert.equal(vars["--syntax-kw"], "#ff0000");
  assert.equal(vars["--syntax-str"], PRESET_THEMES[0]!.tokens.green); // others keep defaults
});

test("parseCustomThemes drops invalid entries, dedupes ids, survives garbage", () => {
  const good = validTheme();
  const dupe = { ...validTheme(), name: "Duplicate" };
  const bad = { ...validTheme(), id: "other", tokens: { bg: "#000" } };
  const list = parseCustomThemes(JSON.stringify([good, dupe, bad]));
  assert.equal(list.length, 1);
  assert.equal(list[0]!.name, "My theme");
  assert.deepEqual(parseCustomThemes(null), []);
  assert.deepEqual(parseCustomThemes("not json"), []);
  assert.deepEqual(parseCustomThemes(JSON.stringify({ theme: good })), []);
});
