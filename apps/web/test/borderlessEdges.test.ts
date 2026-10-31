// Borderless appearance (the default) makes every border colour transparent,
// but contours are not borders: every glass surface and shell control keeps
// the theme's one `--contour`, which each style recipe sets to its own stroke.
// Three things must hold for those edges:
//   1. A surface whose own glass paints under the border (the CSS default,
//      border-box) composites a translucent contour over the bright glass, so
//      the same token renders as a lighter hairline than the rail's edge over
//      the page.
//   2. The shell's two chrome columns must keep the same frame: the left rail
//      and the package rail both draw their block edges and their
//      workspace-facing seam, with or without an open package window.
//   3. No style recipe blanks a contour the shared rules keep, and none draws
//      its own stroke in place of the contour.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (name: string): string => readFileSync(resolve(import.meta.dirname, "../src", name), "utf8");
const css = read("styles.css");
const tokens = read("tokens.css");
const recipes = {
  "liquid-glass": read("liquidGlassTheme.css"),
  macos: read("macosTheme.css"),
  fluent: read("fluentTheme.css"),
};

const borderlessRule = (selector: string): string => {
  const start = css.indexOf(`body[data-hide-borders="true"] ${selector} {`);
  assert.ok(start >= 0, `styles.css has no borderless rule for ${selector}`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end < 0 ? css.length : end);
};

test("the left rail keeps the same frame as the package rail", () => {
  const rule = borderlessRule(".sidebar");
  assert.match(rule, /border-block-color:\s*var\(--contour\)\s*!important/);
  assert.match(rule, /border-inline-end-color:\s*var\(--contour\)\s*!important/);
  // The panel is flush to the window's inline start; framing that edge would
  // draw a line against the viewport and leave a page sliver under the glass.
  assert.match(rule, /border-inline-start:\s*0;/);
  assert.match(rule, /background-clip:\s*padding-box\s*!important/);
});

test("the package rail keeps its frame with and without an open window", () => {
  const rule = borderlessRule(".railbar");
  assert.match(rule, /border-block-color:\s*var\(--contour\)\s*!important/);
  assert.match(rule, /border-inline-start-color:\s*var\(--contour\)\s*!important/);
  assert.match(rule, /background-clip:\s*padding-box\s*!important/);
  // The host rule must not be nested inside a `:has(> .rail-dynamic)` scope:
  // the idle rail would then lose the frame the open rail keeps and the two
  // chrome columns would stop matching. (The window's own rule, which targets
  // `> .rail-dynamic` inside the host, is a different selector.)
  assert.doesNotMatch(
    css,
    /body\[data-hide-borders="true"\] \.railbar:has\([^)]*\)\s*\{/,
    "the railbar's borderless frame applies in every rail state",
  );
});

test("the composer's outline composites over the workspace, not its own glass", () => {
  const rule = borderlessRule(".composer-card");
  assert.match(rule, /border-color:\s*var\(--contour\)\s*!important/);
  assert.match(rule, /background-clip:\s*padding-box\s*!important/);
});

test("the contour is resolved on the root, so hiding borders cannot thin it", () => {
  // Hide interface borders clears --border/--border-soft on body; a contour
  // derived there would turn transparent with them.
  assert.match(tokens, /:root[^{]*\{[^}]*--contour:\s*color-mix\(/s);
  assert.match(tokens, /--material-glass-border:\s*var\(--contour\);/);
  for (const [style, recipe] of Object.entries(recipes)) {
    assert.match(recipe, /--contour:\s*var\(--[a-z-]+\);/, `${style} names its own contour`);
    assert.match(recipe, /--material-glass-border:\s*var\(--contour\);/, `${style} glass draws its contour`);
  }
});

test("shell controls and floating surfaces keep the contour without borders", () => {
  const start = css.indexOf('body[data-hide-borders="true"] :is(\n  .ui-popover');
  assert.ok(start >= 0, "styles.css restores the contour on glass surfaces and shell controls");
  const rule = css.slice(start, css.indexOf("\n}", start));
  for (const selector of [
    ".ui-popover", ".menu-popup", ".dialog-panel", ".sidebar-sessions-peek", ".header .ui-icon-btn",
    ".workspace-mode-switch", ".view-switcher-pill", ".desktop-session-status-trigger",
  ]) {
    assert.ok(rule.includes(selector), `${selector} keeps the contour`);
  }
  assert.match(rule, /border-color:\s*var\(--contour\)\s*!important/);
});

test("style recipes draw the composer on the contour", () => {
  for (const [style, recipe] of Object.entries(recipes)) {
    const rest = recipe.match(new RegExp(`html\\[data-theme-style="${style}"\\] \\.composer-card \\{[^}]*\\}`));
    assert.ok(rest, `${style} styles the composer`);
    assert.match(rest[0], /border-color:\s*var\(--contour\);/, `${style} composer rests on the contour`);
    // A ring in the box shadow would draw a second, thinner line of another colour.
    assert.doesNotMatch(rest[0], /0 0 0 0\.5px/, `${style} composer draws no extra ring`);
    assert.doesNotMatch(
      recipe,
      /body\[data-hide-borders="true"\][^{]*\.composer-card[^{]*\{\s*border-color:\s*transparent/,
      `${style} keeps the composer's contour without borders`,
    );
  }
});

test("running rings are activity signals, so hiding borders keeps them", () => {
  // Their whole mark is a border: without these exceptions the default look
  // showed running chats (and running subagents) with an empty state slot.
  const row = borderlessRule(".session-lead-spinner");
  assert.match(row, /border-top-color:\s*currentColor\s*!important/);
  const phone = readFileSync(resolve(import.meta.dirname, "../src/components/mobile/MobileNavigator.css"), "utf8");
  assert.match(phone, /body\[data-hide-borders="true"\] \.mobile-nav-running-ring \{[^}]*border-top-color:\s*var\(--accent\)\s*!important/);
});
