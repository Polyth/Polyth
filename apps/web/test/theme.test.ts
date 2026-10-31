// Themes: schema validation reasons, setting resolution (incl. system
// follow), token → CSS variable mapping, and the custom-theme parser.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCENT_SWATCHES, DEFAULT_THEME, PRESET_THEMES, THEME_STYLES, THEME_STYLE_CHOICES, TOKEN_KEYS, accentRoles, adaptThemeAppearance,
  effectiveThemeStyle, parseCustomThemes, parseThemeJson, resolveTheme, themeCssVars, validateTheme, exportThemeJson,
  themeContrastIssues, termAnsiPalette, type ThemeSpec,
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

function blend(foreground: string, background: string, amount: number): string {
  const fg = foreground.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16));
  const bg = background.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16));
  return `#${fg.map((channel, index) =>
    Math.round(bg[index]! + (channel - bg[index]!) * amount).toString(16).padStart(2, "0")).join("")}`;
}

const validTheme = (): Record<string, unknown> => ({
  id: "my-theme",
  name: "My theme",
  appearance: "dark",
  tokens: { ...PRESET_THEMES[0]!.tokens },
});

test("preset set: built-ins have unique stable ids and valid tokens", () => {
  assert.equal(PRESET_THEMES.length, 34);
  assert.equal(new Set(PRESET_THEMES.map((t) => t.id)).size, PRESET_THEMES.length);
  // Legacy settings values keep resolving
  assert.ok(PRESET_THEMES.some((t) => t.id === "dark" && t.appearance === "dark"));
  assert.ok(PRESET_THEMES.some((t) => t.id === "light" && t.appearance === "light"));
  assert.equal(PRESET_THEMES.filter((t) => t.appearance === "dark").length, 16);
  assert.equal(PRESET_THEMES.filter((t) => t.appearance === "light").length, 18);
  assert.equal(DEFAULT_THEME.id, "liquid-glass");
  assert.equal(DEFAULT_THEME.name, "macOS 27");
  assert.ok(PRESET_THEMES.every((theme) => !/\b(?:dark|light|night|black)\b/i.test(theme.name)));
  for (const preset of PRESET_THEMES) {
    for (const key of TOKEN_KEYS) assert.match(preset.tokens[key], HEX, `${preset.id}.${key}`);
  }
});

test("OLED is a true-black, contrast-validated palette", () => {
  const oled = PRESET_THEMES.find((theme) => theme.id === "oled");
  assert.ok(oled);
  assert.equal(oled.appearance, "dark");
  assert.equal(oled.tokens.bg, "#000000");
  assert.equal(oled.tokens.sunken, "#000000");
  assert.ok(contrast(oled.tokens.text, oled.tokens.bg) >= 7);
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

test("resolveTheme keeps palette identity while mode controls appearance", () => {
  assert.equal(resolveTheme("midnight", "system", { systemDark: true }).appearance, "dark");
  assert.equal(resolveTheme("midnight", "system", { systemDark: false }).appearance, "light");
  assert.equal(resolveTheme("midnight", "light").id, "midnight");
  assert.equal(resolveTheme("midnight", "light").appearance, "light");
  assert.equal(resolveTheme("light", "dark").id, "light");
  assert.equal(resolveTheme("light", "dark").appearance, "dark");
  const custom: ThemeSpec = { ...(PRESET_THEMES[1]!), id: "my-theme", name: "Mine" };
  assert.equal(resolveTheme("my-theme", "light", { custom: [custom] }).name, "Mine");
  assert.equal(resolveTheme("deleted-theme", "dark").id, "liquid-glass"); // default fallback
});

test("generated light and dark variants retain accessible text and primary actions", () => {
  for (const preset of PRESET_THEMES) {
    for (const appearance of ["dark", "light"] as const) {
      const theme = adaptThemeAppearance(preset, appearance);
      assert.equal(theme.id, preset.id);
      assert.equal(theme.name, preset.name);
      assert.equal(theme.appearance, appearance);
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
            `${preset.id}/${appearance}.${token} must meet 4.5:1 on ${surface}`,
          );
        }
      }
      assert.ok(contrast(theme.tokens.accentInk, theme.tokens.accent) >= 4.5);
      assert.ok(contrast(theme.tokens.accentInk, theme.tokens.accentHi) >= 4.5);
    }
  }
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
  assert.equal(light["--accent-wash"], "rgba(181, 77, 0, 0.12)"); // light alpha differs

  const withSyntax: ThemeSpec = { ...PRESET_THEMES[0]!, id: "s", syntax: { kw: "#ff0000" } };
  const vars = themeCssVars(withSyntax);
  assert.equal(vars["--syntax-kw"], "#ff0000");
  assert.equal(vars["--syntax-str"], PRESET_THEMES[0]!.tokens.green); // others keep defaults
});

test("semantic control borders remain recognizable on every theme", () => {
  for (const preset of PRESET_THEMES) {
    for (const appearance of ["dark", "light"] as const) {
      const theme = adaptThemeAppearance(preset, appearance);
      const border = themeCssVars(theme)["--control-border"]!;
      assert.match(border, HEX);
      if (appearance === "light") {
        assert.ok(
          contrast(border, theme.tokens.elevated) >= 3,
          `${preset.id}/${appearance} control border must reach 3:1 on elevated`,
        );
      }
    }
  }
});

test("signal foregrounds meet 4.5:1 on their actual 18% tinted washes", () => {
  for (const preset of PRESET_THEMES) {
    for (const appearance of ["dark", "light"] as const) {
      const theme = adaptThemeAppearance(preset, appearance);
      const vars = themeCssVars(theme);
      const surfaces = [
        theme.tokens.bg, theme.tokens.panel, theme.tokens.elevated,
        theme.tokens.raised, theme.tokens.sunken, theme.tokens.inputBg,
      ];
      for (const signal of ["green", "amber"] as const) {
        const foreground = vars[`--${signal}-on-wash`]!;
        for (const surface of surfaces) {
          const wash = blend(theme.tokens[signal], surface, 0.18);
          const ratio = contrast(foreground, wash);
          assert.ok(ratio >= 4.5, `${preset.id}/${appearance} ${signal} on ${wash} is ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }
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

const ANSI16 = Array.from({ length: 16 }, (_, i) => `#${(i * 15).toString(16).padStart(2, "0")}aa55`);

test("skin ansi override validates, round-trips and maps to terminal CSS vars", () => {
  const res = validateTheme({ ...validTheme(), ansi: ANSI16 });
  assert.ok(res.ok);
  assert.deepEqual(termAnsiPalette(res.theme), ANSI16);
  const vars = themeCssVars(res.theme);
  assert.equal(vars["--term-a5"], ANSI16[5]);
  assert.equal(vars["--term-a15"], ANSI16[15]);
  const again = parseThemeJson(exportThemeJson(res.theme));
  assert.ok(again.ok && again.theme.ansi?.length === 16);
  assert.equal(validateTheme({ ...validTheme(), ansi: ANSI16.slice(1) }).ok, false);
  assert.equal(validateTheme({ ...validTheme(), ansi: [...ANSI16.slice(1), "red"] }).ok, false);
});

test("iconTint is not part of the skin contract: older skin files load and it is dropped", () => {
  // No canonical icon-colour token exists (icons inherit currentColor from
  // the text roles), so a tint would have had no consumer.
  const res = validateTheme({ ...validTheme(), iconTint: "#ff8800" });
  assert.ok(res.ok);
  assert.equal("iconTint" in res.theme, false);
  assert.equal(Object.keys(themeCssVars(res.theme)).some((name) => name.includes("icon")), false);
  assert.equal(exportThemeJson(res.theme).includes("iconTint"), false);
});

test("old themes without ansi/iconTint still parse; adapted variants derive ANSI", () => {
  assert.ok(validateTheme(validTheme()).ok);
  const res = validateTheme({ ...validTheme(), ansi: ANSI16 });
  assert.ok(res.ok);
  const light = adaptThemeAppearance(res.theme, "light");
  assert.equal(light.ansi, undefined);
  assert.notDeepEqual(termAnsiPalette(light), ANSI16);
});

test("themeContrastIssues passes bundled presets and flags a washed-out skin", () => {
  for (const p of PRESET_THEMES) assert.deepEqual(themeContrastIssues(p), [], p.id);
  const bad = { ...PRESET_THEMES[0]!, tokens: { ...PRESET_THEMES[0]!.tokens, text: "#222222" } };
  assert.ok(themeContrastIssues(bad).some((i) => i.pair === "text/bg"));
});

test("Polyth ships both appearances hand-authored, with the Windows 11 style", () => {
  const fluent = PRESET_THEMES.find((theme) => theme.id === "fluent");
  assert.ok(fluent?.counterpart);
  assert.equal(fluent.name, "Polyth");
  assert.equal(fluent.style, "fluent");
  assert.ok(THEME_STYLES.includes("fluent"));
  assert.equal(fluent.appearance, "light");
  // Mica base, content layer, default Windows accent in each appearance.
  assert.equal(fluent.tokens.panel, "#f3f3f3");
  assert.equal(fluent.tokens.accent, "#005fb8");
  const dark = resolveTheme("fluent", "dark");
  assert.equal(dark.appearance, "dark");
  assert.equal(dark.style, "fluent");
  assert.deepEqual(dark.tokens, fluent.counterpart.tokens);
  assert.equal(dark.tokens.panel, "#202020");
  assert.equal(dark.tokens.accent, "#60cdff");
  // The swap is reversible: adapting back yields the native tokens.
  assert.deepEqual(adaptThemeAppearance(dark, "light").tokens, fluent.tokens);
  for (const theme of [fluent, dark]) assert.deepEqual(themeContrastIssues(theme), [], theme.appearance);
});

test("Polyth derived roles use Windows strokes, smoke and elevation", () => {
  const light = themeCssVars(resolveTheme("fluent", "light"));
  const dark = themeCssVars(resolveTheme("fluent", "dark"));
  assert.equal(light["--scrim"], "rgba(0, 0, 0, 0.3)");
  assert.equal(dark["--scrim"], "rgba(0, 0, 0, 0.3)");
  assert.equal(light["--hair"], "rgba(0, 0, 0, 0.0578)");
  assert.equal(dark["--hair"], "rgba(255, 255, 255, 0.0706)");
  assert.equal(light["--surface-overlay-hover"], "rgba(0, 0, 0, 0.0373)");
  assert.match(light["--shadow-md"]!, /^0 8px 16px /);
  assert.match(dark["--shadow-lg"]!, /^0 32px 64px /);
  assert.match(light["--hair-solid"]!, HEX);
  // Quiet Glass themes keep their own derivation.
  assert.equal(themeCssVars(PRESET_THEMES[0]!)["--scrim"], "rgba(9, 8, 7, 0.62)");
});

test("Big Sur ships both appearances hand-authored, with the macOS style", () => {
  const bigSur = PRESET_THEMES.find((theme) => theme.id === "big-sur");
  assert.ok(bigSur?.counterpart);
  assert.equal(bigSur.name, "Big Sur");
  assert.equal(bigSur.style, "macos");
  assert.ok(THEME_STYLES.includes("macos"));
  assert.equal(bigSur.appearance, "light");
  // Text background, sidebar, label ink and the selection blue of the kit.
  assert.equal(bigSur.tokens.bg, "#ffffff");
  assert.equal(bigSur.tokens.panel, "#f4f5f5");
  assert.equal(bigSur.tokens.text, "#262626");
  assert.equal(bigSur.tokens.accent, "#0063e1");
  const dark = resolveTheme("big-sur", "dark");
  assert.equal(dark.appearance, "dark");
  assert.equal(dark.style, "macos");
  assert.deepEqual(dark.tokens, bigSur.counterpart.tokens);
  assert.equal(dark.tokens.bg, "#1e1e1e");
  assert.equal(dark.tokens.text, "#dddddd");
  assert.equal(dark.tokens.accentInk, "#ffffff");
  // The swap is reversible: adapting back yields the native tokens.
  assert.deepEqual(adaptThemeAppearance(dark, "light").tokens, bigSur.tokens);
  for (const theme of [bigSur, dark]) {
    assert.deepEqual(themeContrastIssues(theme), [], theme.appearance);
    // Links take `blue` (linkColor) and must read on the conversation.
    assert.ok(contrast(theme.tokens.blue, theme.tokens.bg) >= 4.5, `${theme.appearance} blue/bg`);
  }
});

test("Big Sur derived roles use AppKit separators, selection fill and kit shadows", () => {
  const light = themeCssVars(resolveTheme("big-sur", "light"));
  const dark = themeCssVars(resolveTheme("big-sur", "dark"));
  assert.equal(light["--hair"], "rgba(0, 0, 0, 0.1)");
  assert.equal(dark["--hair"], "rgba(255, 255, 255, 0.1)");
  // The unemphasized selection of a source list.
  assert.equal(light["--surface-overlay-strong"], "rgba(0, 0, 0, 0.1)");
  assert.equal(dark["--surface-overlay-strong"], "rgba(255, 255, 255, 0.13)");
  assert.equal(light["--shadow-sm"], "0 1px 2px rgba(0, 0, 0, 0.15)");
  assert.equal(light["--shadow-md"], "0 6px 8px rgba(0, 0, 0, 0.15)");
  assert.equal(dark["--shadow-lg"], "0 20px 18px rgba(0, 0, 0, 0.24)");
  assert.equal(light["--inset-hi"], "inset 0 0 0 0 transparent");
  assert.match(dark["--inset-hi"]!, /rgba\(255, 255, 255, 0\.12\)/);
  assert.match(light["--hair-solid"]!, HEX);
  // Fluent keeps its own derivation.
  assert.equal(themeCssVars(resolveTheme("fluent", "light"))["--hair"], "rgba(0, 0, 0, 0.0578)");
});

test("macOS 27, the base theme, ships both appearances of the Liquid Glass style", () => {
  const polyth = PRESET_THEMES.find((theme) => theme.id === "liquid-glass");
  assert.ok(polyth?.counterpart);
  assert.equal(polyth, DEFAULT_THEME);
  assert.equal(polyth.name, "macOS 27");
  assert.equal(polyth.style, "liquid-glass");
  assert.ok(THEME_STYLES.includes("liquid-glass"));
  assert.equal(polyth.appearance, "light");
  // Window background, label ink and the kit's selection highlight.
  assert.equal(polyth.tokens.bg, "#ffffff");
  assert.equal(polyth.tokens.text, "#262626");
  assert.equal(polyth.tokens.accent, "#0069f9");
  const dark = resolveTheme("liquid-glass", "dark");
  assert.equal(dark.appearance, "dark");
  assert.equal(dark.style, "liquid-glass");
  assert.deepEqual(dark.tokens, polyth.counterpart.tokens);
  assert.equal(dark.tokens.bg, "#1e1e1e");
  assert.equal(dark.tokens.accent, "#0069f9");
  // The swap is reversible: adapting back yields the native tokens.
  assert.deepEqual(adaptThemeAppearance(dark, "light").tokens, polyth.tokens);
  for (const theme of [polyth, dark]) {
    assert.deepEqual(themeContrastIssues(theme), [], theme.appearance);
    const t = theme.tokens;
    const surfaces = [t.bg, t.panel, t.elevated, t.raised, t.sunken, t.inputBg];
    // Signals read as text, and links (blue) on every surface.
    for (const signal of ["green", "amber", "red", "blue", "purple"] as const) {
      for (const surface of surfaces) {
        const ratio = contrast(t[signal], surface);
        assert.ok(ratio >= 4.5, `${theme.appearance} ${signal} on ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

test("Liquid Glass derived roles use the kit separators, selection fill and floating shadows", () => {
  const light = themeCssVars(resolveTheme("liquid-glass", "light"));
  const dark = themeCssVars(resolveTheme("liquid-glass", "dark"));
  assert.equal(light["--hair"], "rgba(0, 0, 0, 0.08)");
  assert.equal(dark["--hair"], "rgba(255, 255, 255, 0.08)");
  // The unemphasized selection of a sidebar.
  assert.equal(light["--surface-overlay-strong"], "rgba(0, 0, 0, 0.08)");
  assert.equal(dark["--surface-overlay-strong"], "rgba(255, 255, 255, 0.12)");
  assert.equal(light["--scrim"], "rgba(0, 0, 0, 0.18)");
  // A contact shadow under a wide ambient one at every level.
  for (const level of ["--shadow-sm", "--shadow-md", "--shadow-lg"]) {
    assert.equal(light[level]!.split("), ").length, 2, level);
    assert.notEqual(light[level], dark[level], level);
  }
  assert.match(light["--inset-hi"]!, /rgba\(255, 255, 255, 0\.9\)/);
  assert.match(light["--hair-solid"]!, HEX);
  // Big Sur keeps its own derivation.
  assert.equal(themeCssVars(resolveTheme("big-sur", "light"))["--hair"], "rgba(0, 0, 0, 0.1)");
});

test("skin style and counterpart validate, round-trip, and degrade safely", () => {
  const counterpart = { tokens: { ...PRESET_THEMES.find((t) => t.id === "light")!.tokens } };
  const res = validateTheme({ ...validTheme(), style: "fluent", counterpart });
  assert.ok(res.ok);
  assert.equal(res.theme.style, "fluent");
  assert.deepEqual(res.theme.counterpart, counterpart);
  const again = parseThemeJson(exportThemeJson(res.theme));
  assert.ok(again.ok && again.theme.style === "fluent" && again.theme.counterpart !== undefined);
  assert.deepEqual(adaptThemeAppearance(res.theme, "light").tokens, counterpart.tokens);
  const macos = validateTheme({ ...validTheme(), style: "macos" });
  assert.ok(macos.ok && macos.theme.style === "macos");
  // A style this build does not know keeps the palette without a style.
  const liquid = validateTheme({ ...validTheme(), style: "liquid-glass" });
  assert.ok(liquid.ok && liquid.theme.style === "liquid-glass");
  const future = validateTheme({ ...validTheme(), style: "aqua" });
  assert.ok(future.ok && future.theme.style === undefined);
  const broken = validateTheme({ ...validTheme(), counterpart: { tokens: { bg: "#000000" } } });
  assert.ok(!broken.ok && /tokens\.panel \(counterpart\) is missing/.test(broken.error));
  assert.equal(validateTheme({ ...validTheme(), counterpart: "dark" }).ok, false);
});

test("style and colours are independent: any palette draws in any style", () => {
  const midnight = PRESET_THEMES.find((theme) => theme.id === "midnight")!;
  // `auto` draws a palette in the style it was authored for (old records).
  assert.equal(resolveTheme("fluent", "light").style, "fluent");
  assert.equal(resolveTheme("midnight", "dark").style, undefined);
  assert.equal(effectiveThemeStyle(midnight, "auto"), "classic");
  assert.equal(effectiveThemeStyle(DEFAULT_THEME, "auto"), "liquid-glass");
  assert.equal(effectiveThemeStyle(DEFAULT_THEME, "fluent"), "fluent");
  // An explicit style draws any palette in it and keeps the palette's colours.
  const glassMidnight = resolveTheme("midnight", "dark", { style: "liquid-glass" });
  assert.equal(glassMidnight.style, "liquid-glass");
  assert.equal(glassMidnight.id, "midnight");
  assert.deepEqual(glassMidnight.tokens, midnight.tokens);
  assert.equal(themeCssVars(glassMidnight)["--hair"], "rgba(255, 255, 255, 0.08)");
  const bigSurPolyth = resolveTheme("fluent", "dark", { style: "macos" });
  assert.equal(bigSurPolyth.style, "macos");
  assert.equal(bigSurPolyth.tokens.panel, "#202020", "Polyth's own dark counterpart, drawn as Big Sur");
  // Classic drops the recipe from a styled palette.
  const classic = resolveTheme("liquid-glass", "light", { style: "classic" });
  assert.equal(classic.style, undefined);
  assert.deepEqual(classic.tokens, DEFAULT_THEME.tokens);
  assert.deepEqual([...THEME_STYLE_CHOICES], ["liquid-glass", "fluent", "macos", "classic"]);
});

test("an accent holds the primary-action contract for every swatch, style, appearance and custom colour", () => {
  const extremes = ["#ffffff", "#000000", "#777777", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#00ffff", "#abc"];
  for (const style of THEME_STYLE_CHOICES) {
    const sources = [...ACCENT_SWATCHES[style].map((swatch) => swatch.source), ...extremes];
    assert.equal(new Set(ACCENT_SWATCHES[style].map((swatch) => swatch.id)).size, ACCENT_SWATCHES[style].length);
    for (const source of sources) {
      for (const appearance of ["light", "dark"] as const) {
        const roles = accentRoles(source, appearance, style);
        assert.match(roles.accent, HEX);
        assert.match(roles.accentHi, HEX);
        const label = `${style} ${appearance} ${source}`;
        assert.ok(contrast(roles.accentInk, roles.accent) >= 4.5, `${label}: ink over accent ${contrast(roles.accentInk, roles.accent).toFixed(2)}`);
        assert.ok(contrast(roles.accentInk, roles.accentHi) >= 4.5, `${label}: ink over accent-hi ${contrast(roles.accentInk, roles.accentHi).toFixed(2)}`);
        // Light accents are white-ink fills, so they also read as text on white.
        if (appearance === "light") assert.equal(roles.accentInk, "#ffffff", label);
      }
    }
  }
  // The macOS styles keep white ink in dark while the colour survives (blue,
  // purple, graphite) and lift a light colour (yellow) under dark ink instead
  // of turning it brown; Fluent always lifts under black, as Windows does.
  for (const style of ["liquid-glass", "macos"] as const) {
    assert.equal(accentRoles("#007aff", "dark", style).accentInk, "#ffffff");
    assert.equal(accentRoles("#a550a7", "dark", style).accentInk, "#ffffff");
    assert.equal(accentRoles("#8c8c8c", "dark", style).accentInk, "#ffffff");
    assert.notEqual(accentRoles("#ffc600", "dark", style).accentInk, "#ffffff");
  }
  assert.equal(accentRoles("#0078d4", "dark", "fluent").accentInk, "#000000");
  // A source that already holds 4.5:1 is drawn as picked.
  assert.equal(accentRoles("#0069f9", "light", "liquid-glass").accent, "#0069f9");
});

test("an accent recolours the resolved theme in both appearances and survives export", () => {
  const base = resolveTheme("liquid-glass", "light", { style: "liquid-glass" });
  const purple = resolveTheme("liquid-glass", "light", { style: "liquid-glass", accent: "#a550a7" });
  assert.notEqual(purple.tokens.accent, base.tokens.accent);
  assert.notEqual(purple.counterpart!.tokens.accent, base.counterpart!.tokens.accent);
  assert.deepEqual(purple.counterpart!.tokens, { ...base.counterpart!.tokens, ...accentRoles("#a550a7", "dark", "liquid-glass") });
  // Everything but the accent roles is the scheme's own.
  for (const key of TOKEN_KEYS.filter((key) => !key.startsWith("accent"))) assert.equal(purple.tokens[key], base.tokens[key], key);
  // Derived roles follow the accent.
  assert.equal(themeCssVars(purple)["--accent-rgb"], purple.tokens.accent.slice(1).match(/../g)!.map((pair) => Number.parseInt(pair, 16)).join(", "));
  // A classic palette without a counterpart takes it through adaptation.
  const solar = resolveTheme("solar", "dark", { accent: "#e5484d" });
  assert.equal(solar.tokens.accentInk, "#101216");
  assert.equal(solar.counterpart, undefined);
  // Empty keeps the scheme's accent.
  assert.deepEqual(resolveTheme("liquid-glass", "light", { accent: "" }), resolveTheme("liquid-glass", "light"));
  const skin = parseThemeJson(exportThemeJson(purple, { id: "my-purple" }));
  assert.ok(skin.ok);
  assert.equal(skin.theme.style, "liquid-glass");
  assert.equal(skin.theme.tokens.accent, purple.tokens.accent);
  assert.deepEqual(themeContrastIssues(skin.theme).filter((issue) => issue.pair.startsWith("accentInk")), []);
});
