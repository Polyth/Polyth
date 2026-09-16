import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND_ID,
  backgroundCssImage,
  parseBackgroundState,
  validateBackgroundFile,
} from "../src/backgrounds.ts";

test("background presets are unique and malformed preferences fall back safely", () => {
  assert.ok(BACKGROUND_PRESETS.length >= 5);
  assert.equal(new Set(BACKGROUND_PRESETS.map(({ id }) => id)).size, BACKGROUND_PRESETS.length);
  assert.equal(parseBackgroundState(null).id, DEFAULT_BACKGROUND_ID);
  assert.equal(parseBackgroundState(JSON.stringify({ id: "unknown" })).id, DEFAULT_BACKGROUND_ID);
  assert.equal(parseBackgroundState(JSON.stringify({ id: "none" })).id, "none");
  assert.equal(parseBackgroundState(JSON.stringify({ id: "custom", customImage: "javascript:alert(1)" })).id, DEFAULT_BACKGROUND_ID);
});

test("custom backgrounds accept bounded raster data only", () => {
  const image = "data:image/png;base64,aGVsbG8=";
  const parsed = parseBackgroundState(JSON.stringify({ id: "custom", customImage: image }));
  assert.equal(parsed.id, "custom");
  assert.equal(backgroundCssImage(parsed), `url(${JSON.stringify(image)})`);
  assert.equal(validateBackgroundFile({ type: "image/webp", size: 1024 }), null);
  assert.match(validateBackgroundFile({ type: "image/svg+xml", size: 1024 }) ?? "", /PNG/);
  assert.match(validateBackgroundFile({ type: "image/png", size: 3 * 1024 * 1024 }) ?? "", /2 MB/);
});

test("background and glass controls are wired into Appearance and the held-Shift corner", async () => {
  const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
  const [app, pages, picker, styles] = await Promise.all([
    read("../src/App.tsx"),
    read("../src/components/settings/pages.tsx"),
    read("../src/components/BackgroundPicker.tsx"),
    read("../src/styles.css"),
  ]);
  assert.match(app, /<BackgroundQuickPicker \/>/);
  assert.match(pages, /data-settings-item="appearance\.background"[\s\S]*<BackgroundPicker \/>/);
  assert.match(pages, /itemId="appearance\.glass"[\s\S]*ui\.glassEffect/);
  assert.match(pages, /<Popover[\s\S]*className="theme-picker-pop"/);
  assert.match(pages, /autoFocus=\{!phone\}/);
  assert.doesNotMatch(styles, /theme-picker-pop \{[\s\S]{0,200}inset:\s*auto 8px/);
  assert.match(picker, /useShiftArmed\(\)/);
  assert.match(styles, /\.background-quick-trigger\s*\{[^}]*position:\s*fixed;[^}]*inset-inline-end:/s);
  assert.doesNotMatch(styles, /\.workspace > \.main\s*\{[^}]*background:/s);
  assert.match(styles, /backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)\s*saturate\(var\(--material-glass-saturation\)\)/);
  assert.doesNotMatch(styles, /prefers-reduced-motion:\s*no-preference[\s\S]{0,1200}data-glass/);
});
