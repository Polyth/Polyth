// app.nav bounded-context regression (EXTENSION-SEAMS mounting matrix): the
// `expanded` value must describe the sidebar's actual presentation, not the
// mobile drawer flag. At desktop width the sidebar is visibly expanded while
// sidebarOpen is false — the audit caught the context reporting false there.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SIDEBAR_NARROW_QUERY, sidebarExpanded } from "../src/sidebarPresentation.ts";

test("sidebarExpanded reports the presentation, not the drawer flag", () => {
  // Desktop: always expanded — even with the drawer flag false (the audited
  // 1280×900 case: 272px visible sidebar, sidebarOpen === false).
  assert.equal(sidebarExpanded(false, false), true);
  assert.equal(sidebarExpanded(false, true), true);
  // Narrow viewport: the CSS hides the sidebar unless the drawer is open.
  assert.equal(sidebarExpanded(true, false), false);
  assert.equal(sidebarExpanded(true, true), true);
});

test("the narrow-breakpoint query matches the stylesheet rule hiding the sidebar", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../src/styles.css"), "utf8");
  const media = css.indexOf(`@media ${SIDEBAR_NARROW_QUERY}`);
  assert.ok(media >= 0, `styles.css has no @media ${SIDEBAR_NARROW_QUERY} block`);
  const block = css.slice(media, css.indexOf("}\n}", media) + 3);
  assert.match(block, /\.sidebar\s*\{\s*display:\s*none/, "the breakpoint block must hide .sidebar");
});
