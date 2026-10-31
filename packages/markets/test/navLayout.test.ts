// Real layout check for the Markets section switcher. It renders the actual
// MarketSurfaceNav component with the real core + package CSS in Chromium and
// measures geometry: the strip must scroll itself at narrow widths, every
// section must be reachable, and the page must not scroll horizontally. The
// shared primitive's containment/affordance behavior (hidden scrollbar, inline
// overscroll containment, touch panning, edge fade) is asserted because that is
// what the nav now depends on. It does not restate class names as strings.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

register("./tsxHooks.mjs", import.meta.url);
const { MarketSurfaceNav, MARKET_SECTION_LINKS } = await import("../widgets/MarketSurfaceNav.tsx");

const CHROME = await findChromiumExecutable();
const css = [
  "../../../apps/web/src/tokens.css",
  "../../../apps/web/src/styles.css",
  "../../../apps/web/src/moduleContent.css",
  "../widgets/surfaceFrame.css",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");

/** Mirrors the host Button contract (apps/web/src/components/ui/Button.tsx)
 *  closely enough to exercise the strip's real layout. */
function ButtonStub(props: Record<string, unknown>) {
  const { variant = "ghost", children, onClick, size, ...rest } = props as {
    variant?: string;
    children?: ReactNode;
    onClick?: () => void;
    size?: string;
  };
  void onClick;
  void size;
  return createElement(
    "button",
    { type: "button", className: `ui-btn ui-btn--${variant} ui-btn--sm`, ...rest },
    createElement("span", { className: "ui-btn-label" }, children),
  );
}

const host = {
  ui: { components: { Button: ButtonStub } },
  navigation: { openWorkspacePane: () => {} },
};

const navHtml = renderToStaticMarkup(
  createElement(MarketSurfaceNav, { host: host as never, activeId: "markets" }),
);

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
  page = await browser.newPage({ viewport: { width: 360, height: 800 } });
});

after(async () => {
  await browser?.close();
});

const NARROW_WIDTHS = [300, 340, 360];
/** Product invariant: the Markets frame exposes exactly these ten sections. */
const EXPECTED_SECTION_COUNT = 10;

test("markets section nav scrolls its own strip and every section stays reachable", { skip: !CHROME }, async () => {
  assert.ok(page);
  for (const width of NARROW_WIDTHS) {
    const label = `${width}px`;
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head>`
      + `<body style="margin:0"><div class="markets-surface-frame" style="width:${width}px">${navHtml}</div></body></html>`,
    );
    const nav = page.locator(".markets-surface-nav");
    await nav.waitFor();
    const result = await nav.evaluate((el) => {
      const style = getComputedStyle(el);
      const navRect = el.getBoundingClientRect();
      const tabs = [...el.querySelectorAll("button")];
      const unreachable: number[] = [];
      for (const [index, tab] of tabs.entries()) {
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
        const rect = tab.getBoundingClientRect();
        if (rect.left < navRect.left - 1 || rect.right > navRect.right + 1) unreachable.push(index);
      }
      el.scrollLeft = 0;
      const scrolling = document.scrollingElement;
      return {
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        overflowX: style.overflowX,
        overscrollBehaviorInline: style.overscrollBehaviorInline || style.overscrollBehaviorX,
        touchAction: style.touchAction,
        scrollbarWidth: style.scrollbarWidth,
        maskImage: style.maskImage || style.webkitMaskImage,
        tabCount: tabs.length,
        labels: tabs.map((tab) => tab.textContent?.trim() ?? ""),
        unreachable,
        pageScrollsHorizontally: scrolling !== null && scrolling.scrollWidth > scrolling.clientWidth,
      };
    });

    assert.equal(result.tabCount, EXPECTED_SECTION_COUNT, `${label}: all ten sections render`);
    assert.equal(
      result.tabCount,
      MARKET_SECTION_LINKS.length,
      `${label}: the rendered strip maps every declared section`,
    );
    assert.deepEqual(
      result.labels,
      MARKET_SECTION_LINKS.map((link) => link.label),
      `${label}: rendered labels follow the declared registry`,
    );
    assert.ok(result.scrollWidth > result.clientWidth, `${label}: the strip must overflow so it can scroll`);
    assert.ok(
      result.overflowX === "auto" || result.overflowX === "scroll",
      `${label}: the strip owns horizontal scrolling, got overflow-x: ${result.overflowX}`,
    );
    assert.equal(result.pageScrollsHorizontally, false, `${label}: the page must not scroll horizontally`);
    assert.deepEqual(result.unreachable, [], `${label}: every section must scroll fully into view`);
    assert.equal(result.scrollbarWidth, "none", `${label}: the scrollbar stays hidden`);
    assert.equal(result.overscrollBehaviorInline, "contain", `${label}: inline overscroll is contained`);
    assert.equal(result.touchAction, "pan-x", `${label}: touch panning is limited to the strip`);
    assert.match(result.maskImage, /gradient/, `${label}: the edge fade affordance is present`);
  }
});
