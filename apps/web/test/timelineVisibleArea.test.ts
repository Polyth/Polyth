import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { timelineVisibleArea } from "../src/timelineVisibleArea.ts";
import { timelineFocusLine, timelineTurnReserve } from "../src/timelineFollow.ts";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
// timelineVisibleArea reads only this field; the rest of the DOM declaration
// is intentionally absent from this boundary fixture.
const computedStyle = (scrollPaddingTop: string): CSSStyleDeclaration =>
  ({ scrollPaddingTop } as unknown as CSSStyleDeclaration);

test("phone reading area follows the floating header clearance, including the short keyboard band", () => {
  assert.match(css, /\.app\.mode-chat\.view-session \.timeline \{[^}]*--timeline-visible-top-inset: var\(--timeline-pad-top\)/s);
  assert.match(css, /\.app\.mode-chat\.view-session \.timeline-viewport \{[^}]*--timeline-bookmark-top: calc\(/s);
  assert.doesNotMatch(css, /body\[data-keyboard="open"\]\[data-band="short"\] \.timeline \{[^}]*--timeline-pad-top: 0px/s);
  assert.match(css, /scroll-padding-top: var\(--timeline-visible-top-inset\)/);

  // The phone mask ramps up under the floating session island and back down
  // over one fixed reading gap at the composer edge, so neither chrome edge
  // hard-clips the transcript. The bottom fade must not track
  // --timeline-pad-bottom: its turn-sheet runway can span most of the screen.
  assert.match(css, /--timeline-fade-bottom: calc\(var\(--conversation-message-gap\) \+ var\(--conversation-group-gap\)\);/);
  assert.match(
    css,
    /--timeline-mask:\s*linear-gradient\(\s*to bottom,\s*transparent var\(--safe-top\),\s*#000 var\(--timeline-pad-top\),\s*#000 calc\(100% - var\(--timeline-fade-bottom\)\),\s*transparent\s*\)/s,
  );
  assert.doesNotMatch(css, /#000 calc\(100% - var\(--timeline-pad-bottom\)\)/);
  assert.match(css, /-webkit-mask-image: var\(--timeline-mask\)/);
  assert.match(css, /mask-image: var\(--timeline-mask\)/);

  const original = globalThis.getComputedStyle;
  try {
    const port = { getBoundingClientRect: () => ({ top: 0, bottom: 600, height: 600 }) } as HTMLElement;
    globalThis.getComputedStyle = () => computedStyle("88px");
    const phone = timelineVisibleArea(port);
    assert.deepEqual(phone, { top: 88, bottom: 600, height: 512, inset: 88 });
    assert.equal(timelineFocusLine(phone), 344, "the prompt focus line includes the phone inset");
    assert.equal(timelineTurnReserve(phone), 256, "the reserve ends directly above the composer");

    globalThis.getComputedStyle = () => computedStyle("0px");
    assert.deepEqual(timelineVisibleArea(port), { top: 0, bottom: 600, height: 600, inset: 0 });
    globalThis.getComputedStyle = () => computedStyle("900px");
    assert.deepEqual(timelineVisibleArea(port), { top: 600, bottom: 600, height: 0, inset: 600 });

    globalThis.getComputedStyle = () => computedStyle("calc(40px + 48px)");
    const island = { getBoundingClientRect: () => ({ bottom: 76 }) };
    const fallbackPort = {
      getBoundingClientRect: () => ({ top: 4, bottom: 604, height: 600 }),
      closest: () => ({ querySelector: () => island }),
    } as unknown as HTMLElement;
    assert.deepEqual(timelineVisibleArea(fallbackPort), { top: 76, bottom: 604, height: 528, inset: 72 });
  } finally {
    globalThis.getComputedStyle = original;
  }
});
