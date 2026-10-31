import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { chromium, type Browser, type Page } from "playwright-core";

// Real shell CSS, real class names, and the CSS variables mobileViewport.ts
// publishes — so a full-height layer is judged by where it is laid out, not by
// what its rules say. Set POLYTH_CHROMIUM_PATH for a system browser; this test
// never downloads one. Chromium is not WebKit: the WebKit accessory guard and
// the containing-block difference below are emulated in the cascade only.
const read = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
const executablePath = process.env.POLYTH_CHROMIUM_PATH || chromium.executablePath();
const available = await access(executablePath, constants.X_OK).then(() => true, () => false);
if (!available && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("Mobile viewport layer tests require an installed Chromium (POLYTH_CHROMIUM_PATH).");
}

let browser: Browser;
let css: string;
let revealSource: string;
before(async () => {
  css = (await Promise.all([
    "tokens.css", "styles.css", "moduleContent.css", "composerAdaptive.css", "mobileViewport.css",
    // Component CSS arrives with the lazily imported app graph, after the
    // static sheets main.tsx loads, so it is last here as well.
    "components/mobile/MobileNavigator.css",
  ].map(read))).join("\n").replace(/@import[^;]+;/g, "");
  revealSource = stripTypeScriptTypes(await read("mobileFieldReveal.ts")).replace(/^export /gm, "");
  if (available) browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); });

const WIDTH = 390;
const ACCESSORY = 48;

// `inset` is --keyboard-inset as mobileViewport.ts publishes it: the layout left below the band in a
// Safari pan, the native keyboard height in a WebView that has already shrunk its layout.
interface Engine { id: string; layout: number; visual: number; offset: number; keyboard: boolean; inset: number }
// How the keyboard reaches the page. Safari keeps the layout viewport tall and
// pans the visual band inside it; a native-resize WebView shrinks the layout.
const ENGINES: Engine[] = [
  { id: "closed", layout: 844, visual: 844, offset: 0, keyboard: false, inset: 0 },
  { id: "Safari, band panned partway", layout: 844, visual: 508, offset: 120, keyboard: true, inset: 216 },
  { id: "Safari, band panned to the layout bottom", layout: 844, visual: 508, offset: 336, keyboard: true, inset: 0 },
  { id: "Safari, no pan", layout: 844, visual: 508, offset: 0, keyboard: true, inset: 336 },
  { id: "native resize", layout: 508, visual: 508, offset: 0, keyboard: true, inset: 336 },
];

interface Variant { name: string; webkit: boolean; contained: boolean }
const VARIANTS: Variant[] = [
  { name: "fixed layers resolve against the viewport", webkit: false, contained: false },
  { name: "WebKit accessory band", webkit: true, contained: false },
  // Chromium does not make a `container-type` box the containing block of its
  // fixed descendants; `contain: layout` is what WebKit's layout containment
  // for a query container would add to `.app-shell`.
  { name: "fixed layers contained by .app-shell", webkit: false, contained: true },
  { name: "WebKit accessory band, contained", webkit: true, contained: true },
];

function sheetFor(variant: Variant): string {
  const guarded = variant.webkit
    ? css.replaceAll("@supports (-webkit-touch-callout: none)", "@supports (display: block)")
    : css;
  return variant.contained ? `${guarded}\n.app-shell { contain: layout; }` : guarded;
}

const rows = (count: number) => Array.from({ length: count }, (_, i) =>
  `<label class="row" style="display:block;padding:10px 0">Field ${i}<input class="ui-input" value="v${i}"></label>`).join("");
const moduleView = (variant: string) => `<section class="module-view module-view--${variant} module-view--phone" data-content-mode="page" style="--module-depth:0">
  <header class="module-view-head"><span class="module-view-icon">▣</span><div class="module-view-heading"><h1 class="module-view-title">Module</h1></div><span class="header-spacer"></span><button class="ui-icon-btn module-view-close">×</button></header>
  <div class="module-view-body"><div class="module-view-content module-view-content--page">${rows(22)}</div></div></section>`;
const settingRows = Array.from({ length: 22 }, (_, i) =>
  `<div class="set-row"><div class="set-row-text"><div class="set-row-label">Setting ${i}</div></div><div class="set-row-control"><input class="ui-input" value="value ${i}"></div></div>`).join("");
// A page id is a class on the shell, so a page-scoped rule can re-size the
// layer for that page alone; Usage once kept a 4vh/2vw box on phones.
const settings = (stage: "page" | "nav", pageId = "general") => `<div class="scrim settings-scrim"><div class="modal settings-shell settings-page-${pageId} settings-mobile-${stage}">
  <div class="modal-nav settings-nav"><div class="settings-mobile-nav-head"><strong>Settings</strong><button class="ui-icon-btn" aria-label="Close">×</button></div>
    <div class="settings-nav-search-shell"><input class="ui-input ui-input--sm settings-nav-search" type="search" placeholder="Search settings"></div>
    <nav class="settings-nav-list">${Array.from({ length: 24 }, (_, i) => `<button class="settings-nav-item"><span class="settings-nav-label">Page ${i}</span></button>`).join("")}</nav></div>
  <div class="modal-main settings-pane"><div class="modal-head settings-pane-head"><div class="settings-pane-head-bar"><button class="settings-mobile-back">Back</button><h1 class="settings-mobile-title">General</h1><div class="settings-pane-head-actions"><button class="ui-icon-btn" aria-label="Close">×</button></div></div></div>
    <div class="modal-body settings-pane-body">${settingRows}</div></div></div></div>`;

const shell = ({ main = "", inShell = "", inApp = "" }) => `<div class="app mode-chat view-session">
  <div class="app-shell">${inShell}
    <div class="workspace"><main class="main"><div class="focus-conversation"><div class="timeline chat-probe" style="background:#b00020;color:#fff">CHAT</div>
      <div class="conversation-composer-dock"><div class="composer composer-mobile"><div class="composer-card">composer</div></div></div></div>${main}</main></div>
  </div>${inApp}</div>`;

interface Family { html: string; layer: string; head: string; scroller: string }
const FAMILIES: Record<string, Family> = {
  "settings page": { html: shell({ inApp: settings("page") }), layer: ".settings-shell", head: ".settings-pane-head", scroller: ".settings-pane-body" },
  "usage settings page": { html: shell({ inApp: settings("page", "usage") }), layer: ".settings-shell", head: ".settings-pane-head", scroller: ".settings-pane-body" },
  "settings navigation": { html: shell({ inApp: settings("nav") }), layer: ".settings-shell", head: ".settings-mobile-nav-head", scroller: ".settings-nav-list" },
  "phone navigator": {
    html: shell({ inShell: `<div class="mobile-nav-backdrop"></div><nav class="mobile-navigator" role="dialog"><div class="mobile-nav-toolbar"><div class="mobile-nav-search"><input type="search" placeholder="Search"></div></div><div class="mobile-nav-scroll">${rows(22)}</div></nav>` }),
    layer: ".mobile-navigator", head: ".mobile-nav-toolbar", scroller: ".mobile-nav-scroll",
  },
  "main module view": { html: shell({ main: moduleView("main") }), layer: ".module-view--main", head: ".module-view-head", scroller: ".module-view-content" },
  "fullscreen rail pane": {
    html: shell({ inShell: `<aside class="railbar railbar-open" data-rail-motion="open"><div class="rail rail-workspace rail-fullscreen" data-rail-motion="open" role="dialog">${moduleView("rail")}</div></aside>` }),
    layer: ".rail-fullscreen", head: ".module-view-head", scroller: ".module-view-content",
  },
  "panel sheet": {
    html: shell({ inShell: `<div class="menu-backdrop panel-sheet-backdrop"></div><aside class="railbar railbar-open" data-rail-motion="open"><div id="polyth-panel-sheet" class="panel-sheet" data-rail-motion="open" role="dialog" aria-modal="true">${moduleView("rail")}</div></aside>` }),
    layer: ".panel-sheet", head: ".module-view-head", scroller: ".module-view-content",
  },
  "narrow drawer": {
    html: shell({ inShell: `<div class="sidebar-backdrop"></div><nav class="sidebar open"><div class="sidebar-drawer-header"><button class="ui-icon-btn">☰</button><input class="ui-input" type="search" placeholder="Search sessions" style="flex:1"></div><div class="side-scroll">${rows(22)}</div></nav>` }),
    layer: ".sidebar", head: ".sidebar-drawer-header", scroller: ".side-scroll",
  },
};

async function open(variant: Variant, html: string, width = WIDTH): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${sheetFor(variant)}</style><body><div id="root">${html}</div></body>`);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "47px");
    document.documentElement.style.setProperty("--safe-bottom", "34px");
  });
  return { page, close: () => context.close() };
}

/** What mobileViewport.ts publish() writes for this measurement. */
async function publish(page: Page, engine: Engine, width = WIDTH, webkit = false) {
  await page.setViewportSize({ width, height: engine.layout });
  await page.evaluate(({ e, webkit }) => {
    const root = document.documentElement;
    const top = e.keyboard ? Math.max(0, e.offset) : 0;
    const height = e.keyboard ? e.visual : e.layout;
    root.style.setProperty("--visual-vh", `${e.visual}px`);
    root.style.setProperty("--visual-offset", `${e.offset}px`);
    root.style.setProperty("--visual-frame-top", `${top}px`);
    root.style.setProperty("--visual-frame-height", `${height}px`);
    root.style.setProperty("--visual-frame-bottom", `${top + height}px`);
    root.style.setProperty("--visual-bottom", `${top + height}px`);
    root.style.setProperty("--keyboard-inset", `${e.inset}px`);
    // The shared lower edge, with the WebKit accessory band the runtime adds
    // while the keyboard is open (the token's value) on WebKit only.
    const band = webkit && e.keyboard
      ? Number.parseFloat(getComputedStyle(root).getPropertyValue("--keyboard-accessory-band")) || 0
      : 0;
    root.style.setProperty("--layer-frame-bottom", `${top + height + band}px`);
    root.dataset.keyboardFrame = e.keyboard ? "open" : "closed";
    document.body.dataset.keyboard = e.keyboard ? "open" : "closed";
    document.body.dataset.band = e.visual < 420 ? "short" : "tall";
    document.getAnimations().forEach((animation) => animation.finish());
  }, { e: engine, webkit });
}

// Hit points sit well inside the 320px-wide drawer and the full-width layers.
const PROBE_X = 150;

const near = (actual: number, expected: number) => Math.abs(actual - expected) <= 1;

for (const variant of VARIANTS) for (const [name, family] of Object.entries(FAMILIES)) {
  test(`${variant.name}: ${name} fills the keyboard band in every engine model`, { skip: !available }, async () => {
    const { page, close } = await open(variant, family.html);
    try {
      for (const engine of ENGINES) {
        await publish(page, engine, WIDTH, variant.webkit);
        const bandTop = engine.keyboard ? engine.offset : 0;
        const frameBottom = engine.keyboard ? engine.offset + engine.visual : engine.layout;
        // The layer ends where the app chain ends: the measured frame, plus the
        // WebKit text-input accessory band while the keyboard is open.
        const bottom = frameBottom + (variant.webkit && engine.keyboard ? ACCESSORY : 0);
        const m = await page.evaluate(({ layer, head, scroller, probeX }) => {
          const box = (element: Element | null) => {
            if (!element) return null;
            const r = element.getBoundingClientRect();
            return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
          };
          const layerEl = document.querySelector(layer)!;
          const scrollerEl = document.querySelector<HTMLElement>(scroller)!;
          scrollerEl.scrollTop = scrollerEl.scrollHeight;
          const inputs = [...layerEl.querySelectorAll("input")].filter((input) => input.getClientRects().length > 0);
          const hitAt = (y: number) => !!document.elementFromPoint(probeX, Math.max(1, Math.min(window.innerHeight - 1, y)))?.closest(layer);
          return {
            layer: box(layerEl)!, root: box(document.getElementById("root"))!, head: box(document.querySelector(head))!,
            scroller: box(scrollerEl)!, lastInput: box(inputs[inputs.length - 1] ?? null),
            hitTop: hitAt(Math.max(1, (box(layerEl)!.top) + 4)),
            hitBottom: hitAt(Math.min(window.innerHeight, box(layerEl)!.bottom) - 4),
          };
        }, { layer: family.layer, head: family.head, scroller: family.scroller, probeX: PROBE_X });
        const where = `${name} / ${engine.id}`;

        if (!engine.keyboard) {
          // Closed: unchanged. `inset: 0` is the one box that reaches the physical screen edge.
          assert.ok(near(m.layer.top, 0) && near(m.layer.bottom, engine.layout),
            `${where}: closed layer is the full layout box (got ${m.layer.top}..${m.layer.bottom})`);
          continue;
        }
        assert.ok(near(m.layer.top, bandTop), `${where}: layer starts at the band top ${bandTop} (got ${m.layer.top}) — it slid away from what the user sees`);
        assert.ok(near(m.layer.bottom, bottom), `${where}: layer ends at the frame bottom ${bottom} (got ${m.layer.bottom})`);
        assert.ok(near(m.root.bottom, bottom), `${where}: app chain ends at ${bottom} (got ${m.root.bottom}); layers and app must share one bottom edge`);
        assert.ok(m.hitTop && m.hitBottom, `${where}: the layer is what answers at the top and bottom of the band, not the chat behind it`);
        assert.ok(m.head.top >= bandTop - 1 && m.head.bottom <= bottom + 1, `${where}: header stays inside the band (${m.head.top}..${m.head.bottom})`);
        const usable = Math.max(0, Math.min(m.scroller.bottom, bottom) - Math.max(m.scroller.top, bandTop));
        assert.ok(usable >= (bottom - bandTop) * 0.4, `${where}: scroll area keeps ≥40% of the band (got ${usable}px of ${bottom - bandTop}px) — the keyboard is subtracted twice`);
        assert.ok(m.lastInput && m.lastInput.top >= bandTop - 1 && m.lastInput.bottom <= bottom + 1,
          `${where}: the last field can be scrolled above the keyboard (got ${JSON.stringify(m.lastInput)})`);
      }
    } finally {
      await close();
    }
  });
}

for (const variant of VARIANTS) {
  test(`${variant.name}: the widget catalog sheet sits on the band's bottom edge, above the keyboard`, { skip: !available }, async () => {
    // A bottom sheet with a search field: pinned with `bottom: 0`, it would sit
    // behind a keyboard that a Safari pan left uncovered in the layout.
    const sheet = `<div class="widget-workspace"><aside class="widget-add-panel widget-menu-single catalog-picker">
      <div class="widget-add-head catalog-picker-head"><strong>Add widgets</strong><button class="ui-icon-btn">×</button></div>
      <input class="ui-input" type="search" placeholder="Search widgets">
      ${Array.from({ length: 30 }, (_, i) => `<div style="height:44px">Widget ${i}</div>`).join("")}</aside></div>`;
    const { page, close } = await open(variant, shell({ main: sheet }));
    try {
      for (const engine of ENGINES) {
        await publish(page, engine, WIDTH, variant.webkit);
        const bandTop = engine.keyboard ? engine.offset : 0;
        const bottom = (engine.keyboard ? engine.offset + engine.visual : engine.layout) + (variant.webkit && engine.keyboard ? ACCESSORY : 0);
        const m = await page.evaluate((probeX) => {
          const panel = document.querySelector(".widget-add-panel")!;
          const r = panel.getBoundingClientRect();
          const input = panel.querySelector("input")!.getBoundingClientRect();
          const hit = document.elementFromPoint(probeX, Math.min(window.innerHeight, r.bottom) - 4);
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), input: { top: Math.round(input.top), bottom: Math.round(input.bottom) }, hit: !!hit?.closest(".widget-add-panel") };
        }, PROBE_X);
        assert.ok(near(m.bottom, bottom), `${engine.id}: the sheet ends at the band bottom ${bottom} (got ${m.bottom})`);
        assert.ok(m.top >= bandTop - 1, `${engine.id}: the sheet stays below the band top ${bandTop} (got ${m.top})`);
        assert.ok(m.input.top >= bandTop - 1 && m.input.bottom <= bottom + 1, `${engine.id}: the search field is inside the band (got ${m.input.top}..${m.input.bottom})`);
        assert.ok(m.hit, `${engine.id}: the sheet answers at its bottom edge`);
      }
    } finally {
      await close();
    }
  });
}

test("the Settings modal stays inside the band on a tablet width and keeps its inset from the scrim", { skip: !available }, async () => {
  // Above 700px Settings is a centred modal, not a full-bleed page. The scrim
  // takes the band and the modal, whose height is 94vh when closed, yields to it.
  const width = 768;
  const { page, close } = await open(VARIANTS[0]!, FAMILIES["settings page"]!.html, width);
  try {
    for (const engine of [
      { id: "closed", layout: 1024, visual: 1024, offset: 0, keyboard: false, inset: 0 },
      { id: "band panned partway", layout: 1024, visual: 560, offset: 180, keyboard: true, inset: 284 },
      { id: "no pan", layout: 1024, visual: 560, offset: 0, keyboard: true, inset: 464 },
    ] satisfies Engine[]) {
      await publish(page, engine, width);
      const bandTop = engine.keyboard ? engine.offset : 0;
      const bandBottom = engine.keyboard ? engine.offset + engine.visual : engine.layout;
      const m = await page.evaluate(() => {
        const box = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
        };
        return { scrim: box(".settings-scrim"), shell: box(".settings-shell") };
      });
      assert.ok(near(m.scrim.top, bandTop) && near(m.scrim.bottom, bandBottom),
        `${engine.id}: the scrim is the band ${bandTop}..${bandBottom} (got ${m.scrim.top}..${m.scrim.bottom})`);
      assert.ok(m.shell.top >= bandTop && m.shell.bottom <= bandBottom,
        `${engine.id}: the modal stays inside the band (got ${m.shell.top}..${m.shell.bottom})`);
      assert.ok(m.shell.top - bandTop > 0 && bandBottom - m.shell.bottom > 0, `${engine.id}: the modal keeps its inset from the scrim edge`);
    }
  } finally {
    await close();
  }
});

test("a field the shrink pushed out of its scroll container is brought back, and only real scrollers move", { skip: !available }, async () => {
  const family = FAMILIES["settings page"]!;
  const { page, close } = await open(VARIANTS[0]!, family.html);
  try {
    await page.addScriptTag({ content: `${revealSource}\nwindow.revealFieldInScrollers = revealFieldInScrollers;` });
    await publish(page, ENGINES[0]!);
    // The user scrolled a field near the bottom of the closed page and tapped it.
    await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(".settings-pane-body")!;
      const field = body.querySelectorAll("input")[14]!;
      body.scrollTop += field.getBoundingClientRect().bottom - (body.getBoundingClientRect().bottom - 10);
      field.focus({ preventScroll: true });
    });
    const panned = ENGINES[1]!;
    await publish(page, panned);
    const probe = () => page.evaluate(({ top, bottom }) => {
      const body = document.querySelector<HTMLElement>(".settings-pane-body")!;
      const field = document.activeElement as HTMLElement;
      const f = field.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      const head = document.querySelector(".settings-pane-head")!.getBoundingClientRect();
      return {
        inScroller: f.top >= b.top && f.bottom <= b.bottom,
        inBand: f.top >= top && f.bottom <= bottom,
        headInBand: head.top >= top - 1 && head.bottom <= bottom,
        outerScroll: [".settings-shell", ".settings-scrim", ".settings-pane", "body", "html"]
          .map((selector) => document.querySelector(selector)!.scrollTop),
      };
    }, { top: panned.offset, bottom: panned.offset + panned.visual });

    const before = await probe();
    assert.equal(before.inScroller, false, "precondition: the band shrink left the focused field below its scroll container");

    await page.evaluate(() => (window as unknown as { revealFieldInScrollers: (el: Element) => void }).revealFieldInScrollers(document.activeElement!));
    const after = await probe();
    assert.equal(after.inScroller, true, "the field is back inside its scroll container");
    assert.equal(after.inBand, true, "and therefore inside the visible band above the keyboard");
    assert.equal(after.headInBand, true, "the header never moved");
    assert.deepEqual(after.outerScroll, [0, 0, 0, 0, 0], "layout clips (shell, scrim, pane, body, html) are never scrolled");
  } finally {
    await close();
  }
});

test("revealing never scrolls an overflow: hidden box and does nothing for a field already in view", { skip: !available }, async () => {
  const { page, close } = await open(VARIANTS[0]!, `<div id="clip" style="height:100px;overflow:hidden"><div style="height:400px"><input id="deep" style="margin-top:300px"></div></div>
    <div id="scroll" style="height:100px;overflow-y:auto"><div style="height:400px;padding-top:20px"><input id="near"><div style="height:300px"></div></div></div>`);
  try {
    await page.addScriptTag({ content: `${revealSource}\nwindow.revealFieldInScrollers = revealFieldInScrollers;` });
    const result = await page.evaluate(() => {
      const reveal = (window as unknown as { revealFieldInScrollers: (el: Element | null) => void }).revealFieldInScrollers;
      const clip = document.getElementById("clip")!;
      const scroll = document.getElementById("scroll")!;
      reveal(document.getElementById("deep"));
      reveal(document.getElementById("near"));
      reveal(null);
      return { clip: clip.scrollTop, visibleField: scroll.scrollTop };
    });
    assert.equal(result.clip, 0, "an overflow: hidden ancestor is a clip, not a scroller");
    assert.equal(result.visibleField, 0, "a field already inside its scroller is left where it is");
  } finally {
    await close();
  }
});

test("the band block keeps the layers' own top clearance: the notch, not a shell header", () => {
  // Phone module layers cover the shell header, so with the keyboard open the
  // top clearance is the same status-bar/notch inset as in the closed state.
  const base = /:is\(\.module-view--main, \.rail-fullscreen, \.panel-sheet\) \{\s*padding-block-start: var\(--safe-top\);/.exec(css);
  const band = /\[data-keyboard="open"\] :is\(\.module-view--main, \.rail-fullscreen, \.panel-sheet\) \{\s*padding-block-start: var\(--safe-top\);/.exec(css);
  assert.ok(base && band, "both clearance rules exist");
  assert.doesNotMatch(css, /padding-block-start: (?:max\(var\(--safe-top\), )?calc\(60px \+ var\(--safe-top\)/, "no layer reserves the old shell-header strip");
});

// Every shell rule that pins a box to the whole viewport height is one the
// keyboard can strand: either mobileViewport.css moves it into the band, or it
// holds nothing the user types into. A new rule must pick one and say which.
const BAND_ANCHORED = new Set([
  ".scrim", ".mobile-navigator", ".sidebar", ".module-view--main",
  ".rail-fullscreen", ".panel-sheet", ".railbar:is([data-rail-motion=\"open\"], [data-rail-motion=\"exiting\"]):has(> :is(.rail-fullscreen, .panel-sheet))",
]);
const EXEMPT: Record<string, string> = {
  ".mobile-nav-backdrop": "transparent and pointer-events: none",
  ".sidebar-backdrop": "dimming scrim; holds no content",
  ".panel-sheet-backdrop": "dimming scrim; holds no content",
  ".execution-viewer-backdrop": "click-away scrim behind the output viewer",
  ".ui-popover-backdrop": "click-away scrim behind a popover",
  ".shell-intro": "first-run tour overlay; its card holds buttons, no text field",
  ".shell-intro-scrim": "dimming scrim of the first-run tour",
  ".shell-intro-arrow": "pointer-events: none SVG pointer of the first-run tour",
};

test("every full-viewport fixed layer in the shell is either band-anchored or holds no input", { skip: !available }, async () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const sheets: Array<{ file: string; css: string }> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      if ((await stat(path)).isDirectory()) await walk(path);
      else if (entry.endsWith(".css")) sheets.push({ file: path.slice(root.length), css: (await readFile(path, "utf8")).replace(/@import[^;]+;/g, "") });
    }
  };
  await walk(root);

  const page = await browser.newPage();
  try {
    await page.setContent("<!doctype html><body></body>");
    const found = await page.evaluate((all) => {
      const selectors = new Set<string>();
      // `a, :is(b, c)` must split only at top-level commas.
      const split = (text: string) => {
        const parts: string[] = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "(" || text[i] === "[") depth++;
          else if (text[i] === ")" || text[i] === "]") depth--;
          else if (text[i] === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
        }
        parts.push(text.slice(start));
        return parts.map((part) => part.replace(/\s+/g, " ").trim());
      };
      const zero = (value: string) => value === "0px" || value === "0";
      const walkRules = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            const s = rule.style;
            const vertical = (zero(s.getPropertyValue("top")) && zero(s.getPropertyValue("bottom")))
              || zero(s.getPropertyValue("inset"));
            if (s.getPropertyValue("position") === "fixed" && vertical) split(rule.selectorText).forEach((part) => selectors.add(part));
          }
          if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules?.length) walkRules((rule as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of all) {
        const style = document.createElement("style");
        style.textContent = sheet.css;
        document.head.appendChild(style);
        walkRules(style.sheet!.cssRules);
      }
      return [...selectors].sort();
    }, sheets);

    const classified = new Set([...BAND_ANCHORED, ...Object.keys(EXEMPT)]);
    const unclassified = found.filter((selector) => !classified.has(selector));
    assert.deepEqual(unclassified, [],
      "These rules pin a box to the full viewport height. Anchor them to the keyboard band in mobileViewport.css (see its Full-height layers block) and list them in BAND_ANCHORED, or list them in EXEMPT with the reason they hold no input.");
    const stale = [...classified].filter((selector) => !found.includes(selector));
    assert.deepEqual(stale, [], "These classified selectors no longer match a full-height fixed rule; remove them.");
  } finally {
    await page.close();
  }
});
