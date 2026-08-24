// UX-A390 live geometry and interaction gate for the responsive Ember shell.
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --test apps/web/test/responsiveShell.live.ts
//
// It drives a real Chromium against a live, isolated, synthetic Polyth
// runtime (see apps/web/test/a390FixtureSetup.mjs) — never a static mockup
// and never a shared/production data dir.
//
// Required environment:
//   POLYTH_LIVE_URL              isolated runtime origin, e.g. http://127.0.0.1:4453
//   POLYTH_LIVE_PROJECT_ID       synthetic fixture project id
//   POLYTH_LIVE_SESSION_EMPTY    zero-message session id
//   POLYTH_LIVE_SESSION_LOADED   multi-turn session id
//   POLYTH_LIVE_SESSION_WORKING  open-turn (working) session id
// Optional:
//   POLYTH_CHROMIUM_PATH         Chromium executable (well-known paths otherwise)
//   POLYTH_LIVE_ARTIFACTS        directory for screenshots + geometry JSON
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

// ---- environment -----------------------------------------------------------

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is required. Run apps/web/test/a390FixtureSetup.mjs, start the isolated runtime it describes, and export the printed variables.`,
    );
  }
  return v;
};

const BASE = need("POLYTH_LIVE_URL").replace(/\/$/, "");
const PROJECT = need("POLYTH_LIVE_PROJECT_ID");
const S_EMPTY = need("POLYTH_LIVE_SESSION_EMPTY");
const S_LOADED = need("POLYTH_LIVE_SESSION_LOADED");
const S_WORKING = need("POLYTH_LIVE_SESSION_WORKING");
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? "/tmp/polyth-a390-artifacts";

const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

async function chromiumPath(): Promise<string> {
  const candidates = process.env.POLYTH_CHROMIUM_PATH
    ? [process.env.POLYTH_CHROMIUM_PATH]
    : CHROMIUM_CANDIDATES;
  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  throw new Error("No Chromium executable found; set POLYTH_CHROMIUM_PATH.");
}

// ---- browser lifecycle -----------------------------------------------------

let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  const pw = await import("playwright-core");
  browser = await pw.chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
  });
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
});

interface OpenOpts {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  reducedMotion?: "reduce" | "no-preference";
  /** app path, e.g. /p/<project>/s/<session> */
  path: string;
  /** extra localStorage entries seeded before the app boots */
  storage?: Record<string, string>;
  /** selector that must be visible before the page counts as ready */
  ready: string;
}

// Persona seed: skips first-run onboarding deterministically. plugins:[] fills
// from the persona defaults (prefs.ts parse contract).
const PERSONA_SEED = JSON.stringify({ persona: "engineer", plugins: [] });

async function openApp(opts: OpenOpts): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.deviceScaleFactor ?? 1,
    reducedMotion: opts.reducedMotion ?? "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  const storage = { "polyth.prefs": PERSONA_SEED, ...(opts.storage ?? {}) };
  await context.addInitScript((entries: Record<string, string>) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, storage);
  const page = await context.newPage();
  await page.goto(BASE + opts.path, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(opts.ready, { state: "visible", timeout: 15_000 });
  // One settle frame: replay + first layout.
  await page.waitForTimeout(120);
  return page;
}

// ---- geometry helpers ------------------------------------------------------

const SHELL_SELECTORS = [".app", ".workspace", ".header", ".main", ".composer", ".statusbar", ".panel-sheet", ".timeline"];

interface ControlBox {
  label: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  hitOk: boolean;
  hitDesc: string;
  /** Measured after scrolling it into view inside a scroll container. */
  scrolled: boolean;
}

interface GeometryReport {
  vw: number;
  vh: number;
  overflow: Array<{ sel: string; sw: number; cw: number }>;
  controls: ControlBox[];
}

function collectGeometry(page: Page, controls: Array<[string, string]>): Promise<GeometryReport> {
  return page.evaluate(
    ({ controls, shells }) => {
      const doc = document.documentElement;
      const out = {
        vw: window.innerWidth,
        vh: window.innerHeight,
        overflow: [{ sel: "documentElement", sw: doc.scrollWidth, cw: doc.clientWidth }],
        controls: [] as Array<{
          label: string; left: number; top: number; right: number; bottom: number;
          width: number; height: number; hitOk: boolean; hitDesc: string; scrolled: boolean;
        }>,
      };
      for (const sel of shells) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.display === "none") continue;
        out.overflow.push({ sel, sw: el.scrollWidth, cw: el.clientWidth });
      }
      for (const [label, sel] of controls) {
        const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
        els.forEach((el, i) => {
          let r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width <= 0 || r.height <= 0 || cs.display === "none" || cs.visibility === "hidden") return;
          // Controls inside a scroll container (e.g. the hero stage at short
          // heights) must be reachable by scrolling; fixed shell controls must
          // already sit inside the viewport. Scroll-then-measure, then restore.
          const outOfView = r.left < -0.5 || r.right > window.innerWidth + 0.5 || r.top < -0.5 || r.bottom > window.innerHeight + 0.5;
          let scroller: HTMLElement | null = null;
          if (outOfView) {
            for (let anc = el.parentElement; anc; anc = anc.parentElement) {
              const acs = getComputedStyle(anc);
              const scrollsY = (acs.overflowY === "auto" || acs.overflowY === "scroll") && anc.scrollHeight > anc.clientHeight + 1;
              const scrollsX = (acs.overflowX === "auto" || acs.overflowX === "scroll") && anc.scrollWidth > anc.clientWidth + 1;
              if (scrollsY || scrollsX) {
                scroller = anc;
                break;
              }
            }
          }
          const prevTop = scroller ? scroller.scrollTop : 0;
          const prevLeft = scroller ? scroller.scrollLeft : 0;
          if (scroller) {
            el.scrollIntoView({ block: "nearest", inline: "nearest" });
            r = el.getBoundingClientRect();
          }
          const cx = Math.min(Math.max(r.left + r.width / 2, 0), window.innerWidth - 0.01);
          const cy = Math.min(Math.max(r.top + r.height / 2, 0), window.innerHeight - 0.01);
          const hit = document.elementFromPoint(cx, cy);
          if (scroller) {
            scroller.scrollTop = prevTop;
            scroller.scrollLeft = prevLeft;
          }
          out.controls.push({
            label: els.length > 1 ? `${label}[${i}]` : label,
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            width: r.width, height: r.height,
            hitOk: hit !== null && (hit === el || el.contains(hit)),
            hitDesc: hit ? `${hit.tagName.toLowerCase()}.${(hit as HTMLElement).className}` : "none",
            scrolled: scroller !== null,
          });
        });
      }
      return out;
    },
    { controls, shells: SHELL_SELECTORS },
  ) as Promise<GeometryReport>;
}

function assertNoOverflow(report: GeometryReport, ctx: string): void {
  for (const o of report.overflow) {
    assert.ok(o.sw <= o.cw + 1, `${ctx}: ${o.sel} scrolls horizontally (scrollWidth ${o.sw} > clientWidth ${o.cw})`);
  }
}

function assertControlsInViewport(report: GeometryReport, ctx: string): void {
  for (const c of report.controls) {
    assert.ok(c.width > 0 && c.height > 0, `${ctx}: ${c.label} has a zero-size box`);
    assert.ok(c.left >= -0.5, `${ctx}: ${c.label} left ${c.left} < 0`);
    assert.ok(c.right <= report.vw + 0.5, `${ctx}: ${c.label} right ${c.right} > viewport ${report.vw}`);
    assert.ok(c.top >= -0.5, `${ctx}: ${c.label} top ${c.top} < 0`);
    assert.ok(c.bottom <= report.vh + 0.5, `${ctx}: ${c.label} bottom ${c.bottom} > viewport ${report.vh}`);
  }
}

function assertNoOverlap(report: GeometryReport, ctx: string): void {
  const cs = report.controls;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i]!;
      const b = cs[j]!;
      // Scrolled-into-view rects come from different scroll offsets of the
      // clipping container; comparing them pairwise is meaningless. Their
      // in-content layout is covered by reachability + center hit-testing.
      if (a.scrolled || b.scrolled) continue;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const area = Math.max(0, w) * Math.max(0, h);
      assert.ok(area < 0.5, `${ctx}: ${a.label} overlaps ${b.label} (${area.toFixed(1)}px²)`);
    }
  }
}

function assertHits(report: GeometryReport, ctx: string): void {
  for (const c of report.controls) {
    assert.ok(c.hitOk, `${ctx}: center of ${c.label} is covered by ${c.hitDesc}`);
  }
}

function assertTouchTargets(report: GeometryReport, labels: string[], ctx: string): void {
  for (const c of report.controls) {
    const base = c.label.replace(/\[\d+\]$/, "");
    if (!labels.includes(base)) continue;
    assert.ok(c.width >= 44 && c.height >= 44, `${ctx}: ${c.label} is ${c.width.toFixed(0)}×${c.height.toFixed(0)}, needs 44×44`);
  }
}

const present = (report: GeometryReport, label: string): boolean =>
  report.controls.some((c) => c.label === label || c.label.startsWith(`${label}[`));

// ---- state / control matrices ----------------------------------------------

type Mode = "wide" | "compact" | "phone";
const modeOf = (w: number): Mode => (w <= 480 ? "phone" : w <= 820 ? "compact" : "wide");

const COMPOSER_CONTROLS: Array<[string, string]> = [
  ["attach", ".composer-attach"],
  ["expand", ".composer-expand"],
  ["send", ".send"],
  ["stop", ".stop"],
];

const COMPACT_HEADER: Array<[string, string]> = [
  ["drawer", ".header-drawer-btn"],
  ["viewChip", ".header-view-picker .picker-chip"],
  ["autoAccept", ".auto-accept-chip"],
  ["overflow", ".overflow-trigger"],
  ["panels", ".narrow-panel-trigger"],
];

const WIDE_HEADER: Array<[string, string]> = [
  ["viewIcon", ".view-switcher .view-icon"],
  ["autoAccept", ".auto-accept-chip"],
  ["overflow", ".overflow-trigger"],
];

const SHEET_CONTROLS: Array<[string, string]> = [
  ["sheetClose", ".sheet-close"],
  ["stripBtn", ".sheet-strip .strip-btn"],
];

const TOUCH_LABELS = [
  "drawer", "viewChip", "autoAccept", "overflow", "panels",
  "attach", "expand", "send", "stop", "drawerClose", "sheetClose",
];

interface StateSpec {
  id: string;
  path: string;
  ready: string;
  storage?: Record<string, string>;
  /** compact/phone: a modal sheet is open on load, so only sheet controls hit */
  sheetOnLoad?: boolean;
}

const STATES: StateSpec[] = [
  { id: "hero", path: `/p/${PROJECT}`, ready: ".hero .send" },
  { id: "empty", path: `/p/${PROJECT}/s/${S_EMPTY}`, ready: ".send" },
  { id: "loaded", path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg" },
  { id: "working", path: `/p/${PROJECT}/s/${S_WORKING}`, ready: ".stop" },
  {
    // ready waits for the restored session, not ".rail-body": the registered
    // panel host renders a placeholder before init finishes, and the gate must
    // measure the fully initialized shell.
    id: "panel",
    path: `/p/${PROJECT}/s/${S_LOADED}`,
    ready: ".timeline .msg",
    storage: { "polyth.railPrefs": JSON.stringify({ lastOpen: "files", widths: {} }) },
    sheetOnLoad: true,
  },
];

const VIEWPORTS: Array<[number, number]> = [
  [320, 900], [390, 900], [768, 900], [1280, 900], [390, 844], [844, 390],
];

// =============================================================================
// 1. Geometry gate: overflow, bounds, overlap, hit-testing, touch targets
// =============================================================================

test("geometry gate across viewports and shell states", async () => {
  const artifacts: Record<string, GeometryReport> = {};
  for (const [w, h] of VIEWPORTS) {
    const mode = modeOf(w);
    for (const state of STATES) {
      const page = await openApp({ width: w, height: h, path: state.path, ready: state.ready, storage: state.storage });
      const ctx = `${state.id}@${w}x${h}`;
      const modalOpen = state.sheetOnLoad === true && mode !== "wide";
      // Existing UX-07 behavior kept by this case: at wide widths up to
      // 1000px the docked rail overlays the conversation instead of
      // squeezing it, so covered background controls are asserted after
      // closing it rather than through the overlay.
      const railOverlay = state.sheetOnLoad === true && mode === "wide" && w <= 1000;
      if (state.sheetOnLoad) {
        await page.waitForSelector(modalOpen ? ".panel-sheet .rail-body" : ".railbar .rail-body", { state: "visible", timeout: 15_000 });
      }

      const railControls: Array<[string, string]> = [["railToggle", ".railbar .rail-toggle"], ["railStrip", ".rail-icon-col .strip-btn"]];
      const controls: Array<[string, string]> = modalOpen
        ? SHEET_CONTROLS
        : railOverlay
          ? railControls
          : [
              ...(mode === "wide" ? WIDE_HEADER : COMPACT_HEADER),
              ...COMPOSER_CONTROLS,
              ...(state.id === "panel" ? railControls : []),
            ];

      const report = await collectGeometry(page, controls);
      assertNoOverflow(report, ctx);
      assertControlsInViewport(report, ctx);
      assertNoOverlap(report, ctx);
      assertHits(report, ctx);
      if (w <= 390) assertTouchTargets(report, TOUCH_LABELS, ctx);

      if (modalOpen) {
        // Rule: background primary controls receive no pointer events while the
        // sheet is modal — the backdrop or sheet must win every center hit.
        const bg = await collectGeometry(page, [["send", ".send"], ["drawer", ".header-drawer-btn"]]);
        for (const c of bg.controls) {
          assert.ok(!c.hitOk, `${ctx}: background ${c.label} still hittable under the modal sheet`);
        }
      }

      // The overlay rail covers header/composer controls; structural truths
      // for the wide shell are asserted on the rail-closed measurement below.
      let structural = report;
      if (railOverlay) {
        // Closing the overlay rail must restore full pointer access to the
        // header and composer beneath it.
        await page.click(".railbar .rail-toggle");
        await page.waitForFunction(() => {
          const el = document.querySelector(".railbar .rail");
          return el === null || el.getBoundingClientRect().width === 0;
        });
        const after = await collectGeometry(page, [...WIDE_HEADER, ...COMPOSER_CONTROLS]);
        const closedCtx = `${ctx} (rail closed)`;
        assertNoOverflow(after, closedCtx);
        assertControlsInViewport(after, closedCtx);
        assertNoOverlap(after, closedCtx);
        assertHits(after, closedCtx);
        structural = after;
      }

      // Mode-specific structural truths.
      if (mode !== "wide" && !modalOpen) {
        assert.ok(present(structural, "drawer"), `${ctx}: drawer trigger missing in ${mode} mode`);
        assert.ok(present(structural, "viewChip"), `${ctx}: compact view picker missing`);
        assert.ok(!present(structural, "viewIcon"), `${ctx}: desktop view switcher visible in ${mode} mode`);
      }
      if (mode === "wide" && !modalOpen) {
        assert.ok(present(structural, "viewIcon"), `${ctx}: desktop view switcher missing in wide mode`);
        assert.ok(!present(structural, "drawer"), `${ctx}: drawer trigger visible in wide mode`);
      }
      if (state.id === "working") {
        assert.ok(modalOpen || present(report, "stop"), `${ctx}: Stop missing during a working turn`);
      }

      if (state.id === "loaded" && h === 900 && !modalOpen) {
        artifacts[`geometry-${w}`] = report;
        await page.screenshot({ path: join(ARTIFACTS, `shot-${w}-loaded.png`) });
      }
      await page.context().close();
      contexts.pop();
    }
  }
  await writeFile(join(ARTIFACTS, "geometry.json"), JSON.stringify(artifacts, null, 2));
});

// =============================================================================
// 2. Message editor: multiline draft keeps Send enabled and inside the viewport
// =============================================================================

test("multiline editor and Send placement at 320 and 390", async () => {
  for (const w of [320, 390]) {
    const page = await openApp({ width: w, height: 900, path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg" });
    const editor = page.locator(".composer-input textarea");
    await editor.fill("line one\nline two\nline three");
    const box = await editor.boundingBox();
    assert.ok(box, `${w}px: editor has no box`);
    assert.ok(box!.width >= w - 48, `${w}px: editor width ${box!.width} < ${w - 48}`);
    const send = page.locator(".send");
    assert.equal(await send.isEnabled(), true, `${w}px: Send disabled with a non-empty draft`);
    const sb = await send.boundingBox();
    assert.ok(sb, `${w}px: Send has no box`);
    assert.ok(sb!.x + sb!.width <= w - 8, `${w}px: Send trailing edge ${sb!.x + sb!.width} intrudes into the last 8px`);
    assert.ok(sb!.width >= 44 && sb!.height >= 44, `${w}px: Send is ${sb!.width}×${sb!.height}`);
    await page.context().close();
    contexts.pop();
  }
});

// =============================================================================
// 3. Session drawer is a true modal at 390 and consumes no closed width
// =============================================================================

test("session drawer modal contract at 390", async () => {
  const page = await openApp({ width: 390, height: 900, path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg" });

  // Closed: zero layout width — the main column spans the viewport and the
  // drawer box is out of the viewport (or hidden).
  const closed = await page.evaluate(() => {
    const main = document.querySelector(".main")!.getBoundingClientRect();
    const drawer = document.querySelector("#polyth-session-drawer")!;
    const r = drawer.getBoundingClientRect();
    const cs = getComputedStyle(drawer);
    return { mainLeft: main.left, mainRight: main.right, drawerRight: r.right, hidden: cs.visibility === "hidden" || cs.display === "none" };
  });
  assert.ok(closed.mainLeft <= 1, `main starts at ${closed.mainLeft}, sidebar still consumes width`);
  assert.ok(closed.mainRight >= 389, `main ends at ${closed.mainRight}, layout width lost`);
  assert.ok(closed.hidden || closed.drawerRight <= 0, "closed drawer still shows inside the viewport");

  // Open via the named trigger.
  await page.click(".header-drawer-btn");
  await page.waitForSelector(".sidebar.open", { state: "visible" });
  const open = await page.evaluate(() => {
    const el = document.querySelector("#polyth-session-drawer")!;
    const r = el.getBoundingClientRect();
    return {
      left: r.left, width: r.width,
      role: el.getAttribute("role"), modal: el.getAttribute("aria-modal"), name: el.getAttribute("aria-label"),
    };
  });
  assert.ok(open.left >= 0 && open.width <= 390, `open drawer box ${open.left}/${open.width}`);
  assert.equal(open.role, "dialog");
  assert.equal(open.modal, "true");
  assert.equal(open.name, "Projects and sessions");

  // Tab and Shift+Tab stay inside the drawer.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => document.querySelector("#polyth-session-drawer")!.contains(document.activeElement));
    assert.ok(inside, `Tab press ${i + 1} escaped the drawer`);
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Shift+Tab");
    const inside = await page.evaluate(() => document.querySelector("#polyth-session-drawer")!.contains(document.activeElement));
    assert.ok(inside, `Shift+Tab press ${i + 1} escaped the drawer`);
  }

  // Background isolation: the composer Send center must not be hittable.
  const sendCovered = await page.evaluate(() => {
    const send = document.querySelector(".send");
    if (!send) return true;
    const r = send.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === null || !(hit === send || send.contains(hit));
  });
  assert.ok(sendCovered, "Send is still hittable behind the open drawer");

  // Escape closes and restores the opener.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".sidebar.open", { state: "detached" }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector(".sidebar")?.classList.contains("open"));
  const focusRestored = await page.evaluate(() => document.activeElement?.classList.contains("header-drawer-btn") === true);
  assert.ok(focusRestored, "Escape did not restore focus to the drawer trigger");

  // Backdrop click closes.
  await page.click(".header-drawer-btn");
  await page.waitForSelector(".sidebar-backdrop", { state: "visible" });
  await page.mouse.click(385, 450);
  await page.waitForFunction(() => !document.querySelector(".sidebar")?.classList.contains("open"));

  // Keyboard activation: Enter opens the drawer, Enter on a session row
  // activates exactly one session target and closes the drawer only after the
  // session actually opened.
  await page.focus(".header-drawer-btn");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".sidebar.open", { state: "visible" });
  const emptyRow = page.locator(`.session-row:has-text("Empty synthetic session") .session-btn`).first();
  await emptyRow.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector(".sidebar")?.classList.contains("open"));
  await page.waitForFunction((id: string) => location.pathname.includes(`/s/${id}`), S_EMPTY);
  const title = await page.textContent(".header-title");
  assert.match(title ?? "", /Empty synthetic session/, "session activation did not switch the header");

  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 4. Panel sheet: registry strip, pressed truth, host reuse, mutual exclusion
// =============================================================================

test("panel sheet contract at 390", async () => {
  const page = await openApp({ width: 390, height: 900, path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg" });

  // Open panels via the header trigger (registry-backed).
  await page.click(".narrow-panel-trigger");
  await page.waitForSelector(".panel-sheet .rail-body", { state: "visible" });
  const sheet = await page.evaluate(() => {
    const el = document.querySelector("#polyth-panel-sheet")!;
    const r = el.getBoundingClientRect();
    return { width: r.width, role: el.getAttribute("role"), modal: el.getAttribute("aria-modal"), name: el.getAttribute("aria-label") };
  });
  assert.ok(sheet.width <= 390, `sheet wider than viewport: ${sheet.width}`);
  assert.equal(sheet.role, "dialog");
  assert.equal(sheet.modal, "true");
  assert.match(sheet.name ?? "", /panel$/i);

  // Pressed truth + keyed host reuse across Files → Changes → Context → Files.
  const pressedTruth = () =>
    page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll<HTMLElement>(".sheet-strip .strip-btn[aria-pressed]"));
      const bodies = Array.from(document.querySelectorAll<HTMLElement>(".panel-sheet .rail-body"));
      const visibleBodies = bodies.filter((b) => b.getBoundingClientRect().width > 0 && getComputedStyle(b).display !== "none");
      const pressed = btns.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("title"));
      return { pressed, visibleBodies: visibleBodies.length, totalBodies: bodies.length };
    });

  let t = await pressedTruth();
  assert.deepEqual(t.pressed, ["Files"], `expected Files pressed, got ${t.pressed}`);
  assert.equal(t.visibleBodies, 1, "exactly one panel host visible");

  // Tag the Files host DOM node, then switch away and back: the keyed host must
  // be the same node (no remount of a visited panel).
  await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>(".panel-sheet .rail-body");
    body!.dataset.a390Keep = "files-host";
  });
  await page.click('.sheet-strip .strip-btn[title="Changes"]');
  await page.waitForFunction(() => document.querySelector('.sheet-strip .strip-btn[title="Changes"]')?.getAttribute("aria-pressed") === "true");
  t = await pressedTruth();
  assert.deepEqual(t.pressed, ["Changes"]);
  assert.equal(t.visibleBodies, 1);

  await page.click('.sheet-strip .strip-btn[title="Context"]');
  await page.waitForFunction(() => document.querySelector('.sheet-strip .strip-btn[title="Context"]')?.getAttribute("aria-pressed") === "true");
  t = await pressedTruth();
  assert.deepEqual(t.pressed, ["Context"]);
  assert.equal(t.totalBodies >= 3, true, "visited panels stay mounted (keep-alive)");

  const filesHostKept = await page.evaluate(() => document.querySelector('[data-a390-keep="files-host"]') !== null);
  assert.ok(filesHostKept, "Files host was remounted while switching panels");

  // Escape closes the sheet and restores the panels trigger.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const el = document.querySelector("#polyth-panel-sheet");
    return el === null || (el as HTMLElement).style.display === "none";
  });
  const back = await page.evaluate(() => document.activeElement?.classList.contains("narrow-panel-trigger") === true);
  assert.ok(back, "Escape did not restore focus to the panels trigger");

  // Backdrop close: at phone width the sheet is full-bleed (no exposed
  // backdrop), so exercise the pointer path at 768 where the scrim is visible.
  await page.click(".narrow-panel-trigger");
  await page.waitForSelector(".panel-sheet .rail-body", { state: "visible" });
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(200);
  await page.mouse.click(100, 450);
  await page.waitForFunction(() => {
    const el = document.querySelector("#polyth-panel-sheet");
    return el === null || (el as HTMLElement).style.display === "none";
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(200);

  // Mutual exclusion: the drawer and the panel sheet are never open at once.
  await page.click(".header-drawer-btn");
  await page.waitForSelector(".sidebar.open", { state: "visible" });
  const withDrawer = await page.evaluate(() => ({
    sheetOpen: (() => { const el = document.querySelector("#polyth-panel-sheet"); return el !== null && (el as HTMLElement).style.display !== "none"; })(),
    drawerOpen: document.querySelector(".sidebar")?.classList.contains("open") === true,
  }));
  assert.equal(withDrawer.drawerOpen, true);
  assert.equal(withDrawer.sheetOpen, false, "sheet open while the drawer is the active modal");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".sidebar")?.classList.contains("open"));
  await page.click(".narrow-panel-trigger");
  await page.waitForSelector(".panel-sheet .rail-body", { state: "visible" });
  const withSheet = await page.evaluate(() => ({
    sheetOpen: (() => { const el = document.querySelector("#polyth-panel-sheet"); return el !== null && (el as HTMLElement).style.display !== "none"; })(),
    drawerOpen: document.querySelector(".sidebar")?.classList.contains("open") === true,
  }));
  assert.equal(withSheet.sheetOpen, true);
  assert.equal(withSheet.drawerOpen, false, "drawer open while the sheet is the active modal");

  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 5. Compact view picker switches views (terminal) with keyboard support
// =============================================================================

test("compact view picker reaches the terminal view at 390", async () => {
  const page = await openApp({ width: 390, height: 900, path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg" });

  const chipName = await page.getAttribute(".header-view-picker .picker-chip", "aria-label");
  assert.match(chipName ?? "", /^Change workspace view, current: /, "view chip must announce the current view");

  await page.click(".header-view-picker .picker-chip");
  await page.waitForSelector(".picker-pop input", { state: "visible" });
  await page.fill(".picker-pop input", "terminal");
  await page.keyboard.press("Enter");

  await page.waitForFunction(() => document.querySelector(".sb-view")?.textContent === "Terminal");
  const after = await page.getAttribute(".header-view-picker .picker-chip", "aria-label");
  assert.match(after ?? "", /current: Terminal$/, "chip name did not update to the new view");

  const report = await collectGeometry(page, [...COMPACT_HEADER, ["viewChip2", ".header-view-picker .picker-chip"]]);
  assertNoOverflow(report, "terminal@390x900");
  assertControlsInViewport(report, "terminal@390x900");

  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 6. Resize sequence keeps geometry, focus, and pressed state truthful
// =============================================================================

test("resize wide→390→320→768→wide without reload", async () => {
  const page = await openApp({
    width: 1280, height: 900,
    path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg",
    storage: { "polyth.railPrefs": JSON.stringify({ lastOpen: "files", widths: {} }) },
  });

  // Wide: inline rail open, desktop switcher present. Focus a view icon so the
  // resize handoff has something to move.
  await page.waitForSelector(".railbar .rail-body", { state: "visible" });
  await page.focus(".view-switcher .view-icon");

  const check = async (w: number, h: number) => {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(250);
    const mode = modeOf(w);
    const state = await page.evaluate(() => ({
      railbarVisible: (() => {
        const el = document.querySelector(".railbar");
        return el !== null && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
      })(),
      sidebarInline: (() => {
        const el = document.querySelector(".sidebar")!;
        const cs = getComputedStyle(el);
        return cs.position !== "fixed" && el.getBoundingClientRect().width > 0;
      })(),
      drawerOpen: document.querySelector(".sidebar")?.classList.contains("open") === true,
      focusVisible: (() => {
        const el = document.activeElement;
        if (!el || el === document.body) return true; // no stale focus
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth;
      })(),
      pressedTruthful: Array.from(document.querySelectorAll<HTMLElement>('[aria-pressed="true"].strip-btn')).every((b) => {
        const bodies = Array.from(document.querySelectorAll<HTMLElement>(".rail-body"));
        return bodies.some((x) => x.getBoundingClientRect().width > 0 && getComputedStyle(x).display !== "none");
      }),
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    assert.ok(state.docOverflow <= 1, `${w}px: document overflows by ${state.docOverflow}px`);
    if (mode !== "wide") {
      assert.equal(state.railbarVisible, false, `${w}px: inline rail visible in ${mode} mode`);
      assert.equal(state.sidebarInline, false, `${w}px: sidebar still consumes inline width`);
      assert.equal(state.drawerOpen, false, `${w}px: drawer opened itself on resize`);
    } else {
      assert.equal(state.railbarVisible, true, `${w}px: inline rail missing back in wide mode`);
      assert.equal(state.sidebarInline, true, `${w}px: inline sidebar missing back in wide mode`);
    }
    assert.ok(state.focusVisible, `${w}px: focus rests on a hidden/offscreen control`);
    assert.ok(state.pressedTruthful, `${w}px: pressed surface button without visible panel`);
  };

  await check(390, 900);
  await check(320, 900);
  await check(768, 900);
  await check(1280, 900);

  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 7. 200% zoom (720×450 CSS px @2x): reachable scroll origin and endpoints
// =============================================================================

test("zoomed 720×450@2x hero is fully reachable and reflows in one dimension", async () => {
  const page = await openApp({
    width: 720, height: 450, deviceScaleFactor: 2,
    path: `/p/${PROJECT}`, ready: ".hero .send",
  });

  // UX-MOBILE-01: the empty state scrolls inside .hero-body while the
  // interaction dock (context bar + composer) stays pinned in .hero-dock.
  const geo = await page.evaluate(() => {
    const stage = document.querySelector(".stage")!;
    const body = document.querySelector(".hero-body")!;
    body.scrollTop = 0;
    const stageRect = stage.getBoundingClientRect();
    const first = document.querySelector(".hero h2")!.getBoundingClientRect();
    body.scrollTop = body.scrollHeight;
    const maxTop = body.scrollTop;
    const last = document.querySelector(".hero-dock .composer-card")?.getBoundingClientRect() ?? null;
    return {
      firstTopAtOrigin: first.top,
      stageTop: stageRect.top,
      stageBottom: stageRect.bottom,
      lastBottomAtMax: last ? last.bottom : null,
      maxTop,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stageOverflowX: body.scrollWidth - body.clientWidth,
    };
  });
  assert.ok(geo.firstTopAtOrigin >= geo.stageTop - 1, `hero starts ${geo.firstTopAtOrigin} above the stage origin ${geo.stageTop}`);
  assert.ok(geo.lastBottomAtMax !== null, "no trailing starter/action element found");
  assert.ok(geo.lastBottomAtMax! <= geo.stageBottom + 1, `last action ${geo.lastBottomAtMax} unreachable below ${geo.stageBottom}`);
  assert.ok(geo.docOverflowX <= 1, "two-dimensional page scrolling at 200% zoom");
  assert.ok(geo.stageOverflowX <= 1, "stage scrolls horizontally at 200% zoom");

  // Tabbing never leaves a focused control offscreen.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const ok = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return true;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5;
    });
    assert.ok(ok, `Tab step ${i + 1}: focused control is offscreen at 200% zoom`);
  }

  await page.screenshot({ path: join(ARTIFACTS, "shot-zoom-720x450@2x.png") });
  await writeFile(join(ARTIFACTS, "geometry-zoom.json"), JSON.stringify(geo, null, 2));
  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 8. Motion: reduced = single frame; normal settles within 160ms
// =============================================================================

async function sampleDrawerMotion(page: Page): Promise<Array<{ ms: number; left: number; width: number }>> {
  return page.evaluate(async () => {
    const btn = document.querySelector<HTMLElement>(".header-drawer-btn")!;
    const drawer = document.querySelector("#polyth-session-drawer")!;
    const samples: Array<{ ms: number; left: number; width: number }> = [];
    const grab = (ms: number) => {
      const r = drawer.getBoundingClientRect();
      samples.push({ ms, left: Math.round(r.left * 2) / 2, width: Math.round(r.width * 2) / 2 });
    };
    const at = (ms: number) => new Promise<void>((res) => setTimeout(() => { grab(ms); res(); }, ms));
    btn.click();
    // t0 is the first frame in which the open state exists in the DOM — the
    // React commit, not the click dispatch (state updates flush asynchronously).
    await new Promise<void>((res) => {
      const spin = () => (drawer.classList.contains("open") ? res() : setTimeout(spin, 0));
      spin();
    });
    grab(0);
    await Promise.all([at(16), at(50), at(160), at(300)]);
    return samples;
  });
}

test("reduced motion renders final drawer geometry in the first frame", async () => {
  const page = await openApp({
    width: 390, height: 900, reducedMotion: "reduce",
    path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg",
  });
  const samples = await sampleDrawerMotion(page);
  const first = samples[0]!;
  for (const s of samples) {
    assert.equal(s.left, first.left, `reduced motion: drawer left moved between 0ms and ${s.ms}ms`);
    assert.equal(s.width, first.width, `reduced motion: drawer width changed between 0ms and ${s.ms}ms`);
  }
  await page.context().close();
  contexts.pop();
});

test("normal motion settles drawer geometry by 160ms", async () => {
  const page = await openApp({
    width: 390, height: 900, reducedMotion: "no-preference",
    path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg",
  });
  const samples = await sampleDrawerMotion(page);
  const at160 = samples.find((s) => s.ms === 160)!;
  const at300 = samples.find((s) => s.ms === 300)!;
  assert.equal(at160.left, at300.left, "drawer still moving after 160ms");
  assert.equal(at160.width, at300.width, "drawer still resizing after 160ms");
  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 9. Reload at 390 preserves session, draft, attachments, panel, timeline
//    anchor; drawer closed; the session event log stays byte-for-byte intact
// =============================================================================

/** The raw event-log body — persistence must never append or mutate events. */
const fetchEvents = (page: Page, sessionId: string): Promise<string> =>
  page.evaluate(async (id: string) => {
    const res = await fetch(`/api/sessions/${id}/events?afterSeq=0`);
    return await res.text();
  }, sessionId);

test("reload at 390 restores working state and starts with the drawer closed", async () => {
  const attachmentPath = join(ARTIFACTS, "a390-attachment.txt");
  await writeFile(attachmentPath, "synthetic attachment payload\n");

  const page = await openApp({ width: 390, height: 900, path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg" });
  const eventsBefore = await fetchEvents(page, S_LOADED);

  await page.fill(".composer-input textarea", "draft line one\ndraft line two");
  await page.setInputFiles('.composer input[type="file"]', attachmentPath);
  await page.waitForSelector('[aria-label="Attachments"]', { state: "visible" });

  // Place the timeline at a mid-scroll reading position: a non-bottom anchor
  // must survive reload exactly (spec acceptance item 11).
  const anchorSet = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    const max = el.scrollHeight - el.clientHeight;
    const target = Math.round(max * 0.25);
    el.scrollTop = target;
    return { target, max };
  });
  assert.ok(anchorSet.max >= 400, `loaded timeline scrolls only ${anchorSet.max}px; fixture too short for the anchor gate`);
  // The anchor store debounces writes; require the flush before reloading.
  await page.waitForFunction(({ id, target }: { id: string; target: number }) => {
    try {
      const map = JSON.parse(localStorage.getItem("polyth.timelineAnchors") ?? "{}") as Record<string, { atBottom: boolean; scrollTop: number }>;
      const a = map[id];
      return !!a && a.atBottom === false && Math.abs(a.scrollTop - target) <= 1;
    } catch {
      return false;
    }
  }, { id: S_LOADED, target: anchorSet.target });

  // Open a panel so its last-open state persists, then reload with it open.
  await page.click(".narrow-panel-trigger");
  await page.waitForSelector(".panel-sheet .rail-body", { state: "visible" });

  // The draft store debounces writes; require the flush before reloading.
  await page.waitForFunction(
    (id: string) => localStorage.getItem(`polyth.draft.${id}`) === "draft line one\ndraft line two",
    S_LOADED,
  );

  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".app");
  // Wait for the restored session (the sheet host alone renders pre-init).
  await page.waitForSelector(".timeline .msg", { state: "visible", timeout: 15_000 });
  await page.waitForSelector(".panel-sheet .rail-body", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(300);

  const restored = await page.evaluate((sessionId: string) => ({
    urlKeepsSession: location.pathname.includes(`/s/${sessionId}`),
    panelPressed: document.querySelector('.sheet-strip .strip-btn[aria-pressed="true"]')?.getAttribute("title") ?? null,
    drawerOpen: document.querySelector(".sidebar")?.classList.contains("open") === true,
  }), S_LOADED);
  assert.ok(restored.urlKeepsSession, "reload lost the selected session");
  assert.equal(restored.panelPressed, "Files", "reload lost the last-open panel");
  assert.equal(restored.drawerOpen, false, "drawer must start closed after reload");

  // The timeline restored the saved mid-scroll anchor, not the bottom.
  await page.waitForFunction((target: number) => {
    const el = document.querySelector<HTMLElement>(".timeline");
    return el !== null && Math.abs(el.scrollTop - target) <= 2;
  }, anchorSet.target, { timeout: 5_000 });
  const anchorBack = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    return { scrollTop: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
  assert.ok(Math.abs(anchorBack.scrollTop - anchorSet.target) <= 2,
    `reload lost the timeline anchor: restored ${anchorBack.scrollTop}, saved ${anchorSet.target}`);
  assert.ok(anchorBack.max - anchorBack.scrollTop > 80,
    `restored anchor sits at the bottom (${anchorBack.scrollTop}/${anchorBack.max}), not the saved reading position`);

  // Close the sheet to reach the composer; the draft and attachment survived.
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const el = document.querySelector("#polyth-panel-sheet");
    return el === null || (el as HTMLElement).style.display === "none";
  });
  const draft = await page.inputValue(".composer-input textarea");
  assert.equal(draft, "draft line one\ndraft line two", "reload lost the draft");
  const attachmentBack = await page.locator('[aria-label="Attachments"]').count();
  assert.ok(attachmentBack > 0, "reload lost the pending attachment");

  // Event safety: none of the persistence above touched the session log.
  const eventsAfter = await fetchEvents(page, S_LOADED);
  assert.equal(eventsAfter, eventsBefore, "UI persistence mutated the session event log");

  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 9b. Reload at 390 restores a non-default view; returning to Chat restores
//     the saved top-of-timeline anchor (the verifier's exact failing case)
// =============================================================================

test("reload at 390 restores the Terminal view and the top timeline anchor", async () => {
  const page = await openApp({ width: 390, height: 900, path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg" });
  const eventsBefore = await fetchEvents(page, S_LOADED);

  // Scroll the timeline to its very top and require the persisted anchor.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".timeline")!.scrollTop = 0;
  });
  await page.waitForFunction((id: string) => {
    try {
      const map = JSON.parse(localStorage.getItem("polyth.timelineAnchors") ?? "{}") as Record<string, { atBottom: boolean; scrollTop: number }>;
      const a = map[id];
      return !!a && a.atBottom === false && a.scrollTop === 0;
    } catch {
      return false;
    }
  }, S_LOADED);

  // Select the non-default Terminal view through the compact picker.
  await page.click(".header-view-picker .picker-chip");
  await page.waitForSelector(".picker-pop input", { state: "visible" });
  await page.fill(".picker-pop input", "terminal");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".sb-view")?.textContent === "Terminal");
  await page.waitForFunction(() => localStorage.getItem("polyth.activeView") === "terminal");

  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".app");
  await page.waitForFunction((id: string) => location.pathname.includes(`/s/${id}`), S_LOADED);
  // The restored view must be the selected Terminal, not the Chat default.
  await page.waitForFunction(
    () => document.querySelector(".sb-view")?.textContent === "Terminal",
    undefined,
    { timeout: 15_000 },
  );
  const chip = await page.getAttribute(".header-view-picker .picker-chip", "aria-label");
  assert.match(chip ?? "", /current: Terminal$/, "reload lost the selected view");
  const drawerOpen = await page.evaluate(() => document.querySelector(".sidebar")?.classList.contains("open") === true);
  assert.equal(drawerOpen, false, "drawer must start closed after reload");

  // Returning to Chat restores the saved top anchor, not the bottom.
  await page.click(".header-view-picker .picker-chip");
  await page.waitForSelector(".picker-pop input", { state: "visible" });
  await page.fill(".picker-pop input", "chat");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".timeline .msg", { state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLElement>(".timeline");
    return el !== null && el.scrollHeight - el.clientHeight > 400 && el.scrollTop <= 2;
  });
  await page.waitForFunction(() => localStorage.getItem("polyth.activeView") === "session");

  // Event safety: view and anchor persistence never touch the session log.
  const eventsAfter = await fetchEvents(page, S_LOADED);
  assert.equal(eventsAfter, eventsBefore, "view/anchor persistence mutated the session event log");

  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 10. Keyboard order, activation, escape layering, accessible names
// =============================================================================

test("keyboard and accessible-name gate at 390", async () => {
  const page = await openApp({ width: 390, height: 900, path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg" });

  // The hidden desktop switcher is out of the accessibility tree entirely.
  const switcherGone = await page.evaluate(() => {
    const el = document.querySelector(".view-switcher");
    return el === null || getComputedStyle(el).display === "none";
  });
  assert.ok(switcherGone, "desktop view switcher still rendered at 390");

  // Tab order: header controls come before the composer editor and Send.
  // A non-empty draft first: a disabled Send is legitimately out of tab order.
  await page.fill(".composer-input textarea", "tab order probe");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const order: string[] = [];
  for (let i = 0; i < 150; i++) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "";
      if (el.classList.contains("header-drawer-btn")) return "drawer";
      if (el.closest(".header-view-picker")) return "viewChip";
      if (el.classList.contains("auto-accept-chip")) return "autoAccept";
      if (el.classList.contains("overflow-trigger")) return "overflow";
      if (el.classList.contains("narrow-panel-trigger")) return "panels";
      if (el.tagName === "TEXTAREA") return "editor";
      if (el.classList.contains("send")) return "send";
      return "";
    });
    if (tag && !order.includes(tag)) order.push(tag);
    if (order.includes("send")) break;
  }
  const idx = (k: string) => order.indexOf(k);
  assert.ok(idx("drawer") >= 0, "drawer trigger unreachable by Tab");
  assert.ok(idx("viewChip") > idx("drawer"), `view chip must follow drawer trigger (${order.join(",")})`);
  assert.ok(idx("panels") > idx("viewChip"), `panels trigger must follow view chip (${order.join(",")})`);
  assert.ok(idx("editor") > idx("panels"), `editor must follow header controls (${order.join(",")})`);
  assert.ok(idx("send") > idx("editor"), `Send must follow the editor (${order.join(",")})`);

  // Space activates the panels trigger; Escape closes only that top layer.
  await page.focus(".narrow-panel-trigger");
  await page.keyboard.press("Space");
  await page.waitForSelector(".panel-sheet .rail-body", { state: "visible" });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const el = document.querySelector("#polyth-panel-sheet");
    return el === null || (el as HTMLElement).style.display === "none";
  });

  // Transient picker popover wins the next Escape without disturbing the shell.
  await page.click(".header-view-picker .picker-chip");
  await page.waitForSelector(".picker-pop", { state: "visible" });
  await page.keyboard.press("Escape");
  await page.waitForSelector(".picker-pop", { state: "detached" });
  const shellIntact = await page.evaluate(() => ({
    drawerOpen: document.querySelector(".sidebar")?.classList.contains("open") === true,
    sheetOpen: (() => { const el = document.querySelector("#polyth-panel-sheet"); return el !== null && (el as HTMLElement).style.display !== "none"; })(),
  }));
  assert.equal(shellIntact.drawerOpen, false);
  assert.equal(shellIntact.sheetOpen, false);

  // Accessible names.
  const names = await page.evaluate(() => ({
    drawer: document.querySelector(".header-drawer-btn")?.getAttribute("aria-label"),
    viewChip: document.querySelector(".header-view-picker .picker-chip")?.getAttribute("aria-label"),
    panels: document.querySelector(".narrow-panel-trigger")?.getAttribute("aria-label"),
    autoAccept: document.querySelector(".auto-accept-chip")?.getAttribute("aria-label"),
  }));
  assert.equal(names.drawer, "Open projects and sessions");
  assert.match(names.viewChip ?? "", /^Change workspace view, current: /);
  assert.match(names.panels ?? "", /panels|panel/i);
  assert.match(names.autoAccept ?? "", /^Auto-accept (on|off)/);

  await page.context().close();
  contexts.pop();
});

// =============================================================================
// 11. Contrast: bundled themes meet 4.5:1 text and 3:1 indicator ratios
// =============================================================================

const BUNDLED_THEMES = ["dark", "midnight", "forest", "light", "mist", "solar"];

test("bundled theme contrast for actionable text, icons, and focus", async () => {
  for (const theme of BUNDLED_THEMES) {
    const page = await openApp({
      width: 390, height: 900,
      path: `/p/${PROJECT}/s/${S_LOADED}`, ready: ".timeline .msg",
      storage: { "polyth.settings": JSON.stringify({ theme }) },
    });
    await page.fill(".composer-input textarea", "hi"); // enable Send (disabled text is exempt)
    await page.focus(".header-drawer-btn");

    const ratios = await page.evaluate(() => {
      type RGB = { r: number; g: number; b: number };
      const parse = (s: string): { r: number; g: number; b: number; a: number } | null => {
        const m = /rgba?\(([^)]+)\)/.exec(s);
        if (m) {
          const p = m[1]!.split(",").map((x) => parseFloat(x));
          return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 };
        }
        const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
        if (hex) {
          let h = hex[1]!;
          if (h.length === 3) h = h.split("").map((c) => c + c).join("");
          return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
            a: 1,
          };
        }
        return null;
      };
      const effBg = (el: Element): RGB => {
        const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          const cs = getComputedStyle(n);
          // Gradient fills (e.g. the Send button) resolve through
          // background-image; use the first stop as the effective paint.
          if (cs.backgroundImage !== "none") {
            const g = parse(cs.backgroundImage);
            if (g) {
              layers.push({ ...g, a: 1 });
              break;
            }
          }
          const c = parse(cs.backgroundColor);
          if (c && c.a > 0) layers.push(c);
          if (c && c.a >= 1) break;
        }
        let bg: RGB = { r: 128, g: 128, b: 128 };
        for (let i = layers.length - 1; i >= 0; i--) {
          const c = layers[i]!;
          bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) };
        }
        return bg;
      };
      const lum = (c: RGB): number => {
        const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (a: RGB, b: RGB): number => {
        const l1 = Math.max(lum(a), lum(b));
        const l2 = Math.min(lum(a), lum(b));
        return (l1 + 0.05) / (l2 + 0.05);
      };
      const textRatio = (sel: string): number | null => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const fg = parse(getComputedStyle(el).color);
        if (!fg) return null;
        return ratio({ r: fg.r, g: fg.g, b: fg.b }, effBg(el));
      };
      const drawerBtn = document.querySelector(".header-drawer-btn")!;
      const outline = parse(getComputedStyle(drawerBtn).outlineColor);
      // The bundled primary-action token pair at both gradient endpoints:
      // accent-ink must clear 4.5:1 over --accent and over --accent-hi.
      const rootStyle = getComputedStyle(document.documentElement);
      const ink = parse(rootStyle.getPropertyValue("--accent-ink").trim()) ?? parse("rgb(0,0,0)")!;
      const accent = parse(rootStyle.getPropertyValue("--accent").trim()) ?? parse("rgb(255,255,255)")!;
      const accentHi = parse(rootStyle.getPropertyValue("--accent-hi").trim()) ?? accent;
      return {
        send: textRatio(".send"),
        sendTokenAccent: ratio({ r: ink.r, g: ink.g, b: ink.b }, { r: accent.r, g: accent.g, b: accent.b }),
        sendTokenHi: ratio({ r: ink.r, g: ink.g, b: ink.b }, { r: accentHi.r, g: accentHi.g, b: accentHi.b }),
        headerTitle: textRatio(".header-title"),
        viewChipText: textRatio(".header-view-picker .picker-chip-text"),
        drawerIcon: textRatio(".header-drawer-btn"),
        focusOutline: outline ? ratio({ r: outline.r, g: outline.g, b: outline.b }, effBg(drawerBtn.parentElement!)) : null,
      };
    });

    // Primary action: the specification's explicit 4.5:1, enforced directly
    // for every bundled theme — as rendered on .send and at both accent
    // gradient endpoints. No capability floor, no Math.min escape hatch.
    assert.ok((ratios.send ?? 0) >= 4.5, `${theme}: Send text contrast ${ratios.send?.toFixed(2)} < 4.5`);
    assert.ok(ratios.sendTokenAccent >= 4.5, `${theme}: accent-ink over accent is ${ratios.sendTokenAccent.toFixed(2)} < 4.5`);
    assert.ok(ratios.sendTokenHi >= 4.5, `${theme}: accent-ink over accent-hi is ${ratios.sendTokenHi.toFixed(2)} < 4.5`);
    assert.ok((ratios.headerTitle ?? 0) >= 4.5, `${theme}: header title contrast ${ratios.headerTitle?.toFixed(2)} < 4.5`);
    assert.ok((ratios.viewChipText ?? 0) >= 4.5, `${theme}: view chip text contrast ${ratios.viewChipText?.toFixed(2)} < 4.5`);
    assert.ok((ratios.drawerIcon ?? 0) >= 3, `${theme}: drawer icon contrast ${ratios.drawerIcon?.toFixed(2)} < 3`);
    assert.ok((ratios.focusOutline ?? 0) >= 3, `${theme}: focus outline contrast ${ratios.focusOutline?.toFixed(2)} < 3`);

    await page.context().close();
    contexts.pop();
  }
});
