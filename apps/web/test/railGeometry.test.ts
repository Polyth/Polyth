// Geometry contract for the two icon rails. The left project rail and the right
// launcher strip share one glyph and one 4px tile rhythm; the left track is
// mirrored in sidebarLayout.ts; every control keeps a visible keyboard ring
// inside its scrolling list. Source-pinned like the other style contracts: the
// pixel measurements live in a Chromium pass, not in this file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SIDEBAR_RAIL_WIDTH } from "../src/sidebarLayout.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const source = (name: string) => read(`../src/${name}`);

function px(css: string, pattern: RegExp, what: string): number {
  const match = css.match(pattern);
  assert.ok(match, `${what} is declared`);
  return Number(match[1]);
}

test("the left rail track is one tile, an equal gutter each side and the divider", async () => {
  const [css, tokens] = await Promise.all([source("styles.css"), source("tokens.css")]);
  const track = px(css, /--rail-project-track:\s*calc\((\d+)px \* var\(--rail-scale-left, 1\)\)/, "--rail-project-track");
  const tile = px(css, /--rail-project-item:\s*calc\((\d+)px \* var\(--rail-scale-left, 1\)\)/, "--rail-project-item");
  const inset = px(tokens, /--space-1:\s*(\d+)px/, "--space-1");
  assert.equal(track, SIDEBAR_RAIL_WIDTH, "the CSS track and the sessions-column math in Sidebar.tsx share one width");
  const rail = css.match(/\.sidebar-project-rail\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rail, /padding-inline:\s*calc\(var\(--space-1\) \* var\(--rail-scale-left, 1\)\)/);
  assert.ok(
    tile + 2 * inset + 1 <= track,
    "the rail's inline padding and divider leave the tile its full width, so the list never clips it",
  );
  const gutter = (track - 1 - tile) / 2;
  assert.ok(Number.isInteger(gutter), "an integer gutter keeps the active tile's 1px border on a device pixel");
});

test("every left-rail control is one tile with one glyph", async () => {
  const css = await source("styles.css");
  assert.match(
    css,
    /\.sidebar-project-rail :is\(\.sidebar-project-rail-tool, \.sidebar-rail-toggle\)\s*\{[^}]*width:\s*var\(--rail-project-item\);[^}]*height:\s*var\(--rail-project-item\);[^}]*border-radius:\s*var\(--radius-card\)/s,
    "the collapse toggle and Settings are IconButtons whose md box would otherwise win on source order",
  );
  assert.match(
    css,
    /\.sidebar-project-rail :is\(\.sidebar-project-rail-tool, \.sidebar-rail-toggle\) svg\s*\{[^}]*width:\s*var\(--rail-icon-glyph-left, var\(--icon-rail\)\)/s,
    "Settings and the toggle no longer inherit the 16px service-bar glyph",
  );
  assert.match(
    css,
    /\.sidebar-project-rail \.sidebar-rail-toggle svg\s*\{[^}]*width:\s*calc\(var\(--rail-icon-glyph-left, var\(--icon-rail\)\) \* 0\.85\);[^}]*height:\s*calc\(var\(--rail-icon-glyph-left, var\(--icon-rail\)\) \* 0\.85\)/s,
    "the collapse toggle renders 15% under the rail glyph so it does not read as a 22px project icon",
  );
  assert.match(
    css,
    /\.sidebar-project-rail-item \.project-glyph > svg,\s*\.sidebar-project-rail-item \.project-glyph img,\s*\.sidebar-project-rail-item \.project-glyph-mask\s*\{[^}]*width:\s*var\(--rail-icon-glyph-left, var\(--icon-rail\)\)/s,
    "outline, raster and masked project icons share the rail glyph size",
  );
  assert.match(
    css,
    /\.sidebar-project-rail-item \.project-glyph > svg\s*\{\s*stroke-width:\s*1\.75;/,
    "the legacy outline icons match the 1.75 stroke of the IconButton glyphs beside them",
  );
  assert.match(
    css,
    /\.sidebar-project-rail-item \.project-glyph\s*\{\s*font-size:\s*calc\(var\(--rail-icon-glyph-left, var\(--icon-rail\)\) \* \.8\)/,
    "emoji and letter icons scale with the rail preference too",
  );
  assert.match(
    css,
    /\.sidebar-project-rail\s*\{[^}]*padding-block:\s*max\(var\(--space-2\), var\(--safe-top\)\) max\(var\(--space-2\), var\(--safe-bottom\)\)/s,
    "the footer tiles keep the same breathing room as the top one",
  );
});

test("both rails size glyphs from the published rail glyph, never a transform", async () => {
  const [css, tokens] = await Promise.all([source("styles.css"), source("tokens.css")]);
  assert.match(tokens, /--icon-rail:\s*22px/);
  assert.match(css, /\.strip-btn svg\s*\{[^}]*width:\s*var\(--rail-icon-glyph-right, var\(--icon-rail\)\)/s);
  assert.match(css, /\.plugin-strip \.capability-launcher > svg\s*\{[^}]*width:\s*var\(--rail-icon-glyph-right, var\(--icon-rail\)\)/s);
  assert.doesNotMatch(
    css,
    /\.strip-btn > svg[^{]*\{[^}]*transform:\s*scale/,
    "a scaled glyph is fractional (20.7px) and blurs its strokes on 1x displays",
  );
  const docs = await read("../../../docs/dev/styles.md");
  assert.match(docs, /`--icon-rail`/, "the icon scale documents the rail glyph");
});

test("the launcher strip is a tight column that keeps its badges and gaps", async () => {
  const css = await source("styles.css");
  assert.match(
    css,
    /\.rail-icon-col\.plugin-strip\s*\{[^}]*padding-block:\s*var\(--space-2\);[^}]*padding-inline:\s*var\(--rail-strip-gutter-start, var\(--space-2\)\) var\(--rail-strip-gutter-end, var\(--space-1\)\)/s,
    "the wider gutter faces the workspace, the narrow one the window edge",
  );
  assert.match(
    css,
    /\.rail-icon-scroll\s*\{[^}]*gap:\s*var\(--rail-gap, var\(--space-1\)\)/s,
    "launchers sit on the Icon spacing gap (4px by default)",
  );
  assert.match(
    css,
    /\.strip-badge\s*\{[^}]*top:\s*0;[^}]*inset-inline-end:\s*0;/s,
    "the badge sits inside the tile: the scroller clips anything that hangs off it",
  );
});

test("touch widens the tile gap and hit areas reach --hit-min", async () => {
  const css = await source("styles.css");
  assert.match(
    css,
    /@media \(pointer: coarse\) \{\s*\.sidebar-project-rail-list,\s*\.sidebar-project-rail-tools,\s*\.sidebar-project-rail-actions \{ gap: max\(var\(--rail-gap, var\(--space-1\)\), var\(--space-2\)\); \}\s*\}/,
  );
  assert.match(css, /@media \(pointer: coarse\) \{\s*\.rail-icon-scroll \{ gap: max\(var\(--rail-gap, var\(--space-1\)\), var\(--space-2\)\); \}\s*\}/);
  assert.match(
    css,
    /\.sidebar-project-rail-item::after\s*\{[^}]*width:\s*max\(100%, var\(--hit-min\)\);[^}]*height:\s*max\(100%, var\(--hit-min\)\)/s,
  );
  assert.match(
    css,
    /\.sidebar-project-rail-list\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/s,
    "a hit area wider than the list must not make it pan sideways",
  );
});

test("rail tiles show their keyboard ring inside the tile, below the Shift-held suppression", async () => {
  const css = await source("styles.css");
  assert.match(
    css,
    /:where\(\.sidebar-project-rail, \.plugin-strip\) button:focus-visible\s*\{\s*outline-offset:\s*-2px;\s*box-shadow:\s*none;\s*\}/,
    "both rails scroll their tiles, so an outside ring is clipped by the list",
  );
  assert.match(
    css,
    /body\[data-shift-held\] \[data-shift-quiet\]:focus-visible\s*\{\s*outline:\s*none;/,
    "the wrapper is zero-specificity so Shift-armed quick actions still hide every ring",
  );
});
