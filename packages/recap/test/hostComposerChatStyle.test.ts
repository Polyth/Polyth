// Recap owns its own disabled default, chrome and transcript-tail mount. These
// two cases moved out of apps/web/test/composerChatStyle.test.ts so the host
// test no longer names the removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, path), "utf8");

test("idle recap is package-owned and mounts at the transcript tail", () => {
  const timeline = read("../../../apps/web/src/components/Timeline.tsx");
  const entry = read("../widgets/index.tsx");
  const strip = read("../widgets/RecapStrip.tsx");
  const css = read("../widgets/styles.css");

  assert.doesNotMatch(timeline, /AssistStrip/);
  assert.match(entry, /slot: "session\.timeline\.after"/);
  assert.match(strip, /assistFreshnessSeq/);
  assert.match(strip, /assistFreshnessSeq\(events\) > assist\.atSeq/);
  assert.equal(css.match(/\.assist-strip\s*\{/g)?.length, 1);
  // The dismiss keeps the IconButton's own centring grid and sm box (its ::after
  // carries the touch target): an inline-flex or resized box pinned the glyph
  // to the hover wash's start edge.
  const dismiss = css.match(/\.assist-recap \.assist-dismiss\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(dismiss, /margin-block:\s*calc\(\(var\(--font-meta\) \* var\(--font-meta-lh\) - 24px\) \/ 2\);/);
  assert.doesNotMatch(dismiss, /\bdisplay:|inline-size:|block-size:|\bwidth:|\bheight:/);
  // One suggestion surface: the recap's next prompt rides on the composer chip.
  assert.doesNotMatch(strip, /assist\.suggestion|conversation\.insert/);
  assert.doesNotMatch(css, /\.assist-chip/);
});

test("idle recap is a bare caption: no glyph or visible label, dismiss held to the last word", () => {
  const strip = read("../widgets/RecapStrip.tsx");
  const css = read("../widgets/styles.css");

  assert.doesNotMatch(strip, /RecapIcon|<Icon\b|assist-tag/);
  assert.doesNotMatch(css, /\.assist-tag|\.assist-recap-icon/);
  // The name moves to the note's accessible label instead of visible text.
  assert.match(strip, /role="note" aria-label=\{tr\("assiststrip\.recap"\)\}/);
  assert.match(strip, /<span className="assist-recap-tail">[\s\S]*<IconButton[\s\S]*<\/span>/);
  assert.match(css, /\.assist-recap-tail\s*\{[^}]*white-space:\s*nowrap;/s);
});

test("recap package owns its disabled default and usable chrome", () => {
  const manifest = JSON.parse(read("../package.json")) as {
    polyth: { descriptor: { enabled: boolean } };
  };
  const css = read("../widgets/styles.css");

  assert.equal(manifest.polyth.descriptor.enabled, false);
  assert.match(css, /\.assist-strip\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
});
