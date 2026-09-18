import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND_ID,
  backgroundCssImage,
  backgroundSystemBarColor,
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

test("workspace presets expose light/dark system-bar fallbacks", () => {
  const paper = parseBackgroundState(JSON.stringify({ id: "paper-prism" }));
  assert.equal(backgroundSystemBarColor(paper, "light"), "#e3eef1");
  assert.equal(backgroundSystemBarColor(paper, "dark"), "#43595f");
  assert.equal(backgroundSystemBarColor(parseBackgroundState(JSON.stringify({ id: "none" })), "light"), null);
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
  const [app, pages, picker, styles, theme, index] = await Promise.all([
    read("../src/App.tsx"),
    read("../src/components/settings/pages.tsx"),
    read("../src/components/BackgroundPicker.tsx"),
    read("../src/styles.css"),
    read("../src/theme.ts"),
    read("../src/index.html"),
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
  assert.match(
    styles,
    /html\[data-background\]:not\(\[data-background="none"\]\)\s*\{[^}]*background-image:[\s\S]*?var\(--app-background-image\)/s,
    "the selected background is rooted at the viewport so it can paint behind the phone safe area",
  );
  assert.match(
    styles,
    /html\[data-background\]:not\(\[data-background="none"\]\) body:not\(\.desktop-app\)\s*\{[^}]*background-image:[\s\S]*?var\(--app-background-image\)[^}]*background-size:\s*cover;/s,
    "the browser document canvas paints the selected background through any bottom PWA slack",
  );
  assert.match(
    styles,
    /html\[data-background\]:not\(\[data-background="none"\]\) \.app\s*\{[^}]*background-color:\s*transparent;[^}]*background-image:\s*none;/s,
    "the app surface does not cover the document-owned workspace background",
  );
  assert.match(
    styles,
    /html, body, #root\s*\{[^}]*min-height:\s*100vh;[^}]*min-height:\s*100dvh;/s,
    "the root chain cannot end above the dynamic viewport",
  );
  assert.match(
    styles,
    /\.stage-new\s*\{[^}]*background:\s*transparent;/s,
    "New Chat must not cover the selected workspace background with an opaque stage",
  );
  assert.match(index, /apple-mobile-web-app-status-bar-style" content="black-translucent"/,
    "the initial standalone iOS shell is edge-to-edge");
  assert.match(index, /polyth\.background\.v1/,
    "the installed web app seeds its system-owned status strip from the saved workspace background before first paint");
  assert.match(index, /--app-system-bar-color/,
    "the initial PWA paint publishes the workspace tint to the document canvas");
  for (const preset of BACKGROUND_PRESETS) {
    if (!preset.systemBar) continue;
    assert.match(index, new RegExp(preset.systemBar.dark.replace("#", "#")));
    assert.match(index, new RegExp(preset.systemBar.light.replace("#", "#")));
  }
  assert.match(theme, /apple-mobile-web-app-status-bar-style[^;]+[\s\S]*?setAttribute\("content", "black-translucent"\)/,
    "light-theme changes must not restore an opaque iOS status-bar band");
  assert.doesNotMatch(theme, /apple-mobile-web-app-status-bar-style[^;]+[\s\S]*?\?\s*"black-translucent"\s*:\s*"default"/,
    "status-bar translucency must not depend on dark appearance");
  assert.match(styles, /backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)\s*saturate\(var\(--material-glass-saturation\)\)/);
  assert.match(await read("../src/backgrounds.ts"), /--app-system-bar-color[\s\S]*?meta\[name="theme-color"\]/,
    "runtime background changes keep both document-canvas tint and browser-owned chrome in sync");
  assert.doesNotMatch(styles, /prefers-reduced-motion:\s*no-preference[\s\S]{0,1200}data-glass/);
});
