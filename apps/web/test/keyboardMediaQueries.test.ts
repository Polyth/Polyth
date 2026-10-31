// A media query whose result flips while the phone keyboard opens makes the
// engine rebuild its rule sets — fonts, keyframes, registered properties —
// and lay out every box again: 358 ms of layout per keyboard move on the test
// machine, against 6 ms once the short-viewport rules became body tokens
// (mobileViewport.ts SHORT_VIEWPORT_QUERIES, styles.css "Short viewports").
// Every media query list in the shipped CSS is evaluated in Chromium on
// portrait phones before and after a keyboard takes its height.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function mediaLists(): Map<string, string[]> {
  const files = execFileSync("git", ["ls-files", "*.css"], { cwd: ROOT, encoding: "utf8" })
    .trim().split("\n").filter((file) => file && !file.includes("/test/"));
  const lists = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(ROOT + file, "utf8");
    for (const match of text.matchAll(/@media\s+([^{]+)\{/g)) {
      const query = match[1]!.trim().replace(/\s+/g, " ");
      if (!/height|aspect-ratio/.test(query)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      lists.set(query, [...(lists.get(query) ?? []), `${file}:${line}`]);
    }
  }
  return lists;
}

// Portrait phones and a typical keyboard height for each.
const PHONES: Array<[string, number, number, number]> = [
  ["iPhone 14/15", 390, 844, 336],
  ["iPhone SE", 375, 667, 260],
  ["iPhone Pro Max", 430, 932, 346],
  ["Android", 412, 915, 330],
];

test("no media query list flips when a phone keyboard opens", { skip: !CHROME }, async () => {
  const lists = mediaLists();
  const queries = [...lists.keys()];
  assert.ok(queries.length > 0);
  const browser = await chromium.launch({ executablePath: CHROME!, headless: true });
  try {
    for (const [name, width, height, keyboard] of PHONES) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body></body>');
      const closed = await page.evaluate((qs) => qs.map((q) => matchMedia(q).matches), queries);
      await page.setViewportSize({ width, height: height - keyboard });
      const open = await page.evaluate((qs) => qs.map((q) => matchMedia(q).matches), queries);
      const flips = queries.filter((_, index) => closed[index] !== open[index]);
      assert.deepEqual(
        flips.map((query) => `${query} ← ${lists.get(query)!.join(", ")}`),
        [],
        `${name}: a keyboard must not flip a stylesheet media query (publish it as a body token instead)`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

test("the short-viewport tokens are the media queries they replace", async () => {
  const viewport = readFileSync(new URL("../src/mobileViewport.ts", import.meta.url), "utf8");
  assert.match(viewport, /"560": "\(max-height: 560px\)"/);
  assert.match(viewport, /"560-compact": "\(max-height: 560px\) and \(max-width: 480px\), \(max-height: 480px\) and \(pointer: coarse\)"/);
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles, /:where\(body\[data-viewport-short~="560"\]\) \.composer \{ padding-block: 3px 4px; \}/);
  assert.match(styles, /:where\(body\[data-viewport-short~="560-compact"\]\) \.composer-card textarea \{ max-height: 40px; \}/);
});
