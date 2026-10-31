// The chat's plateless chrome (activity blocks, the agent status and edited
// files above the composer) reads its quiet inks straight off the wallpaper
// wash. Every preset theme, with its own accent or any platform accent of any
// style, on every preset wallpaper keeps those inks at 4.5:1 against the
// darkest or lightest point the wash can put under them: each linear stop and
// each radial bloom at its peak, under 76% of --bg. Whether a wallpaper
// fights the appearance comes from its measured tone, and the shares for one
// that does must hold over any image at all, down to pure black or white.
// The shares are read from tokens.css and styles.css, so retuning them, or
// adding a theme, an accent or a wallpaper, re-runs the whole matrix.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCENT_SWATCHES, PRESET_THEMES, THEME_STYLE_CHOICES, adaptThemeAppearance, themeCssVars, withAccent, withThemeStyle } from "../src/theme.ts";
import { BACKGROUND_PRESETS, BACKGROUND_TONE_DARK_CEILING, BACKGROUND_TONE_LIGHT_FLOOR, backgroundPresetArt, classifyBackgroundTone } from "../src/backgrounds.ts";

const root = resolve(import.meta.dirname, "..");
const tokens = readFileSync(resolve(root, "src/tokens.css"), "utf8");
const styles = readFileSync(resolve(root, "src/styles.css"), "utf8");
const gitStyles = readFileSync(resolve(root, "../../packages/git/widgets/styles.css"), "utf8");

type Rgb = [number, number, number];
const SHARES = ["dim", "quiet", "faint", "hue", "accent"] as const;
type Shares = Record<(typeof SHARES)[number], number>;

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}
/** The shares a rule sets; the cascade below layers them like the browser. */
function shares(body: string): Partial<Shares> {
  const out: Partial<Shares> = {};
  for (const name of SHARES) {
    const match = body.match(new RegExp(`--chat-wash-${name}: (\\d+(?:\\.\\d+)?)%;`));
    if (match) out[name] = Number(match[1]) / 100;
  }
  return out;
}
// Cascade order as in styles.css: tokens, any wallpaper, light, a light
// wallpaper under a light theme, any wallpaper under a dark theme, then a
// wallpaper that fights the appearance.
const DEFAULTS: Shares = { dim: 0, quiet: 0, faint: 0, hue: 0, accent: 0, ...shares(tokens) };
const WALLPAPER = shares(block(styles, 'html[data-background]:not([data-background="none"])'));
const LIGHT = shares(block(styles, "html.light"));
const LIGHT_SAME = shares(block(styles, 'html.light[data-background-tone="light"]'));
const DARK_WALLPAPER = shares(block(styles, 'html:not(.light)[data-background]:not([data-background="none"])'));
const LIGHT_OPPOSING = shares(block(styles, 'html.light[data-background]:not([data-background="none"]):not([data-background-tone="light"])'));
const DARK_OPPOSING = shares(block(styles, 'html:not(.light)[data-background]:not([data-background="none"]):not([data-background-tone="dark"])'));
function sharesFor(appearance: "light" | "dark", wallpaper: "none" | "same" | "opposing"): Shares {
  const layers = [DEFAULTS, wallpaper === "none" ? {} : WALLPAPER, appearance === "light" ? LIGHT : {}];
  if (appearance === "light" && wallpaper === "same") layers.push(LIGHT_SAME);
  if (appearance === "dark" && wallpaper !== "none") layers.push(DARK_WALLPAPER);
  if (wallpaper === "opposing") layers.push(appearance === "light" ? LIGHT_OPPOSING : DARK_OPPOSING);
  return Object.assign({}, ...layers) as Shares;
}

const hex = (value: string): Rgb => value.slice(1).match(/../g)!.map((part) => Number.parseInt(part, 16)) as Rgb;
const mix = (a: Rgb, b: Rgb, share: number): Rgb => a.map((v, i) => v * share + b[i]! * (1 - share)) as Rgb;
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** An SVG wallpaper (Dusk Ridge) names its own colours: opaque gradient stops
 *  and layer fills are part of its base, a translucent stop is a glow's peak. */
function svgPaint(image: string): { stops: Rgb[]; blooms: Array<{ rgb: Rgb; alpha: number }> } | null {
  const data = image.match(/^url\("data:image\/svg\+xml,(.*)"\)$/s)?.[1];
  if (!data) return null;
  const stops: Rgb[] = [];
  const blooms: Array<{ rgb: Rgb; alpha: number }> = [];
  for (const m of decodeURIComponent(data).matchAll(/(?:stop-color|fill)='(#[0-9a-f]{6})'(?: stop-opacity='([\d.]+)')?/gi)) {
    const alpha = m[2] === undefined ? 1 : Number(m[2]);
    if (alpha >= 1) stops.push(hex(m[1]!));
    else if (alpha > 0) blooms.push({ rgb: hex(m[1]!), alpha });
  }
  return { stops, blooms };
}
/** Every colour a preset wallpaper reaches: its linear stops and each radial bloom's peak over them. */
function wallpaperStops(image: string): Rgb[] {
  const svg = svgPaint(image);
  if (svg) return svg.stops;
  return [...image.matchAll(/linear-gradient\([^)]*?((?:#[0-9a-f]{6}[^,)]*,?\s*)+)\)/gi)]
    .flatMap((match) => [...match[1]!.matchAll(/#[0-9a-f]{6}/gi)].map((stop) => hex(stop[0])));
}
function wallpaperColours(image: string): Rgb[] {
  if (image === "none") return [];
  const stops = wallpaperStops(image);
  const blooms = svgPaint(image)?.blooms ?? [...image.matchAll(/rgba\((\d+), (\d+), (\d+), (\.\d+|\d(?:\.\d+)?)\) 0,/g)]
    .map((m) => ({ rgb: [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb, alpha: Number(m[4]) }));
  assert.ok(stops.length > 0, "a preset wallpaper has a linear base");
  return [...stops, ...blooms.flatMap(({ rgb, alpha }) => stops.map((stop) => mix(rgb, stop, alpha)))];
}

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
/** The scheme's own accent plus every platform accent, as each style derives it. */
const ACCENTS: ReadonlyArray<{ label: string; style: (typeof THEME_STYLE_CHOICES)[number] | null; source: string | null }> = [
  { label: "own accent", style: null, source: null },
  ...THEME_STYLE_CHOICES.flatMap((style) => ACCENT_SWATCHES[style].map((swatch) => ({ label: `${style} ${swatch.id}`, style, source: swatch.source }))),
];

/** Check one resolved theme's plateless inks over a set of wallpaper colours. */
function checkInks(appearance: "light" | "dark", vars: Record<string, string>, colours: readonly Rgb[], fights: boolean, wallpaper: boolean): string[] {
  const v = (name: string): Rgb => hex(vars[name]!);
  const s = sharesFor(appearance, !wallpaper ? "none" : fights ? "opposing" : "same");
  const text = v("--text");
  const anchor = fights ? mix(text, appearance === "light" ? BLACK : WHITE, 0.55) : text;
  const ink = (token: string, share: number) => mix(anchor, v(token), share);
  const muted = ink("--muted", s.quiet);
  const red = ink("--red", s.hue);
  const green = ink("--green", s.hue);
  const inks: Array<[string, Rgb, number]> = [
    ["--text-dim", ink("--text-dim", s.dim), 4.5],
    ["--muted", muted, 4.5],
    ["--faint", ink("--faint", s.faint), 4.5],
    ["--green", green, 4.5],
    ["--red", red, 4.5],
    // Diff counts on the edited-files line lean toward --muted.
    ["files green", mix(green, muted, 0.8), 4.5],
    ["files red", mix(red, muted, 0.8), 4.5],
    ["--chat-ink-accent", ink("--accent-text", s.accent), 4.5],
    // The live step dot is one glyph: 3:1.
    ["started step mark", mix(v("--accent-text"), anchor, 0.66), 3],
  ];
  const bg = v("--bg");
  const backdrops = colours.length ? colours.map((colour) => mix(bg, colour, 0.76)) : [bg];
  const failures: string[] = [];
  for (const [name, colour, floor] of inks) {
    const worst = Math.min(...backdrops.map((backdrop) => contrast(colour, backdrop)));
    if (worst < floor) failures.push(`${name} falls to ${worst.toFixed(2)}:1`);
  }
  return failures;
}

function resolvedVariants(preset: (typeof PRESET_THEMES)[number], appearance: "light" | "dark") {
  const adapted = adaptThemeAppearance(preset, appearance);
  return ACCENTS.map((accent) => ({
    label: accent.label,
    vars: themeCssVars(accent.source && accent.style ? withAccent(withThemeStyle(adapted, accent.style), accent.source) : adapted),
  }));
}

for (const preset of PRESET_THEMES) {
  for (const appearance of ["light", "dark"] as const) {
    const variants = resolvedVariants(preset, appearance);
    for (const wallpaper of BACKGROUND_PRESETS) {
      // A theme-following wallpaper paints its variant for this appearance.
      const art = backgroundPresetArt(wallpaper.id, appearance) ?? wallpaper;
      const colours = wallpaperColours(art.image);
      const fights = art.tone !== null && art.tone !== appearance;
      test(`${preset.id} ${appearance} on ${wallpaper.id}: plateless chat inks stay readable with every accent`, () => {
        const failures = variants.flatMap(({ label, vars }) =>
          checkInks(appearance, vars, colours, fights, art.image !== "none").map((failure) => `${label}: ${failure}`));
        assert.deepEqual(failures, []);
      });
    }
    // A custom image is unread at first and may be mixed or mis-measured: the
    // shares for a wallpaper that fights the appearance must hold over anything.
    test(`${preset.id} ${appearance} on any image that fights it: inks hold even over pure black and white`, () => {
      const failures = variants.flatMap(({ label, vars }) =>
        checkInks(appearance, vars, [BLACK, WHITE], true, true).map((failure) => `${label}: ${failure}`));
      assert.deepEqual(failures, []);
    });
  }
}

test("each preset wallpaper's tone matches its colours", () => {
  for (const wallpaper of BACKGROUND_PRESETS) {
    for (const appearance of ["light", "dark"] as const) {
      const art = backgroundPresetArt(wallpaper.id, appearance) ?? wallpaper;
      if (art.image === "none") { assert.equal(art.tone, null); continue; }
      const stops = wallpaperStops(art.image).map(luminance);
      // Measured on rendered frames; the linear base fills most of the frame,
      // so its stops must sit inside the tone band.
      if (art.tone === "light") assert.ok(Math.min(...stops) >= BACKGROUND_TONE_LIGHT_FLOOR, `${wallpaper.id} ${appearance} base is light`);
      if (art.tone === "dark") assert.ok(Math.max(...stops) <= BACKGROUND_TONE_DARK_CEILING, `${wallpaper.id} ${appearance} base is dark`);
    }
  }
});

test("a sampled image's tone uses the preset thresholds", () => {
  assert.equal(classifyBackgroundTone([]), null);
  assert.equal(classifyBackgroundTone(Array.from({ length: 100 }, (_, i) => 0.45 + i / 400)), "light");
  assert.equal(classifyBackgroundTone(Array.from({ length: 100 }, (_, i) => i / 500)), "dark");
  assert.equal(classifyBackgroundTone(Array.from({ length: 100 }, (_, i) => i / 100)), "mixed");
});

test("the wash moves the inks only inside the transcript and the lines above the composer", () => {
  const scope = block(styles, ":is(.timeline, .conversation-composer-dock > :not(.composer))");
  for (const [token, ink] of [["--text-dim", "dim"], ["--muted", "muted"], ["--faint", "faint"], ["--green", "green"], ["--red", "red"]]) {
    assert.match(scope, new RegExp(`${token}: var\\(--chat-ink-${ink}\\);`));
  }
  assert.match(gitStyles, /\.pending-changes-review \{ color: var\(--chat-ink-accent, var\(--accent\)\); \}/);
});
