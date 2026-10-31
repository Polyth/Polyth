// The sidebar toolbar stays one row at every width. Rather than wrapping the
// search field onto its own line (which left a dead band under the toolbar)
// or clipping "Search sessions…", the field swaps to a short placeholder once
// its column is too narrow. These tests pin that contract: the narrow
// presentation must exist in every locale, the threshold must stay tied to the
// measured placeholder, and no wrap rule may come back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_RAIL_WIDTH } from "../src/sidebarLayout.ts";

const webSrc = resolve(import.meta.dirname, "../src");
const read = (path: string) => readFile(join(webSrc, path), "utf8");
const sidebarSource = await read("components/Sidebar.tsx");
const styles = await read("styles.css");

test("the toolbar keeps one row and never wraps the search field", () => {
  const bar = styles.match(/\.sidebar-service-bar \{[\s\S]*?\n\}/)?.[0];
  assert.ok(bar, ".sidebar-service-bar rule must exist");
  assert.doesNotMatch(bar, /flex-wrap/, "the service bar must not wrap onto a second row");
  // The wrap rule that produced the empty band is gone, and with it the
  // container it needed.
  assert.doesNotMatch(styles, /sidebar-service-bar[\s\S]{0,200}flex-wrap: wrap/);
});

test("the search field reserves the clear button's gap only while it exists", () => {
  // An empty field must spend its width on the placeholder, not on a button
  // that is not rendered.
  assert.match(
    styles,
    /\.sidebar-search:has\(\.sidebar-search-clear\) input \{ padding-right: 33px; \}/,
    "the clear-button gap must be conditional on the button rendering",
  );
});

test("the narrow toolbar swaps the placeholder instead of clipping it", () => {
  assert.match(
    sidebarSource,
    /searchFitsFullLabel \? "sidebar\.searchSessions" : "sidebar\.searchSessionsShort"/,
    "the toolbar must choose the placeholder from the measured column width",
  );
  // The measurement must come from the real column, so every input that can
  // change its width (separator drag, rail size, mirroring, drawer) is honoured.
  assert.match(sidebarSource, /useElementWidth\(sidebarMainRef\)/);
  assert.match(sidebarSource, /ref=\{sidebarMainRef\}/);
  // A still-unmeasured column keeps the full label, so the toolbar never
  // flashes the short one on the first frame.
  assert.match(sidebarSource, /sidebarMainWidth === null \|\| sidebarMainWidth >= SEARCH_FULL_LABEL_MIN_WIDTH/);
});

test("the width hook measures the element and keeps tracking it", async () => {
  const hook = await read("useElementWidth.ts");
  // Measured rather than inferred: the hook reads the element's own box.
  assert.match(hook, /getBoundingClientRect\(\)\.width/);
  // It must subscribe to later changes (drag, rail size, mirroring), not
  // measure once.
  assert.match(hook, /new ResizeObserver\(measure\)/);
  assert.match(hook, /observer\.observe\(el\)/);
  assert.match(hook, /observer\.disconnect\(\)/, "the observer must be released on unmount");
  // Degrades instead of throwing where ResizeObserver is unavailable.
  assert.match(hook, /typeof ResizeObserver !== "function"/);
  // Sub-pixel resizes must not re-render the whole sidebar per frame.
  assert.match(hook, /Math\.abs\(current - next\) < 0\.5/);
});

test("the threshold is anchored to the measured full placeholder", () => {
  // Keep the documented budget honest: 16px bar padding + 3 x 36px actions +
  // 3 x 2px gaps + the field's 26px leading and 4px trailing padding.
  const threshold = Number(
    sidebarSource.match(/export const SEARCH_FULL_LABEL_MIN_WIDTH = (\d+);/)?.[1],
  );
  assert.ok(Number.isFinite(threshold), "SEARCH_FULL_LABEL_MIN_WIDTH must be exported");
  const chrome = 16 + 3 * 36 + 3 * 2 + 26 + 4;
  const fullPlaceholderWidth = 116.84; // measured in Inter at the 13.02px UI size
  assert.ok(
    threshold >= fullPlaceholderWidth + chrome,
    `threshold ${threshold}px must not fall below the ${fullPlaceholderWidth + chrome}px the full label needs`,
  );
  // The threshold is compared against the measured *column*, not the sidebar
  // setting, so it must also be reachable: a threshold above the default
  // column would hide the full label on a stock sidebar.
  const defaultColumn = SIDEBAR_DEFAULT_WIDTH - SIDEBAR_RAIL_WIDTH;
  assert.ok(
    threshold <= defaultColumn,
    `default sidebar column ${defaultColumn}px must still show the full label (threshold ${threshold}px)`,
  );
  assert.ok(
    threshold > SIDEBAR_MIN_WIDTH - SIDEBAR_RAIL_WIDTH,
    "the narrowest column must be able to fall below the threshold",
  );
});

test("every locale can express the short placeholder", async () => {
  const dir = join(webSrc, "i18n/locales");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".ts")).sort();
  assert.ok(files.length > 1, "expected several locale catalogs");
  const missing: string[] = [];
  const tooLong: string[] = [];
  for (const file of files) {
    const source = await readFile(join(dir, file), "utf8");
    const full = source.match(/"sidebar\.searchSessions": "([^"]*)"/)?.[1];
    const short = source.match(/"sidebar\.searchSessionsShort": "([^"]*)"/)?.[1];
    if (!short) { missing.push(file); continue; }
    // The short label has to actually be shorter, or it cannot relieve the
    // clipped state it exists for.
    if (full && short.length >= full.length) tooLong.push(`${file} (${short} vs ${full})`);
  }
  assert.deepEqual(missing, [], `locales without the short placeholder: ${missing.join(", ")}`);
  assert.deepEqual(tooLong, [], `short placeholder is not shorter: ${tooLong.join(", ")}`);
});
