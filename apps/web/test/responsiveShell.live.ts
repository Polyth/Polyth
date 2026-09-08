// Live Chromium gate for the current responsive shell.
// Run against the isolated fixture created by a390FixtureSetup.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { COMPACT_MAX_WIDTH } from "../src/responsiveShell.ts";

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

interface OpenOpts {
  /** Viewport height (default 900). */
  height?: number;
  /** Emulate a coarse primary pointer + touch input (default: width <= 480). */
  touch?: boolean;
}

async function openApp(width: number, path: string, ready: string, opts: OpenOpts = {}): Promise<Page> {
  const height = opts.height ?? 900;
  const touch = opts.touch ?? width <= 480;
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    hasTouch: touch,
  });
  contexts.push(context);
  await context.addInitScript((persona: string) => {
    localStorage.setItem("polyth.prefs", persona);
  }, PERSONA_SEED);
  const page = await context.newPage();
  if (touch) {
    // Playwright's hasTouch does not flip the pointer/hover media features; the
    // shell's `--hit-min` floor and the coarse-only rules key off those.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [
        { name: "pointer", value: "coarse" },
        { name: "any-pointer", value: "coarse" },
        { name: "hover", value: "none" },
        { name: "any-hover", value: "none" },
      ],
    });
  }
  await page.goto(`${BASE}${path}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(ready, { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(150);
  return page;
}

// ---- tablet shell geometry (PR #141) -------------------------------------
// The compact/wide seam is COMPACT_MAX_WIDTH (960). At/below it the navigator
// is a modal drawer with zero layout width; one pixel above it the persistent
// navigator and the idle floating launcher cluster enter flow. This is a shell
// transition, not a continuous ramp — the assertions below check that BOTH
// sides are intentionally usable, not that the seam is smooth.

const COMPACT = COMPACT_MAX_WIDTH;
/** Smallest primary workspace the persistent-nav shell is allowed to hand to
 *  the first wide width. Rendered ~621px at COMPACT+1 with the default 332px
 *  navigator; 560 leaves headroom for narrower user nav widths / rounding. */
const WORKSPACE_FLOOR = 560;

interface ShellGeometry {
  width: number;
  height: number;
  documentOverflow: number;
  navigatorLayoutWidth: number;
  navigatorDrawer: boolean;
  workspaceWidth: number;
  timelineContentWidth: number | null;
  composerWidth: number | null;
  timelinePadLeft: string | null;
  timelinePadRight: string | null;
  composerPadLeft: string | null;
  railbarOpen: boolean;
  railbar: { top: number; bottom: number; left: number; right: number; width: number; height: number } | null;
  appShell: { top: number; bottom: number; left: number; right: number } | null;
  railWithinShell: boolean | null;
  railWithinViewport: boolean | null;
  conversationClearsRail: boolean | null;
  stripScrollable: boolean | null;
}

const readShellGeometry = (page: Page): Promise<ShellGeometry> =>
  page.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const de = document.documentElement;
    const sidebar = q(".sidebar") as HTMLElement | null;
    const sbBox = sidebar?.getBoundingClientRect();
    const sbStyle = sidebar ? getComputedStyle(sidebar) : null;
    const drawer = !sidebar
      || sbStyle!.visibility === "hidden"
      || sbStyle!.position === "fixed"
      || (sbBox!.width < 1);
    const navigatorLayoutWidth = drawer ? 0 : (sbBox?.width ?? 0);
    const ws = q(".workspace");
    const tl = q(".timeline");
    const tlStyle = tl ? getComputedStyle(tl) : null;
    const msg = tl?.querySelector(".msg, .bubble, .turn, .md-para");
    const comp = q(".composer-chat") ?? q(".composer");
    const compStyle = comp ? getComputedStyle(comp) : null;
    const railbar = q(".railbar");
    const strip = q(".railbar .rail-icon-col.plugin-strip") ?? q(".railbar .plugin-strip");
    const rbBox = box(railbar);
    const asBox = box(q(".app-shell"));
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      documentOverflow: de.scrollWidth - de.clientWidth,
      navigatorLayoutWidth: Math.round(navigatorLayoutWidth),
      navigatorDrawer: drawer,
      workspaceWidth: ws ? Math.round(ws.getBoundingClientRect().width) : 0,
      timelineContentWidth: msg ? Math.round(msg.getBoundingClientRect().width) : null,
      composerWidth: comp ? Math.round(comp.getBoundingClientRect().width) : null,
      timelinePadLeft: tlStyle?.paddingLeft ?? null,
      timelinePadRight: tlStyle?.paddingRight ?? null,
      composerPadLeft: compStyle?.paddingLeft ?? null,
      railbarOpen: !!q(".railbar.railbar-open"),
      railbar: rbBox && { top: Math.round(rbBox.top), bottom: Math.round(rbBox.bottom), left: Math.round(rbBox.left), right: Math.round(rbBox.right), width: Math.round(rbBox.width), height: Math.round(rbBox.height) },
      appShell: asBox && { top: Math.round(asBox.top), bottom: Math.round(asBox.bottom), left: Math.round(asBox.left), right: Math.round(asBox.right) },
      railWithinShell: rbBox && asBox ? (rbBox.top >= asBox.top - 1 && rbBox.bottom <= asBox.bottom + 1 && rbBox.right <= asBox.right + 1 && rbBox.left >= asBox.left - 1) : null,
      railWithinViewport: rbBox ? (rbBox.top >= -1 && rbBox.bottom <= window.innerHeight + 1) : null,
      conversationClearsRail: (msg && railbar) ? (msg.getBoundingClientRect().right <= railbar.getBoundingClientRect().left + 0.5) : null,
      stripScrollable: strip ? strip.scrollHeight > strip.clientHeight + 1 : null,
    };
  });

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

// ======================================================================
// Tablet shell geometry matrix (PR #141)
// ======================================================================

test("tablet width matrix: compact drawer <= seam, persistent nav + bounded launcher above it", async () => {
  const widths = [834, COMPACT - 1, COMPACT, COMPACT + 1, 1024, 1194, 1366];
  const record: Record<string, ShellGeometry> = {};

  for (const width of widths) {
    const page = await openApp(width, `/p/${PROJECT}/s/${S_LOADED}`, ".timeline .msg");
    const g = await readShellGeometry(page);
    record[String(width)] = g;

    assert.ok(g.documentOverflow <= 1, `${width}px: document overflows by ${g.documentOverflow}px`);

    if (width <= COMPACT) {
      assert.equal(g.navigatorDrawer, true, `${width}px: navigator must be a drawer at/below the seam`);
      assert.equal(g.navigatorLayoutWidth, 0, `${width}px: drawer navigator must not consume layout width`);
      assert.ok(
        g.workspaceWidth >= width - 4,
        `${width}px: compact workspace should span the shell (got ${g.workspaceWidth})`,
      );
      assert.ok(!g.railbarOpen, `${width}px: no rail surface open on load`);
    } else {
      assert.equal(g.navigatorDrawer, false, `${width}px: navigator must be persistent above the seam`);
      assert.ok(
        g.navigatorLayoutWidth >= 260,
        `${width}px: persistent navigator width looks wrong (${g.navigatorLayoutWidth})`,
      );
      assert.ok(
        g.workspaceWidth >= WORKSPACE_FLOOR,
        `${width}px: primary workspace ${g.workspaceWidth}px is below the ${WORKSPACE_FLOOR}px floor — the seam is placed too low`,
      );
      // Idle launcher cluster: bounded, inside the shell, clear of the conversation.
      assert.ok(g.railbar, `${width}px: no .railbar`);
      assert.equal(g.railWithinShell, true, `${width}px: idle launcher escaped .app-shell (${JSON.stringify(g.railbar)})`);
      assert.equal(g.railWithinViewport, true, `${width}px: idle launcher escaped the viewport`);
      assert.ok(
        g.railbar!.height <= (g.appShell!.bottom - g.appShell!.top) * 0.98,
        `${width}px: idle launcher is full-height (${g.railbar!.height}) — it must be a bounded cluster, not a column`,
      );
      assert.equal(g.conversationClearsRail, true, `${width}px: conversation content renders under the floating launcher`);
      assert.equal(
        g.timelinePadLeft, g.composerPadLeft,
        `${width}px: timeline and composer left edges are not aligned (${g.timelinePadLeft} vs ${g.composerPadLeft})`,
      );
    }

    await page.screenshot({ path: join(ARTIFACTS, `tablet_shell_${width}.png`) });
    await closePage(page);
  }

  await writeFile(join(ARTIFACTS, "tablet_shell_geometry.json"), JSON.stringify({ seam: COMPACT, record }, null, 2));

  // Explicit before/after evidence for the seam itself: a real shell transition,
  // both sides usable. Not asserted continuous.
  const below = record[String(COMPACT)]!;
  const above = record[String(COMPACT + 1)]!;
  assert.equal(below.navigatorDrawer, true, "seam-: drawer navigator");
  assert.equal(above.navigatorDrawer, false, "seam+: persistent navigator");
  assert.ok(below.workspaceWidth > above.workspaceWidth, "seam+: workspace is narrower once the navigator takes flow");
  assert.ok(above.workspaceWidth >= WORKSPACE_FLOOR, `seam+: workspace ${above.workspaceWidth}px must stay usable`);
});

// ======================================================================
// keepAlive: mounted != open, in the real DOM (PR #141)
// ======================================================================

test("keepAlive surface stays mounted-but-hidden after close; idle tablet rail returns", async () => {
  const page = await openApp(1180, `/p/${PROJECT}/s/${S_LOADED}`, ".timeline .msg");

  const idle = () => readShellGeometry(page);
  const railState = () => page.evaluate(() => {
    const nodes = [...document.querySelectorAll(".rail:not(.railbar)")];
    return {
      count: nodes.length,
      hidden: nodes.filter((n) => getComputedStyle(n).display === "none").length,
      railbarOpen: !!document.querySelector(".railbar.railbar-open"),
      // does anything under a hidden .rail sit over the conversation centre?
      pointerAtConversationCentre: (() => {
        const tl = document.querySelector(".timeline");
        if (!tl) return null;
        const r = tl.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return el?.closest(".rail:not(.railbar)") ? "intercepted-by-hidden-rail" : "conversation";
      })(),
    };
  });

  const openLauncher = async (id: string) => {
    const btn = page.locator(`.railbar [data-pane-launcher="${id}"]`).first();
    await btn.waitFor({ state: "visible", timeout: 10_000 });
    await btn.click();
    await page.waitForSelector(".railbar.railbar-open", { timeout: 10_000 });
    await page.waitForTimeout(400);
  };
  const closePane = async () => {
    const close = page.locator('.rail:not(.railbar) button[aria-label="Close panel"], .rail:not(.railbar) button[aria-label*="close" i]').first();
    await close.click();
    await page.waitForSelector(".railbar.railbar-open", { state: "detached", timeout: 10_000 }).catch(async () => {
      await page.waitForFunction(() => !document.querySelector(".railbar.railbar-open"), undefined, { timeout: 10_000 });
    });
    await page.waitForTimeout(400);
  };

  // 1. idle
  let s = await railState();
  assert.equal(s.railbarOpen, false, "start: rail closed");
  const idle0 = await idle();
  assert.equal(idle0.railWithinShell, true, "start: idle launcher bounded inside the shell");

  // 2. open a keepAlive surface (Usage — keepAlive, in the strip, no PTY side effects)
  await openLauncher("usage");
  s = await railState();
  assert.equal(s.railbarOpen, true, "opened: .railbar-open present");
  assert.ok(s.count >= 1, "opened: a .rail surface is mounted");

  // 3. close — keepAlive node persists, hidden; shell state is closed again
  await closePane();
  s = await railState();
  assert.equal(s.railbarOpen, false, "closed: .railbar-open is gone (mounted != open)");
  assert.ok(s.count >= 1, "closed: the keepAlive .rail node is still mounted");
  assert.equal(s.hidden, s.count, "closed: every retained .rail node is display:none");
  assert.equal(s.pointerAtConversationCentre, "conversation", "closed: the hidden pane does not intercept pointer input");
  const idle1 = await idle();
  assert.equal(idle1.railWithinShell, true, "closed: the idle floating launcher returned inside the shell");
  assert.ok(idle1.documentOverflow <= 1, "closed: no horizontal overflow after the hidden pane is retained");
  assert.equal(
    idle1.timelinePadRight, idle0.timelinePadRight,
    "closed: the reserved launcher lane is restored to its idle width",
  );

  // 4. reopen the same surface (its node is reused, not remounted), switch to
  //    another surface, then close. Whatever keep-alive nodes were visited stay
  //    retained and hidden; the shell still reads closed.
  await openLauncher("usage");
  assert.equal((await railState()).railbarOpen, true, "reopened: .railbar-open present again");
  await openLauncher("knowledge");
  assert.equal((await railState()).railbarOpen, true, "switched: still open on the new surface");
  await closePane();
  s = await railState();
  assert.equal(s.railbarOpen, false, "final close: shell reads closed after a reopen + surface switch");
  assert.ok(s.count >= 1, "final close: the visited keep-alive node(s) remain mounted");
  assert.equal(s.hidden, s.count, "final close: every retained .rail node is display:none");
  assert.equal((await idle()).railWithinShell, true, "final close: idle floating launcher back inside the shell");

  await page.screenshot({ path: join(ARTIFACTS, "tablet_keepalive_after_close.png") });
  await closePage(page);
});

// ======================================================================
// Tablet touch: effective hit areas on the floating launcher + drawer (PR #141)
// ======================================================================

test("tablet coarse pointer: launcher, drawer and pane controls have >= 44x44 hit areas", async () => {
  const page = await openApp(1194, `/p/${PROJECT}/s/${S_LOADED}`, ".timeline .msg", { height: 834, touch: true });

  // Effective hit area = union of the button box and its ::after hit extension.
  const hitAreas = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".railbar .plugin-strip .capability-launcher, .railbar .plugin-strip .strip-btn, .railbar .rail-icon-col .rail-icon")];
    return btns.map((el) => {
      const r = el.getBoundingClientRect();
      const after = getComputedStyle(el, "::after");
      const aw = after.content && after.content !== "none" ? parseFloat(after.width) : 0;
      const ah = after.content && after.content !== "none" ? parseFloat(after.height) : 0;
      return {
        label: el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "?",
        w: Math.max(r.width, Number.isFinite(aw) ? aw : 0),
        h: Math.max(r.height, Number.isFinite(ah) ? ah : 0),
      };
    });
  });
  assert.ok(hitAreas.length >= 3, "expected a populated floating launcher");
  for (const b of hitAreas) {
    assert.ok(b.w >= 44 && b.h >= 44, `launcher "${b.label}" effective hit area is ${b.w.toFixed(1)}x${b.h.toFixed(1)}, needs 44x44`);
  }

  // The bounded cluster scrolls with touch: fling it and check scrollTop moved
  // (only meaningful when it actually overflows — it does at 834px height here).
  const stripHandle = page.locator(".railbar .plugin-strip").first();
  const overflowed = await stripHandle.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  if (overflowed) {
    const strip = await stripHandle.boundingBox();
    assert.ok(strip, "strip not visible");
    const cx = strip!.x + strip!.width / 2;
    await page.mouse.move(cx, strip!.y + strip!.height - 12);
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(200);
    const scrolled = await stripHandle.evaluate((el) => el.scrollTop);
    assert.ok(scrolled > 0, "the bounded launcher cluster did not scroll when it overflows");
  }

  // Open a pane and check its header controls are touch-sized. The visible
  // glyph stays compact (24px) — the `::after` hit extension is what must reach
  // the --hit-min (44px) floor on a coarse pointer.
  await page.locator('.railbar [data-pane-launcher="usage"]').first().click();
  await page.waitForSelector(".railbar.railbar-open");
  await page.waitForTimeout(300);
  const paneHits = await page.evaluate(() => {
    const els = [...document.querySelectorAll(
      '.rail:not(.railbar) button[aria-label="Close panel"], .rail:not(.railbar) button[aria-label*="pin" i], .rail:not(.railbar) button[aria-label*="fullscreen" i]',
    )];
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      const a = getComputedStyle(el, "::after");
      const aw = a.content && a.content !== "none" ? parseFloat(a.width) : 0;
      const ah = a.content && a.content !== "none" ? parseFloat(a.height) : 0;
      return {
        label: el.getAttribute("aria-label"),
        w: Math.max(r.width, Number.isFinite(aw) ? aw : 0),
        h: Math.max(r.height, Number.isFinite(ah) ? ah : 0),
      };
    });
  });
  assert.ok(paneHits.length >= 1, "expected pane header controls");
  for (const c of paneHits) {
    assert.ok(c.w >= 44 && c.h >= 44, `pane control "${c.label}" effective hit area is ${c.w.toFixed(1)}x${c.h.toFixed(1)}, needs 44x44`);
  }

  await page.screenshot({ path: join(ARTIFACTS, "tablet_touch_1194x834.png") });
  await closePage(page);
});

// ======================================================================
// Tablet + short viewport: many launcher tools scroll, never escape (PR #141)
// ======================================================================

test("tablet width, short viewport: idle launcher stays inside the shell and scrolls", async () => {
  // Very short heights so the seeded fixture's ~14-entry launcher cannot fit
  // even after the cluster shrinks to its max-height — it must scroll, not grow.
  for (const [width, height] of [[1024, 500], [1194, 460]] as const) {
    const page = await openApp(width, `/p/${PROJECT}/s/${S_LOADED}`, ".timeline .msg", { height });
    await page.waitForTimeout(400); // let the bounded cluster settle to max-height
    const g = await readShellGeometry(page);
    const strip = await page.locator(".railbar .rail-icon-col.plugin-strip, .railbar .plugin-strip").first()
      .evaluate((el) => ({ overflowY: getComputedStyle(el).overflowY, scrollH: el.scrollHeight, clientH: el.clientHeight }));

    assert.ok(g.documentOverflow <= 1, `${width}x${height}: document overflow ${g.documentOverflow}px`);
    assert.ok(g.railbar, `${width}x${height}: no .railbar`);
    assert.equal(g.railWithinViewport, true, `${width}x${height}: launcher escaped the viewport (${JSON.stringify(g.railbar)})`);
    assert.equal(g.railWithinShell, true, `${width}x${height}: launcher escaped .app-shell`);
    assert.ok(
      g.railbar!.top >= g.appShell!.top - 1 && g.railbar!.bottom <= g.appShell!.bottom + 1,
      `${width}x${height}: launcher top/bottom outside .app-shell`,
    );
    // Structural: the strip is always a scroll container...
    assert.equal(strip.overflowY, "auto", `${width}x${height}: launcher strip must be a scroll container`);
    // ...and at this height the fixture's tools genuinely overflow it, so it
    // scrolls rather than pushing icons off-screen.
    assert.ok(
      strip.scrollH > strip.clientH + 1,
      `${width}x${height}: strip should overflow-and-scroll (scrollHeight ${strip.scrollH} <= clientHeight ${strip.clientH}) — no icon becomes unreachable`,
    );

    await page.screenshot({ path: join(ARTIFACTS, `tablet_short_${width}x${height}.png`) });
    await closePage(page);
  }
});
