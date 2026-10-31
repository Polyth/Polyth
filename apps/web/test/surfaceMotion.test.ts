// Surface motion measured in a real browser (skipped without one): exit
// ghosts, phone Settings (arrival edge, stages, dismissal), the Navigator
// covered by Settings, phone sheets and dialogs, and the swipeable toast.
// Animations are frozen at exact progress points and the geometry that the
// user sees is asserted, with the real stylesheets in their load order.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const WIDTH = 390;
const HEIGHT = 844;

let browser: Browser | null = null;
let page = null as Page | null;
let css = "";
let ghostScript = "";

before(async () => {
  if (!CHROME) return;
  const files = await Promise.all([
    "../src/tokens.css",
    "../src/styles.css",
    "../src/stackNavigation.css",
    "../src/surfaceMotion.css",
    "../src/components/mobile/MobileNavigator.css",
    "../src/notify/notify.css",
  ].map(read));
  css = files.map((text) => text.replace(/@import[^;]+;/g, "")).join("\n");
  const bundled = await build({
    stdin: {
      contents: `import { leaveExitGhost } from ${JSON.stringify(new URL("../src/exitGhost.ts", import.meta.url).pathname)};\nwindow.leaveExitGhost = leaveExitGhost;`,
      resolveDir: new URL(".", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true, format: "iife", platform: "browser", write: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  ghostScript = bundled.outputFiles[0]!.text;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, hasTouch: true });
});

after(async () => {
  await browser?.close();
});

async function load(body: string, options: { dir?: "ltr" | "rtl"; width?: number; reduced?: boolean } = {}) {
  assert.ok(page);
  await page.setViewportSize({ width: options.width ?? WIDTH, height: HEIGHT });
  await page.emulateMedia({ reducedMotion: options.reduced ? "reduce" : "no-preference" });
  // The direction is part of the first paint: flipping it later would run the
  // surfaces' own transitions between the two sides.
  await page.setContent(`<!doctype html><html dir="${options.dir ?? "ltr"}"><head><meta name="viewport" content="width=device-width"><style>${css}</style><style>html,body{margin:0}</style></head><body>${body}</body></html>`);
  await page.addScriptTag({ content: ghostScript });
}

/** Pause the named animation running on `selector` at `fraction` of its duration. */
async function freeze(selector: string, name: string, fraction: number) {
  return page!.evaluate(([sel, animationName, f]) => {
    const el = document.querySelector(sel as string)!;
    const animation = document.getAnimations().find((candidate) =>
      (candidate as CSSAnimation).animationName === animationName && (candidate.effect as KeyframeEffect | null)?.target === el);
    if (!animation) return false;
    animation.pause();
    animation.currentTime = Number(animation.effect!.getComputedTiming().duration) * Number(f);
    return true;
  }, [selector, name, fraction] as const);
}

const box = (selector: string) => page!.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10, visibility: getComputedStyle(el).visibility, animation: getComputedStyle(el).animationName };
}, selector);

test("an exit ghost is an inert copy of the last frame that plays its exit and goes", { skip: !CHROME }, async () => {
  await load(`
    <div class="sheet-backdrop" id="backdrop"><div class="sheet" id="panel" style="--sheet-from: 80px">
      <div class="sheet-body" id="scroller" style="overflow-y:auto;height:120px"><div style="height:1200px">rows</div></div>
      <input id="field" /><span id="named" aria-modal="true">x</span>
    </div></div>`);
  const ghost = await page!.evaluate(() => {
    const backdrop = document.getElementById("backdrop")!;
    document.getElementById("scroller")!.scrollTop = 300;
    (document.getElementById("field") as HTMLInputElement).value = "typed";
    (window as unknown as { leaveExitGhost: (node: HTMLElement, spec: { kind: string }) => void }).leaveExitGhost(backdrop, { kind: "sheet" });
    backdrop.remove(); // what the owner's unmount does in the same task
    const copy = document.querySelector<HTMLElement>('[data-exit-ghost="sheet"]');
    if (!copy) return null;
    const panel = copy.querySelector<HTMLElement>(".sheet")!;
    const animation = panel.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 0;
    return {
      inert: copy.hasAttribute("inert"),
      hidden: copy.getAttribute("aria-hidden"),
      ids: copy.querySelectorAll("[id]").length + (copy.id ? 1 : 0),
      modal: copy.querySelectorAll("[aria-modal]").length,
      pointer: getComputedStyle(copy).pointerEvents,
      exit: (animation as CSSAnimation).animationName,
      startTop: Math.round(panel.getBoundingClientRect().top),
      restTop: Math.round(panel.getBoundingClientRect().top - 80),
      scrollTop: copy.querySelector<HTMLElement>(".sheet-body")!.scrollTop,
      value: copy.querySelector<HTMLInputElement>("input")!.value,
    };
  });
  assert.ok(ghost, "a ghost is left where the sheet was");
  assert.equal(ghost.inert, true);
  assert.equal(ghost.hidden, "true");
  assert.equal(ghost.ids, 0, "nothing can look the copy up by id");
  assert.equal(ghost.modal, 0, "nor mistake it for an open modal");
  assert.equal(ghost.pointer, "none");
  assert.equal(ghost.exit, "sheet-slide-out");
  assert.equal(ghost.startTop - ghost.restTop, 80, "the exit starts where the drag let go");
  assert.equal(ghost.scrollTop, 300, "the copy shows the same scroll position");
  assert.equal(ghost.value, "typed", "and the same field values");
  await page!.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
  await page!.waitForTimeout(600);
  assert.equal(await page!.evaluate(() => document.querySelectorAll("[data-exit-ghost]").length), 0, "it removes itself");

  for (const [label, options, kind] of [
    ["reduced motion", { reduced: true }, "sheet"],
    ["nothing animates it", {}, "no-such-exit"],
  ] as const) {
    await load('<div id="plain"><p>content</p></div>', options);
    const left = await page!.evaluate((spec) => {
      const node = document.getElementById("plain")!;
      (window as unknown as { leaveExitGhost: (node: HTMLElement, spec: { kind: string }) => void }).leaveExitGhost(node, { kind: spec });
      return document.querySelectorAll("[data-exit-ghost]").length;
    }, kind);
    assert.equal(left, 0, `${label}: no ghost at all`);
  }
});

function settingsFixture(options: { origin: "start" | "end"; stage: "nav" | "page"; motion?: string; ghost?: boolean; from?: string; extra?: string }) {
  return `
    <div class="scrim settings-scrim" id="scrim"${options.ghost ? ' data-exit-ghost="settings"' : ""}>
      <div class="modal settings-shell settings-mobile-${options.stage}" id="shell" data-origin="${options.origin}"
        ${options.motion ? `data-stage-motion="${options.motion}"` : ""} ${options.extra ?? ""}
        style="${options.from ? `--settings-from: ${options.from};` : ""}">
        <nav class="modal-nav settings-nav" id="nav"><div class="settings-nav-list">list</div></nav>
        <div class="modal-main settings-pane" id="pane"><div class="modal-body settings-pane-body">page</div></div>
      </div>
    </div>`;
}

test("phone Settings arrives from the edge it was opened toward and leaves back to it", { skip: !CHROME }, async () => {
  for (const dir of ["ltr", "rtl"] as const) {
    const side = dir === "ltr" ? 1 : -1;
    await load(settingsFixture({ origin: "start", stage: "nav" }), { dir });
    assert.equal((await box("#shell"))!.animation, "settings-in-start", "from the Navigator: the Navigator's side");
    await freeze("#shell", "settings-in-start", 0);
    assert.equal((await box("#shell"))!.left, -side * WIDTH, `${dir}: starts one screen off the inline-start edge`);
    await freeze("#shell", "settings-in-start", 1);
    assert.equal((await box("#shell"))!.left, 0);

    await load(settingsFixture({ origin: "end", stage: "nav" }), { dir });
    assert.equal((await box("#shell"))!.animation, "stack-in", "from anywhere else: pushed in from the inline end");
    await freeze("#shell", "stack-in", 0);
    assert.equal((await box("#shell"))!.left, side * WIDTH);

    // A swipe that let go 120px toward the start carries on off that edge.
    await load(settingsFixture({ origin: "start", stage: "page", ghost: true, from: `${-side * 120}px` }), { dir });
    assert.equal((await box("#shell"))!.animation, "settings-out-start");
    await freeze("#shell", "settings-out-start", 0);
    assert.equal((await box("#shell"))!.left, -side * 120, "from where the finger let go");
    await freeze("#shell", "settings-out-start", 1);
    assert.equal((await box("#shell"))!.left, -side * WIDTH);

    await load(settingsFixture({ origin: "end", stage: "nav", ghost: true }), { dir });
    assert.equal((await box("#shell"))!.animation, "settings-out-end");
    await freeze("#shell", "settings-out-end", 1);
    assert.equal((await box("#shell"))!.left, side * WIDTH, "a pushed Settings leaves back off the inline end");
  }
  await load(settingsFixture({ origin: "start", stage: "nav", extra: "data-dragged" }));
  assert.equal((await box("#shell"))!.animation, "none", "a finger has moved it: the entrance never replays");
});

test("a Settings page is pushed over the list and popped back off it", { skip: !CHROME }, async () => {
  const parallax = Math.round(WIDTH * 0.28 * 10) / 10;
  await load(settingsFixture({ origin: "end", stage: "page", motion: "push" }));
  await freeze("#shell", "stack-in", 1);
  assert.equal((await box("#pane"))!.animation, "stack-in");
  await freeze("#pane", "stack-in", 0);
  assert.equal((await box("#pane"))!.left, WIDTH, "the page arrives from the inline end");
  await freeze("#nav", "stack-cover", 0);
  assert.equal((await box("#nav"))!.left, 0);
  await freeze("#nav", "stack-cover", 1);
  const covered = (await box("#nav"))!;
  assert.equal(covered.left, -parallax, "the list retreats by the stack parallax");
  assert.equal(covered.visibility, "hidden", "…and stops painting once covered");

  await load(settingsFixture({ origin: "end", stage: "page" }));
  assert.equal((await box("#nav"))!.visibility, "hidden", "a page opened directly keeps the list unpainted beneath");

  await load(`${settingsFixture({ origin: "end", stage: "nav", motion: "pop" })}<style>#pane{--stack-from:100px}</style>`);
  await freeze("#shell", "stack-in", 1);
  await freeze("#pane", "stack-out", 0);
  assert.equal((await box("#pane"))!.left, 100, "Back carries the page on from where a swipe let go");
  await freeze("#pane", "stack-out", 1);
  assert.equal((await box("#pane"))!.left, WIDTH);
  await freeze("#nav", "stack-uncover", 0);
  assert.equal((await box("#nav"))!.left, -parallax, "the list settles back from its retreat");
  await freeze("#nav", "stack-uncover", 1);
  assert.equal((await box("#nav"))!.left, 0);

  await load(settingsFixture({ origin: "end", stage: "nav" }));
  assert.equal(await page!.evaluate(() => getComputedStyle(document.getElementById("pane")!).display), "none",
    "at rest on the list the page is gone");

  await load(`${settingsFixture({ origin: "end", stage: "page", motion: "push" })}`);
  await freeze("#shell", "stack-in", 1);
  await page!.evaluate(() => {
    const nav = document.getElementById("nav")!;
    nav.setAttribute("data-peek", "true");
    nav.style.setProperty("--stack-peek-x", "-50px");
    nav.style.setProperty("--stack-peek-dim", "0.4");
  });
  const peek = (await box("#nav"))!;
  assert.equal(peek.left, -50, "under a Back swipe the list peeks in, placed by the gesture");
  assert.equal(peek.visibility, "visible");
  assert.equal(await page!.evaluate(() => getComputedStyle(document.getElementById("nav")!, "::after").opacity), "0.4");
});

test("the Navigator holds still under Settings and retreats like any covered layer", { skip: !CHROME }, async () => {
  for (const dir of ["ltr", "rtl"] as const) {
    await load(`<nav class="mobile-navigator is-closing" id="drawer" data-drawer-exit="covered">sessions</nav>`, { dir });
    assert.equal((await box("#drawer"))!.animation, "mobile-navigator-covered");
    await freeze("#drawer", "mobile-navigator-covered", 0);
    assert.equal((await box("#drawer"))!.left, 0, "no race back off-screen under the arriving layer");
    await freeze("#drawer", "mobile-navigator-covered", 1);
    const end = (await box("#drawer"))!;
    assert.equal(end.left, (dir === "ltr" ? 1 : -1) * Math.round(WIDTH * 0.28 * 10) / 10,
      `${dir}: retreats toward the side away from the arriving Settings`);
    assert.equal(end.visibility, "hidden");
  }
});

test("phone sheets and dialogs rise from the bottom edge; centered ones rise in place", { skip: !CHROME }, async () => {
  await load(`<div class="sheet-backdrop"><div class="sheet" id="sheet" style="height:300px">menu</div></div>`);
  assert.equal((await box("#sheet"))!.animation, "sheet-slide-in");
  // `backwards`: once finished it no longer applies, so look at the start first.
  await freeze("#sheet", "sheet-slide-in", 0);
  const start = (await box("#sheet"))!.top;
  await freeze("#sheet", "sheet-slide-in", 1);
  assert.equal(start - (await box("#sheet"))!.top, 300, "one sheet height below its rest: off the bottom edge");

  await load(`<div class="sheet-backdrop is-closing"><div class="sheet is-closing" id="sheet" style="height:300px;--sheet-from:90px">menu</div></div>`);
  assert.equal((await box("#sheet"))!.animation, "sheet-slide-out");
  await freeze("#sheet", "sheet-slide-out", 1);
  const gone = (await box("#sheet"))!.top;
  await freeze("#sheet", "sheet-slide-out", 0);
  assert.equal(gone - (await box("#sheet"))!.top, 210, "a drag's exit starts where the finger let go");

  await load(`<div class="sheet-backdrop"><div class="sheet" id="sheet">menu</div></div>`, { width: 1024 });
  assert.equal((await box("#sheet"))!.animation, "sheet-rise", "a centered sheet has no edge to come from");

  await load(`<div class="dialog-backdrop"><div class="dialog-panel" id="dialog">Confirm?</div></div>`);
  assert.equal((await box("#dialog"))!.animation, "sheet-slide-in", "phone dialogs are bottom sheets");
  await load(`<div class="dialog-backdrop"><div class="dialog-panel" id="dialog">Confirm?</div></div>`, { width: 1024 });
  assert.equal((await box("#dialog"))!.animation, "rise");
  await load(`<div class="dialog-backdrop" data-exit-ghost="dialog"><div class="dialog-panel" id="dialog">Confirm?</div></div>`, { width: 1024 });
  assert.equal((await box("#dialog"))!.animation, "rise-out");
});

test("a notification follows the finger on translate while the stack owns its transform", { skip: !CHROME }, async () => {
  await load(`<div class="notify-stack" data-shell="desktop" style="--notify-stack-h: 80px"><div class="notify-card" id="card" style="transform: translate3d(0, -20px, 0)">Saved nothing</div></div>`);
  await page!.waitForTimeout(600);
  const rest = (await box("#card"))!.left;
  await page!.evaluate(() => { document.getElementById("card")!.style.translate = "60px 0"; });
  assert.equal((await box("#card"))!.left, rest + 60, "translate composes with the stack offset");
  await load(`<div class="notify-stack" data-shell="desktop"><div class="notify-card" id="card" data-exit-ghost="notification-swipe" style="--notify-from: 60px">Saved nothing</div></div>`);
  assert.equal((await box("#card"))!.animation, "notify-swipe-out");
  await freeze("#card", "notify-swipe-out", 0);
  const from = (await box("#card"))!.left;
  await freeze("#card", "notify-swipe-out", 1);
  assert.ok((await box("#card"))!.left > from, "it leaves toward its edge");
});

test("the tablet drawer rests off its inline-start edge in either direction", { skip: !CHROME }, async () => {
  for (const dir of ["ltr", "rtl"] as const) {
    await load(`<div class="app"><nav class="sidebar" id="drawer">sessions</nav></div>`, { dir, width: 834 });
    const closed = await page!.evaluate(() => {
      const r = document.getElementById("drawer")!.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    if (dir === "ltr") assert.ok(closed.right <= 0, `ltr: off the left edge (${JSON.stringify(closed)})`);
    else assert.ok(closed.left >= 834, `rtl: off the right edge (${JSON.stringify(closed)})`);
    await page!.evaluate(() => document.getElementById("drawer")!.classList.add("open"));
    await page!.waitForTimeout(250);
    const open = await page!.evaluate(() => {
      const r = document.getElementById("drawer")!.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    });
    if (dir === "ltr") assert.equal(open.left, 0);
    else assert.equal(open.right, 834, "rtl: the drawer opens from the right, where its swipe pulls it from");
  }
});

test("every transient surface its owner unmounts at once leaves an exit, and the Navigator hands Settings its side", async () => {
  const [popover, menu, dialog, sheet, settings, tours, navigator, feedback] = await Promise.all([
    read("../src/components/ui/Popover.tsx"),
    read("../src/components/ui/Menu.tsx"),
    read("../src/components/a11y/Dialog.tsx"),
    read("../src/components/mobile/Sheet.tsx"),
    read("../src/components/SettingsView.tsx"),
    Promise.all([read("../src/components/ShellIntroTour.tsx"), read("../src/components/PackageTourOverlay.tsx")]),
    read("../src/components/mobile/MobileNavigator.tsx"),
    read("../src/notify/NotificationStack.tsx"),
  ]);
  assert.match(popover, /useExitGhost<HTMLDivElement>\(\(\) => \(\{ kind: "popover" \}\), surfaceRef\)/);
  assert.match(menu, /useExitGhost<HTMLDivElement>\(\(\) => \(\{ kind: "popover" \}\), surfaceRef\)/);
  assert.match(dialog, /useExitGhost<HTMLDivElement>\(\(\) => \(\{ kind: "dialog" \}\), backdropRef\)/);
  assert.match(sheet, /closingRef\.current \|\| leaving\.current\.stackPhase \|\| leaving\.current\.peeking \? null : \{ kind: "sheet" \}/,
    "a sheet that plays its own exit (presence, stack layer) or never opened (peek) leaves no ghost");
  assert.match(settings, /useExitGhost<HTMLDivElement>\(\(\) => \(\{ kind: "settings" \}\), scrimRef\)/);
  for (const tour of tours) assert.match(tour, /useExitGhost<HTMLDivElement>\(\(\) => \(\{ kind: "tour" \}\)/);
  assert.match(feedback, /useExitGhost<HTMLDivElement>\(\s*\(\) => \(\{ kind: swiped\.current \?\? "notification" \}\)/,
    "a notification leaves as a ghost: the way it was swiped, back toward its edge otherwise");
  assert.match(feedback, /swiped\.current = "notification-swipe";/);
  assert.match(feedback, /swiped\.current = "notification-lift";/);
  assert.match(navigator, /presentSettingsFrom\("start"\);\s*setDrawerExit\("covered"\);\s*setSidebarOpen\(false\);\s*setOverlay\("settings"\);/,
    "Settings opened from the Navigator takes the Navigator's side and covers it");
});

test("a Navigator session row tracks the finger 1:1 and only settles with a transition", { skip: !CHROME }, async () => {
  await load(`<nav class="mobile-navigator"><div class="mobile-nav-session-swipe" id="swipe"><div class="mobile-nav-session-row" id="row">Session</div></div></nav>`);
  const style = () => page!.evaluate(() => {
    const row = getComputedStyle(document.getElementById("row")!);
    return { transition: row.transitionProperty, willChange: row.willChange };
  });
  const rest = await style();
  assert.match(rest.transition, /transform/, "released, the row settles into place");
  assert.equal(rest.willChange, "auto", "a row at rest holds no layer of its own");
  await page!.evaluate(() => document.getElementById("swipe")!.classList.add("is-dragging"));
  const dragging = await style();
  assert.doesNotMatch(dragging.transition, /transform/, "under the finger nothing trails it");
  assert.equal(dragging.willChange, "transform");
});
