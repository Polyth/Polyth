// Browser-level design contract, not screenshots of fully connected packages.
// Load every package stylesheet in both orders to catch late-loaded CSS drift.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

const CHROME = await findChromiumExecutable();
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
  const { chromium } = await import("playwright-core");
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
      <style>${styles()}:root { --ui-font-size:${fontSize}px; }</style>
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

test("compact Chat Workspace keeps navigation visible without clipping touch controls", { skip: !CHROME }, async () => {
  assert.ok(browser);
  for (const hasTouch of [false, true]) {
    const target = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch });
    await target.route("**/*", (route) => route.abort());
    try {
      for (const width of [360, 420, 421, 680]) {
        await target.setContent(`
          <style>${styles()}</style>
          <section class="chat-workspace" style="width:${width}px;height:500px">
            <div class="chat-workspace-tabstrip">
              <div class="chat-workspace-tabstrip-scroll"><button class="chat-workspace-tab">Chat</button></div>
              <button class="chat-workspace-tab-active-dropdown">Active chat</button>
              <button class="ui-btn ui-btn--quiet ui-btn--sm">New</button>
            </div>
            <div class="chat-workspace-viewport"></div>
            <div class="chat-workspace-dock">
              <span class="chat-workspace-dock-summary">Summary</span>
              <button class="ui-btn ui-btn--quiet ui-btn--sm">Send</button>
            </div>
          </section>
        `);
        const geometry = await target.evaluate(() => {
          const find = (selector: string) => document.querySelector<HTMLElement>(selector)!;
          const visible = (selector: string) => getComputedStyle(find(selector)).display !== "none";
          return {
            compactVisible: visible(".chat-workspace-tab-active-dropdown"),
            tabsVisible: visible(".chat-workspace-tab"),
            strip: find(".chat-workspace-tabstrip").getBoundingClientRect().height,
            dock: find(".chat-workspace-dock").getBoundingClientRect().height,
            button: find(".chat-workspace-dock .ui-btn").getBoundingClientRect().height,
            overflow: find(".chat-workspace").scrollWidth > find(".chat-workspace").clientWidth,
          };
        });
        assert.equal(geometry.compactVisible, width <= 420);
        assert.equal(geometry.tabsVisible, width > 420);
        assert.ok(geometry.strip >= (hasTouch ? 44 : 32));
        assert.ok(geometry.dock >= geometry.button);
        assert.equal(geometry.overflow, false);
      }
    } finally {
      await target.close();
    }
  }
});
