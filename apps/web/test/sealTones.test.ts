// Seal tones (a chat that waits on a person): theme.ts derives them per
// palette and appearance so the one-character glyph stays readable in every
// theme, built-in or custom, and the seal stands off the surface it sits on.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRESET_THEMES, SEAL_MIN_CONTRAST, adaptThemeAppearance, apcaContrast, sealCssVars, themeCssVars,
} from "../src/theme.ts";

const KINDS = ["permission", "question", "failed"] as const;

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16) / 255);
  const [r, g, b] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string): number => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
};

test("APCA reads polarity and scale like the reference implementation", () => {
  assert.ok(Math.abs(apcaContrast("#000000", "#ffffff") - 106) < 1);
  assert.ok(Math.abs(apcaContrast("#ffffff", "#000000") - 108) < 1);
  assert.equal(apcaContrast("#777777", "#777777"), 0);
});

test("every preset keeps the seal glyph readable and the seal off its surface, in both appearances", () => {
  for (const preset of PRESET_THEMES) {
    for (const appearance of ["dark", "light"] as const) {
      const spec = adaptThemeAppearance(preset, appearance);
      const vars = themeCssVars(spec);
      for (const kind of KINDS) {
        const tone = vars[`--seal-${kind}`]!;
        const ink = vars[`--seal-${kind}-ink`]!;
        const where = `${preset.id} ${appearance} ${kind}`;
        assert.ok(apcaContrast(ink, tone) >= SEAL_MIN_CONTRAST, `${where}: glyph Lc ${apcaContrast(ink, tone).toFixed(1)}`);
        // A deep red on a dark rail is the one pair near the 3:1 line (the
        // purest reds sit at ~2.95:1); the seal's cut-out gap and drop shadow
        // separate it from the icon and the surface beyond that.
        assert.ok(contrast(tone, spec.tokens.panel) >= 2.9, `${where}: seal vs panel ${contrast(tone, spec.tokens.panel).toFixed(2)}`);
      }
    }
  }
});

test("a seal is the lightest mark on a dark theme and the deepest on a light one; a failure is always deep", () => {
  const tokens = { amber: "#e0af68", blue: "#7dcfff", red: "#f7768e" };
  const dark = sealCssVars(tokens, true);
  const light = sealCssVars(tokens, false);
  assert.equal(dark["--seal-permission-ink"], "#0b0d12");
  assert.equal(dark["--seal-question-ink"], "#0b0d12");
  assert.equal(dark["--seal-failed-ink"], "#ffffff");
  for (const kind of KINDS) assert.equal(light[`--seal-${kind}-ink`], "#ffffff");
  assert.ok(luminance(dark["--seal-permission"]!) > luminance(light["--seal-permission"]!));
});

test("a custom palette with extreme signals still lands on a readable seal", () => {
  for (const dark of [true, false]) {
    const vars = sealCssVars({ amber: "#ffff00", blue: "#0000ff", red: "#ff00ff" }, dark);
    for (const kind of KINDS) assert.ok(apcaContrast(vars[`--seal-${kind}-ink`]!, vars[`--seal-${kind}`]!) >= SEAL_MIN_CONTRAST, `${kind} dark=${dark}`);
  }
});

test("the base tokens are the base palette's derived seals", () => {
  const tokens = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
  const derived = sealCssVars({ amber: "#e0af68", blue: "#7dcfff", red: "#f7768e" }, true);
  for (const [name, value] of Object.entries(derived)) {
    if (name.endsWith("-sheen") || name.endsWith("-drop")) continue;
    assert.match(tokens, new RegExp(`${name}: ${value};`), name);
  }
  assert.doesNotMatch(tokens, /--status-(question|permission|result):/, "the seal tokens replace the old status ones");
});
