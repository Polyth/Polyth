// Geometry/visibility contract for the prompt rail (Finding 6 regression
// guard). The first shipped rail used a zero-size sticky anchor inside the
// .timeline scroller; the ticks then painted at the content-column edge, on
// top of right-aligned user bubbles, and the rail was effectively invisible.
// The contract: the rail is a real 28px gutter, absolutely positioned inside
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

test("prompt rail is a real 28px absolute gutter, not a zero-size sticky anchor", async () => {
  const css = await stylesSource();
  const nav = cssBlock(css, ".prompt-nav");
  assert.match(nav, /position:\s*absolute/, "rail must be absolutely positioned");
  assert.match(nav, /width:\s*28px/, "rail must reserve a visible 28px gutter");
  assert.doesNotMatch(nav, /width:\s*0/, "zero-width anchor hack must not come back");
  assert.doesNotMatch(nav, /height:\s*0/, "zero-height anchor hack must not come back");
  assert.doesNotMatch(nav, /position:\s*sticky/, "sticky anchor hack must not come back");
  assert.match(nav, /z-index/, "rail must stack above timeline content");
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
  assert.match(
    src,
    /<\/div>\s*\{showNav && \(\s*<PromptNavigator/,
    "PromptNavigator must be a sibling of the closed .timeline scroller",
  );
});
