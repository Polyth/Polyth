// Browser-level design contract, not screenshots of fully connected packages.
// Load every package stylesheet in both orders to catch late-loaded CSS drift.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const coreCss = ["tokens.css", "styles.css", "moduleContent.css"]
  .map((name) => read(`apps/web/src/${name}`)).join("\n");

function stylesIn(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return stylesIn(path);
    return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
  }).sort();
}

const packageStyles = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => stylesIn(join(root, "packages", entry.name, "widgets")))
  .sort().map((path) => readFileSync(path, "utf8"));
const styles = (reverse = false) => coreCss + "\n" + (reverse ? packageStyles.toReversed() : packageStyles).join("\n");
let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    ...(process.getuid?.() === 0 ? { args: ["--no-sandbox"] } : {}),
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // The fixture must never rely on fonts, assets or services from the network.
  await page.route("**/*", (route) => route.abort());
});

after(async () => { await browser?.close(); });

test("compact package windows cover the viewport through rotation and glass preferences", { skip: !CHROME }, async () => {
  assert.ok(browser);
  const target = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await target.route("**/*", (route) => route.abort());
  await target.emulateMedia({ reducedMotion: "reduce" });
  const viewportCss = ["composerAdaptive.css", "mobileViewport.css"]
    .map((name) => read(`apps/web/src/${name}`)).join("\n");
  try {
    for (const [width, height] of [[390, 844], [1080, 390], [834, 1112]] as const) {
      await target.setViewportSize({ width, height });
      const phone = width <= 480 || height <= 480;
      for (const glass of ["on", "off"]) for (const sheet of [false, true]) {
        await target.setContent(`
          <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
          <style>${styles()}\n${viewportCss}</style>
          <body data-glass="${glass}" data-keyboard="closed">
            <div id="root"><div class="app mode-chat view-session">
              ${phone ? "" : '<header class="header">Navigation</header>'}
              <div class="app-shell">
                <div class="workspace" inert>Chat</div>
                <aside class="railbar railbar-open" data-rail-motion="open">
                  <div class="${sheet ? "panel-sheet" : "rail rail-workspace rail-pinned rail-fullscreen"}" data-rail-motion="open" style="--rail-w:480px">
                    <section class="module-view ${phone ? "module-view--phone" : ""}">
                      <header class="module-view-head">
                        <h1 class="module-view-title">Package window</h1>
                        <button class="module-view-close">Close</button>
                      </header>
                      <div class="module-view-body"><div class="module-view-content module-view-content--panel">Content</div></div>
                    </section>
                  </div>
                </aside>
              </div>
            </div></div>
          </body>
        `);
        const geometry = await target.evaluate(async () => {
          const pane = document.querySelector<HTMLElement>(".rail-fullscreen, .panel-sheet")!;
          await Promise.all(pane.getAnimations().map((animation) => animation.finished));
          const rect = pane.getBoundingClientRect();
          const close = pane.querySelector<HTMLElement>(".module-view-close")!;
          const button = close.getBoundingClientRect();
          const hit = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
          return {
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            closeReachable: hit === close || close.contains(hit),
          };
        });
        const label = `${width}x${height}/${glass}/${sheet ? "context" : "workspace"}`;
        assert.deepEqual(
          { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height },
          { x: 0, y: 0, width, height }, label,
        );
        assert.ok(geometry.closeReachable, `${label}: close control is reachable`);
      }
    }
  } finally {
    await target.close();
  }
});

for (const reverse of [false, true]) {
  test(`host page rhythm survives ${reverse ? "reverse" : "forward"} package CSS loading`, { skip: !CHROME }, async () => {
    assert.ok(page);
    for (const width of [360, 680, 1000]) {
      for (const mode of ["page", "panel"]) {
        for (const placement of ["direct", "rail", "workbench"]) {
          const feature = '<section class="contract-feature"><div style="height:900px;flex:none">Content</div></section>';
          const body = placement === "rail"
            ? `<div class="rail-body">${feature}</div><div class="rail-body" hidden inert>Inactive</div>`
            : placement === "workbench"
              ? `<div class="wb-slot"><div class="wb-surface-mount">${feature}</div></div>`
              : feature;
          await page.setContent(`
            <style>${styles(reverse)}
              .contract-feature { padding:37px; margin:21px; border:3px solid; background:pink; font:23px serif; }
            </style>
            <section class="module-view" style="width:${width}px;height:380px;flex:none">
              <header class="module-view-head">Package</header>
              <div class="module-view-body"><div class="module-view-content module-view-content--${mode}">${body}</div></div>
            </section>
          `);
          const measured: { gutter: number; rootPadding: string; rootMargin: string; rootBorder: string; rootBackground: string; inheritedFont: boolean; scrollable: boolean; noHorizontalOverflow: boolean; inactiveHidden: boolean } = await page.evaluate((placement) => {
            const root = document.querySelector<HTMLElement>(".contract-feature")!;
            const owner = document.querySelector<HTMLElement>(placement === "rail" ? ".rail-body:not([hidden])" : placement === "workbench" ? ".wb-surface-mount" : ".module-view-content")!;
            const featureStyle = getComputedStyle(root);
            const ownerStyle = getComputedStyle(owner);
            return {
              gutter: parseFloat(ownerStyle.paddingLeft),
              rootPadding: featureStyle.paddingLeft,
              rootMargin: featureStyle.marginLeft,
              rootBorder: featureStyle.borderTopWidth,
              rootBackground: featureStyle.backgroundColor,
              inheritedFont: featureStyle.fontSize === ownerStyle.fontSize,
              scrollable: owner.scrollHeight > owner.clientHeight,
              noHorizontalOverflow: owner.scrollWidth <= owner.clientWidth + 1,
              inactiveHidden: [...document.querySelectorAll<HTMLElement>(".rail-body[hidden]")].every((node) => getComputedStyle(node).display === "none"),
            };
          }, placement);
          const label = `${mode}/${placement}/${width}`;
          assert.equal(measured.gutter, mode === "page" && width > 700 ? 24 : 12, label);
          assert.equal(measured.rootPadding, "0px", label);
          assert.equal(measured.rootMargin, "0px", label);
          assert.equal(measured.rootBorder, "0px", label);
          assert.equal(measured.rootBackground, "rgba(0, 0, 0, 0)", label);
          assert.ok(measured.inheritedFont, label);
          assert.ok(measured.scrollable, label);
          assert.ok(measured.noHorizontalOverflow, label);
          assert.ok(measured.inactiveHidden, label);
        }
      }
    }
  });
}

test("Markets navigation does not reskin the shared Button", { skip: !CHROME }, async () => {
  assert.ok(page);
  for (const fontSize of [15, 20]) {
    await page.setContent(`
      <style>${styles()}:root { --ui-font-size:${fontSize}px; --ui-font-scale:${fontSize / 15}; }</style>
      <button id="reference" class="ui-btn ui-btn--quiet ui-btn--sm"><span class="ui-btn-label">Reference</span></button>
      <div class="markets-surface-frame" style="width:320px">
        <nav class="markets-surface-nav" aria-label="Sections">
          <button id="navigation" class="ui-btn ui-btn--quiet ui-btn--sm" aria-current="page"><span class="ui-btn-label">Overview</span></button>
        </nav>
      </div>
    `);
    const buttons: { reference: Record<string, string>; navigation: Record<string, string> } = await page.evaluate(() => {
      const properties = ["fontSize", "borderRadius", "paddingLeft", "paddingRight", "minHeight", "backgroundColor", "borderTopColor"] as const;
      const capture = (id: string) => {
        const style = getComputedStyle(document.getElementById(id)!);
        return Object.fromEntries(properties.map((property) => [property, style[property]]));
      };
      return { reference: capture("reference"), navigation: capture("navigation") };
    });
    assert.deepEqual(buttons.navigation, buttons.reference);
  }
});
