// Moved from apps/web/test/responsiveOverlays.test.ts: the usage dashboard's
// own container-responsive layout, measured in Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";

const read = async (relative: string): Promise<string> => {
  const content = await readFile(new URL(relative, import.meta.url), "utf8");
  if (relative !== "../../../apps/web/src/styles.css") return content;
  const tokens = await readFile(new URL("../../../apps/web/src/tokens.css", import.meta.url), "utf8");
  return `${tokens}\n${content}`;
};

// Chromium discovery mirrors the browser package's contract without naming a
// removable package: POLYTH_CHROMIUM_PATH, then well-known paths, then a local
// Playwright installation. This test never downloads a browser.
const CHROMIUM_CANDIDATE_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/local/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/local/bin/google-chrome",
  "/opt/google/chrome/google-chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const chromiumExecutable = (path: string) => access(path, constants.X_OK).then(() => path, () => null);
const CHROME = await (async (): Promise<string | null> => {
  const configured = process.env.POLYTH_CHROMIUM_PATH?.trim();
  if (configured) return chromiumExecutable(configured);
  if (process.env.POLYTH_REQUIRE_BUNDLED_CHROMIUM === "1") return null;
  for (const path of CHROMIUM_CANDIDATE_PATHS) {
    const found = await chromiumExecutable(path);
    if (found) return found;
  }
  try {
    const bundled = chromium.executablePath();
    return bundled ? await chromiumExecutable(bundled) : null;
  } catch {
    return null;
  }
})();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 720 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

after(async () => {
  await browser?.close();
});

test("Usage dashboard responds to a docked panel instead of the viewport", { skip: !CHROME }, async () => {
  assert.ok(page);
  const [coreCss, usageCss] = await Promise.all([
    read("../../../apps/web/src/styles.css"),
    read("../widgets/usageAnalytics.css"),
  ]);
  const tabs = (className: string, labels: string[]): string =>
    `<div role="tablist" class="ui-tabs ui-tabs--sm ${className}">${labels.map((label) => `<button role="tab" class="ui-tab">${label}</button>`).join("")}</div>`;

  for (const width of [280, 344]) {
    await page.setContent(`
      <style>${coreCss}\n${usageCss}</style>
      <div class="usage-clean" style="width:${width}px;height:640px">
        <header class="usage-clean-toolbar">
          ${tabs("usage-clean-scope-tabs", ["Session", "Project", "Global", "Limits"])}
          ${tabs("usage-clean-range", ["7d", "30d", "90d", "All"])}
          <span class="usage-clean-spacer"></span>
          <span class="usage-clean-freshness">Updated 12:00</span>
          <span class="usage-clean-toolbar-actions"><button>L</button><button>R</button></span>
        </header>
      </div>
    `);

    const layout: {
      clientWidth: number;
      scrollWidth: number;
      toolbarScrollWidth: number;
      toolbarClientWidth: number;
    } = await page.evaluate(() => {
      const dashboard = document.querySelector<HTMLElement>(".usage-clean")!;
      const toolbar = document.querySelector<HTMLElement>(".usage-clean-toolbar")!;
      return {
        clientWidth: dashboard.clientWidth,
        scrollWidth: dashboard.scrollWidth,
        toolbarScrollWidth: toolbar.scrollWidth,
        toolbarClientWidth: toolbar.clientWidth,
      };
    });

    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${width}px dashboard has no horizontal overflow`);
    assert.ok(layout.toolbarScrollWidth <= layout.toolbarClientWidth + 1, `${width}px toolbar has no horizontal overflow`);
  }
});
