// Geometry/visibility contract for the prompt rail (Finding 6 regression
// guard). The first shipped rail used a zero-size sticky anchor inside the
// .timeline scroller; the ticks then painted at the content-column edge, on
// top of right-aligned user bubbles, and the rail was effectively invisible.
// The contract: the rail is a real 32.2px gutter, absolutely positioned inside
// the non-scrolling .timeline-viewport wrapper, as a SIBLING of the scroller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const stylesSource = () =>
  readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const timelineSource = () =>
  readFile(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8");

/** Text of one top-level `selector { ... }` block in styles.css. */
function cssBlock(css: string, selector: string): string {
  // Line-anchored: `.prompt-bookmark-status .prompt-nav-page {` must not
  // stand in for the top-level `.prompt-nav-page {` block.
  const found = css.indexOf(`\n${selector} {`);
  assert.ok(found >= 0, `styles.css must define ${selector}`);
  const start = found + 1;
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("prompt rail is a real 15%-enlarged absolute gutter, not a zero-size sticky anchor", async () => {
  const css = await stylesSource();
  const nav = cssBlock(css, ".prompt-nav");
  assert.match(nav, /position:\s*absolute/, "rail must be absolutely positioned");
  assert.match(nav, /width:\s*32\.2px/, "rail must reserve the 15%-enlarged visible gutter");
  assert.doesNotMatch(nav, /width:\s*0/, "zero-width anchor hack must not come back");
  assert.doesNotMatch(nav, /height:\s*0/, "zero-height anchor hack must not come back");
  assert.doesNotMatch(nav, /position:\s*sticky/, "sticky anchor hack must not come back");
  assert.match(nav, /z-index/, "rail must stack above timeline content");
});

test("prompt ticks stay right-aligned while the edge arrow gets optical centering", async () => {
  const css = await stylesSource();
  const tape = cssBlock(css, ".prompt-nav-tape");
  const tick = cssBlock(css, ".prompt-nav-tick");
  const bar = cssBlock(css, ".prompt-nav-tick-bar");
  const edge = cssBlock(css, ".prompt-nav-edge");
  assert.match(tape, /align-items:\s*flex-end/);
  assert.match(tick, /width:\s*32\.2px/);
  assert.match(tick, /height:\s*9\.2px/);
  assert.match(tick, /justify-content:\s*flex-end/);
  assert.match(tick, /padding:\s*0 6\.9px 0 0/);
  assert.match(bar, /height:\s*2\.3px/);
  assert.match(bar, /transform-origin:\s*right center/);
  assert.match(edge, /transform:\s*translateX\(4px\)/);
  assert.match(bar, /background:\s*color-mix\(in srgb, var\(--text-dim\) 82%, var\(--panel\)\)/);
  assert.match(bar, /box-shadow:\s*none/);
  assert.doesNotMatch(bar, /box-shadow:\s*0 1px/);
  assert.match(css, /\.prompt-nav-tick\[aria-current="true"\] \.prompt-nav-tick-bar\s*\{[^}]*box-shadow:\s*none/s);
});

test("prompt panel rows are plain text with no leading mark", async () => {
  const css = await stylesSource();
  const row = cssBlock(css, ".prompt-nav-row");
  assert.match(row, /--prompt-nav-row-font:\s*calc\(var\(--font-meta\) \+ 2px\)/);
  assert.doesNotMatch(css, /\.prompt-nav-row::before\s*\{/, "row leading mark must be gone");
  assert.doesNotMatch(css, /\.prompt-nav-row:dir\(rtl\)::before/);
  assert.doesNotMatch(css, /prompt-nav-row[^{]*::before[^}]*--accent/s);
});

test("prompt preview glass uses stronger backdrop blur without weakening fallbacks", async () => {
  const css = await stylesSource();
  const panel = cssBlock(css, ".prompt-nav-panel");
  assert.match(panel, /--prompt-nav-panel-blur:\s*32px/);
  assert.match(panel, /--prompt-nav-panel-fill:\s*calc\(76% \+ var\(--material-glass-fill\) \* 0\.24\)/);
  assert.match(panel, /--prompt-nav-panel-edge:\s*calc\(58% \+ var\(--material-glass-edge\) \* 0\.35\)/);
  assert.match(panel, /background:\s*var\(--material-glass-strong\)/);
  assert.match(css, /body\[data-glass="clear"\] \.prompt-nav-panel\s*\{[^}]*--prompt-nav-panel-blur:\s*22px/);
  assert.match(css, /color-mix\(in srgb, var\(--material-glass-strong\) var\(--prompt-nav-panel-fill\), transparent\)/);
  assert.match(css, /\.prompt-nav-panel\s*\{[^}]*backdrop-filter:\s*blur\(var\(--prompt-nav-panel-blur\)\)/s);
  assert.match(css, /body\[data-glass="off"\][^{]*\.prompt-nav-panel[^}]*backdrop-filter:\s*none !important/s);
  assert.match(css, /body\[data-desktop-low-resource="true"\][^{]*\.prompt-nav-panel[^}]*backdrop-filter:\s*none/s);
});

test("prompt navigation arrows stay centered and compact inside the prompt panel", async () => {
  const css = await stylesSource();
  const page = cssBlock(css, ".prompt-nav-page");
  const panelPage = cssBlock(css, ".prompt-nav-panel > .prompt-nav-page");
  assert.match(page, /display:\s*grid/);
  assert.match(page, /place-items:\s*center/);
  assert.match(panelPage, /height:\s*18px/);
  assert.match(panelPage, /font-size:\s*13px/);
});

test("tick tape flows inside the gutter instead of hanging off an anchor", async () => {
  const css = await stylesSource();
  const tape = cssBlock(css, ".prompt-nav-tape");
  assert.doesNotMatch(tape, /position:\s*absolute/, "tape must be in-flow within the gutter");
});

test("timeline-viewport is the rail's non-scrolling positioning context", async () => {
  const css = await stylesSource();
  const viewport = cssBlock(css, ".timeline-viewport");
  assert.match(viewport, /position:\s*relative/, "viewport must establish the containing block");
});

test("rail mounts as a sibling of the .timeline scroller, outside its overflow", async () => {
  const src = await timelineSource();
  assert.ok(src.includes('className="timeline-viewport"'), "Timeline must render the viewport wrapper");
  // The PromptNavigator mount must come AFTER the scroller's closing tag —
  // inside the scroller it would scroll away and be overpainted by bubbles.
  // Other absolute siblings (the clipped live-action layer, the narrow-screen
  // prompt bookmark) may sit between.
  assert.match(
    src,
    /<\/div>\s*(?:<div[^>]*\/>\s*)*(?:\{showBookmark[^\n]*\(\s*<PromptBookmark[\s\S]*?\/>\s*\)\}\s*)?\{showNav && \(\s*<PromptNavigator/,
    "PromptNavigator must be a sibling of the closed .timeline scroller",
  );
});

test("rail edge offset is measured, mirrors for a left rail, and leaves the bookmark to its own per-width switches", async () => {
  const css = await stylesSource();
  const source = await timelineSource();
  const nav = cssBlock(css, ".prompt-nav");
  assert.match(nav, /right:\s*var\(--prompt-nav-inset, 4px\)/, "no hard-coded strip width");
  assert.doesNotMatch(nav, /right:\s*44px/);
  const left = cssBlock(css, '.prompt-nav[data-side="left"]');
  assert.match(left, /right:\s*auto/);
  assert.match(left, /left:\s*var\(--prompt-nav-inset, 4px\)/);
  assert.match(css, /\.prompt-nav\[data-side="left"\] \.prompt-nav-panel\s*\{[^}]*left:\s*calc\(100% \+ 9\.2px\)/);
  assert.match(css, /@media \(max-width: 1100px\)\s*\{\s*\.prompt-nav\s*\{\s*display:\s*none;\s*\}\s*\.prompt-bookmark\[data-narrow="off"\]\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(min-width: 1101px\)\s*\{\s*\.prompt-bookmark\[data-wide="off"\]\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /:has\(> \.prompt-nav\) > \.prompt-bookmark/, "an enabled desktop bookmark must not be hidden by the rail");
  assert.match(source, /promptRailInset\(viewport\.getBoundingClientRect\(\)/);
  assert.match(source, /data-side=\{side\}/);
  assert.match(source, /side=\{prefs\.promptNavigatorSide\}/);
});
