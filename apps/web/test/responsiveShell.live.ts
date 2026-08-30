// Live Chromium gate for the current responsive shell.
// Run against the isolated fixture created by a390FixtureSetup.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const BASE = need("POLYTH_LIVE_URL").replace(/\/$/, "");
const PROJECT = need("POLYTH_LIVE_PROJECT_ID");
const S_LOADED = need("POLYTH_LIVE_SESSION_LOADED");
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? "/tmp/polyth-responsive-artifacts";
const PERSONA_SEED = JSON.stringify({ persona: "engineer", plugins: [] });
const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/local/bin/google-chrome",
];

async function chromiumPath(): Promise<string> {
  const candidates = process.env.POLYTH_CHROMIUM_PATH
    ? [process.env.POLYTH_CHROMIUM_PATH]
    : CHROMIUM_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through known install locations.
    }
  }
  throw new Error("No Chromium executable found; set POLYTH_CHROMIUM_PATH");
}

let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  const playwright = await import("playwright-core");
  browser = await playwright.chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
  });
});

after(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
});

async function openApp(width: number, path: string, ready: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    hasTouch: width <= 480,
  });
  contexts.push(context);
  await context.addInitScript(({ persona, setupKey }: { persona: string; setupKey: string }) => {
    localStorage.setItem("polyth.prefs", persona);
    localStorage.setItem(setupKey, "completed");
  }, {
    persona: PERSONA_SEED,
    setupKey: `polyth.projectSetup.v1.${PROJECT}`,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(ready, { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(150);
  return page;
}

async function closePage(page: Page): Promise<void> {
  await page.context().close();
  contexts.splice(contexts.indexOf(page.context()), 1);
}

interface BoxReport {
  name: string;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const boxesOf = (page: Page, selector: string): Promise<BoxReport[]> =>
  page.locator(selector).evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    }));

function assertTouchTargets(boxes: BoxReport[], context: string): void {
  assert.ok(boxes.length > 0, `${context}: no controls found`);
  for (const box of boxes) {
    assert.ok(
      box.width >= 44 && box.height >= 44,
      `${context}: ${box.name} is ${box.width.toFixed(1)}×${box.height.toFixed(1)}, needs 44×44`,
    );
  }
}

test("390px and 1280px shells render the current navigation contracts", async () => {
  const geometry: Record<string, unknown> = {};
  for (const width of [390, 1280]) {
    const page = await openApp(width, `/p/${PROJECT}/s/${S_LOADED}`, ".timeline .msg");
    const documentOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(documentOverflow <= 1, `${width}px document overflows by ${documentOverflow}px`);

    if (width === 390) {
      await page.waitForSelector(".mobile-session-floats", { state: "visible" });
      assert.equal(await page.locator(".header-actions").count(), 0, "phone shell hides the desktop Application menu");
      const floats = await boxesOf(page, ".mobile-session-floats > *");
      assertTouchTargets(floats, "390px floating three-segment bar");
      geometry.mobile = { floats, documentOverflow };
    } else {
      await page.waitForSelector(".view-switcher", { state: "visible" });
      assert.equal(await page.locator(".mobile-session-floats").count(), 0, "desktop does not render the phone floating bar");
      assert.equal(await page.locator(".mobile-shortcut-rail").count(), 0, "desktop renders the phone shortcut rail");
      geometry.desktop = {
        topRail: await boxesOf(page, ".view-switcher .view-icon"),
        documentOverflow,
      };
    }

    await page.screenshot({ path: join(ARTIFACTS, `fix_redesign_final_shell_${width}.png`) });
    await closePage(page);
  }
  await writeFile(join(ARTIFACTS, "fix_redesign_final_geometry.json"), JSON.stringify(geometry, null, 2));
});

test("top rail and bottom bar open their current destinations", async () => {
  const page = await openApp(390, `/p/${PROJECT}/s/${S_LOADED}`, ".timeline .msg");

  const files = page.locator('.mobile-shortcut[aria-label="Project files"]');
  await files.click();
  await page.waitForSelector('.rail-fullscreen[aria-label="Project files"]', { state: "visible" });
  assert.equal(await files.getAttribute("aria-current"), "page");
  await page.click('.rail-fullscreen[aria-label="Project files"] button[aria-label="Close panel"]');
  await page.waitForSelector('.rail-fullscreen[aria-label="Project files"]', { state: "hidden" });

  const notifications = page.locator('.mobile-shortcut[aria-label="Notifications"]');
  await notifications.click();
  await page.waitForSelector('.panel-sheet[aria-label="Notifications"]', { state: "visible" });
  assert.equal(await page.locator(".panel-sheet .sheet-strip").count(), 0, "panel sheet does not duplicate the main navigation rail");
  await page.click('.panel-sheet[aria-label="Notifications"] button[aria-label="Close panel"]');
  await page.waitForSelector('.panel-sheet[aria-label="Notifications"]', { state: "hidden" });

  await page.click(".session-nav-current");
  await page.waitForSelector("#polyth-session-drawer.sidebar.open", { state: "visible" });
  assert.equal(await page.locator("#polyth-session-drawer").getAttribute("aria-modal"), "true");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#polyth-session-drawer")?.classList.contains("open"));
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("session-nav-current")), true);

  await page.getByRole("button", { name: "Command palette" }).click();
  await page.waitForSelector('[role="dialog"][aria-label="Search workspace"]', { state: "visible" });
  await page.keyboard.press("Escape");
  await closePage(page);
});

test("mobile shortcut settings support touch and keyboard sorting", async () => {
  const page = await openApp(390, `/p/${PROJECT}/s/${S_LOADED}`, ".timeline .msg");
  await page.click(".mobile-shortcut-settings");
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "visible" });
  // Package onboarding is scheduled after Settings mounts.
  await page.waitForTimeout(500);
  if (await page.locator(".package-tour").isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".package-tour", { state: "hidden" });
  }
  await page.getByRole("button", { name: "Widgets & Layout", exact: true }).click();
  await page.waitForTimeout(300);
  if (await page.locator(".package-tour-scrim").isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await page.waitForSelector(".package-tour-scrim", { state: "hidden" });
  }
  const card = page.locator('[data-settings-item="widgets.mobileShortcuts"]');
  await card.waitFor({ state: "visible" });

  const selectedIds = await card.locator("[data-widget-order-id]:not(.hidden)").evaluateAll((chips) =>
    chips.map((chip) => (chip as HTMLElement).dataset.widgetOrderId!));
  assert.ok(selectedIds.length >= 2, "fixture needs at least two selected shortcuts");

  const source = card.locator(`[data-widget-order-id="${selectedIds[1]}"] .widget-drag-handle`);
  const target = card.locator(`[data-widget-order-id="${selectedIds[0]}"]`);
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  assert.ok(sourceBox && targetBox, "touch sort endpoints are not visible");
  for (const box of [sourceBox!, targetBox!]) {
    assert.ok(box.y >= 0 && box.y + box.height <= 900, "touch sort endpoint is outside the viewport");
  }
  const sourceHit = await page.evaluate(({ x, y }: { x: number; y: number }) => {
    const hit = document.elementFromPoint(x, y);
    return {
      label: hit?.closest(".widget-drag-handle")?.getAttribute("aria-label") ?? null,
      description: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : "none",
    };
  }, {
    x: sourceBox!.x + sourceBox!.width / 2,
    y: sourceBox!.y + sourceBox!.height / 2,
  });
  assert.match(
    sourceHit.label ?? "",
    /^Reorder /,
    `touch starts outside the reorder handle (${sourceHit.description}; box=${JSON.stringify(sourceBox)})`,
  );
  await page.evaluate(() => {
    const events: string[] = [];
    (window as typeof window & { __polythPointerEvents?: string[] }).__polythPointerEvents = events;
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      document.addEventListener(type, (event) => {
        const pointer = event as PointerEvent;
        events.push(`${type}:${pointer.pointerType}:${pointer.isPrimary}`);
      }, { capture: true });
    }
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 }],
  });
  await page.waitForTimeout(450);
  const dragStarted = await page.evaluate((id: string) => ({
    dragging: document.querySelector(`[data-widget-order-id="${id}"]`)?.classList.contains("dragging") === true,
    events: (window as typeof window & { __polythPointerEvents?: string[] }).__polythPointerEvents ?? [],
  }), selectedIds[1]!);
  assert.ok(dragStarted.dragging, `long press did not start dragging; events=${dragStarted.events.join(",")}`);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{
      id: 1,
      x: (sourceBox!.x + targetBox!.x) / 2,
      y: (sourceBox!.y + targetBox!.y) / 2,
    }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ id: 1, x: targetBox!.x + targetBox!.width / 2, y: targetBox!.y + targetBox!.height / 2 }],
  });
  await card.locator(`[data-widget-order-id="${selectedIds[0]}"].drag-over`).waitFor({ state: "visible" });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  const cardSelector = '[data-settings-item="widgets.mobileShortcuts"]';
  await page.waitForFunction(
    ({ selector, first }: { selector: string; first: string }) =>
      document.querySelector(`${selector} [data-widget-order-id]:not(.hidden)`)?.getAttribute("data-widget-order-id") === first,
    { selector: cardSelector, first: selectedIds[1]! },
  );

  const firstHandle = card.locator("[data-widget-order-id]:not(.hidden) .widget-drag-handle").first();
  await firstHandle.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    ({ selector, first }: { selector: string; first: string }) =>
      document.querySelector(`${selector} [data-widget-order-id]:not(.hidden)`)?.getAttribute("data-widget-order-id") === first,
    { selector: cardSelector, first: selectedIds[0]! },
  );

  const controls = await boxesOf(page, `${cardSelector} button, ${cardSelector} input`);
  assertTouchTargets(controls, "mobile shortcut settings");
  await page.screenshot({ path: join(ARTIFACTS, "fix_redesign_final_sorting_390.png") });
  await closePage(page);
});
