// iPhone Duo's status column (a wide side safe area) holds the launcher strip
// in the tablet and phone shells instead of sitting empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SIDE_STRIP_MIN_INSET, sideStripForInsets } from "../src/sideSafeStrip.ts";
import { readWebStyles } from "./webStyles.ts";

const read = (rel: string) => readFile(new URL(rel, import.meta.url), "utf8");

test("only a status-column-wide side inset hosts the strip", () => {
  assert.equal(SIDE_STRIP_MIN_INSET, 72);
  // iPhone Duo, either display: 84pt on the trailing side, or leading when
  // turned upside down.
  assert.equal(sideStripForInsets(0, 84), "right");
  assert.equal(sideStripForInsets(84, 0), "left");
  // Notched iPhones in landscape report up to ~62pt; portrait reports none.
  assert.equal(sideStripForInsets(62, 62), null);
  assert.equal(sideStripForInsets(0, 59), null);
  assert.equal(sideStripForInsets(0, 0), null);
  assert.equal(sideStripForInsets(0, 71.5), null);
  assert.equal(sideStripForInsets(0, 72), "right");
  // The wider side wins; a tie keeps the trailing side.
  assert.equal(sideStripForInsets(59, 84), "right");
  assert.equal(sideStripForInsets(84, 84), "right");
});

test("compact and phone shells move the strip into the side safe area", async () => {
  const rail = await read("../src/components/ContextRail.tsx");
  assert.match(rail, /const safeAreaStrip = compact \? sideStrip : null;/,
    "the wide shell keeps its own strip; only the drawer shells use the column");
  assert.match(rail, /const showStrip = safeAreaStrip !== null\s*\? railButtons\.length > 0 \|\| railWidgets \|\| workspaceEditing \|\| drag\.receiving/,
    "an empty rail still renders nothing in the column");
  assert.match(rail, /data-side-strip=\{sideStripShown \? safeAreaStrip \?\? undefined : undefined\}/);
  // The header and drawer already carry the docked bar groups there.
  assert.match(rail, /\{safeAreaStrip === null && <ShellDock column="end" group="tools" \/>\}/);
  assert.match(rail, /\{safeAreaStrip === null && <ShellDock column="end" group="actions" \/>\}/);
  assert.match(rail, /\{safeAreaStrip === null && <ShellColumnAccount column="end" \/>\}/);
  assert.match(rail, /style\.setProperty\("--side-strip-host-top"/,
    "the first icon is placed against the screen top, wherever the host starts");
});

test("the column sits on the hardware side and clears the status items", async () => {
  const css = await readWebStyles();
  assert.match(css, /\.railbar\[data-side-strip="right"\]:not\(\.railbar-open\):not\(\[data-rail-motion="exiting"\]\) \{[^}]*right: 0;[^}]*width: var\(--safe-right\);/s);
  assert.match(css, /\.railbar\[data-side-strip="left"\]:not\(\.railbar-open\):not\(\[data-rail-motion="exiting"\]\) \{[^}]*left: 0;[^}]*width: var\(--safe-left\);/s);
  assert.match(css, /\.railbar\[data-side-strip\] > \.rail-icon-col\.plugin-strip \{[^}]*--rail-icon-size-right: var\(--tap\);[^}]*calc\(var\(--side-strip-head\) - var\(--side-strip-host-top, 0px\)\)/s,
    "touch-sized tiles start below the status items, measured from the screen top");
  assert.match(css, /\.railbar\[data-side-strip\] > \.rail-icon-col\.plugin-strip \{[^}]*z-index: 121;/s,
    "an open window or sheet never hides the column's launchers");
  assert.match(css, /@media \(max-width: 480px\), \(max-height: 480px\) and \(pointer: coarse\) \{\s*\.railbar\[data-side-strip\] > \.rail-icon-col\.plugin-strip \{ --side-strip-head: 120px; \}/,
    "folded, the strip also clears the front camera");
});

test("chrome beside the column keeps a gap that a notch does not get", async () => {
  const tokens = await read("../src/tokens.css");
  assert.match(tokens, /--safe-right-clear: calc\(var\(--safe-right\) \+ clamp\(0px, \(var\(--safe-right\) - 71px\) \* 1000, var\(--space-2\)\)\);/);
  assert.match(tokens, /--safe-left-clear: calc\(var\(--safe-left\) \+ clamp\(0px, \(var\(--safe-left\) - 71px\) \* 1000, var\(--space-2\)\)\);/);
  const css = await readWebStyles();
  assert.match(css, /\.app > \.header \{ padding: var\(--safe-top\) max\(8px, var\(--safe-right-clear\)\) 0 max\(8px, var\(--safe-left-clear\)\); \}/);
  assert.match(css, /--conversation-frame-inline-end: max\(var\(--conversation-inset\), var\(--safe-right-clear\)\);/);
});
