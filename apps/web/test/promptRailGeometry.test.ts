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
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `styles.css must define ${selector}`);
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

test("prompt ticks keep the 15%-larger pitch and a visible inactive treatment", async () => {
  const css = await stylesSource();
  const tick = cssBlock(css, ".prompt-nav-tick");
  const bar = cssBlock(css, ".prompt-nav-tick-bar");
  assert.match(tick, /width:\s*32\.2px/);
  assert.match(tick, /height:\s*9\.2px/);
  assert.match(tick, /padding:\s*0 6\.9px 0 0/);
  assert.match(bar, /height:\s*2\.3px/);
  assert.match(bar, /background:\s*color-mix\(in srgb, var\(--text-dim\) 82%, var\(--panel\)\)/);
  assert.match(bar, /box-shadow:/, "inactive marks need separation from transparent backgrounds");
});

test("prompt preview glass uses stronger backdrop blur without weakening fallbacks", async () => {
  const css = await stylesSource();
  const panel = cssBlock(css, ".prompt-nav-panel");
  assert.match(panel, /--prompt-nav-panel-blur:\s*32px/);
  assert.match(css, /body\[data-glass="clear"\] \.prompt-nav-panel\s*\{[^}]*--prompt-nav-panel-blur:\s*22px/);
  assert.match(css, /\.prompt-nav-panel\s*\{[^}]*backdrop-filter:\s*blur\(var\(--prompt-nav-panel-blur\)\)/s);
  assert.match(css, /body\[data-glass="off"\][^{]*\.prompt-nav-panel[^}]*backdrop-filter:\s*none !important/s);
  assert.match(css, /body\[data-desktop-low-resource="true"\][^{]*\.prompt-nav-panel[^}]*backdrop-filter:\s*none/s);
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
  // Other absolute siblings (the clipped live-action layer) may sit between.
  assert.match(
    src,
    /<\/div>\s*(?:<div[^>]*\/>\s*)*\{showNav && \(\s*<PromptNavigator/,
    "PromptNavigator must be a sibling of the closed .timeline scroller",
  );
});
