// The composer card's icon grid, measured in the REAL Composer: the model line
// and the rail stand on the pending stack's columns in every look, width,
// pointer and state (composerAdaptive.css "Composer icon grid", docs/dev/ui.md).
// - Add and the model logo centre on one column, --composer-stack-mark (26px)
//   from the card's outer start edge.
// - The Send/Stop disc ends --composer-stack-end (18px) from the outer end edge.
// - The model line centres --composer-row-mid (28px) below the card's top edge
//   and the rail as far above its bottom edge.
// - Where a look rules the model line off from the editor («Лінія»), the line
//   centres between the row's top edge and that rule.
// - Neighbouring rail glyphs are evenly spaced, and the disc keeps that space;
//   on the model line the caret and every glyph after it keep that same space.
// - A phone's resting row and its engaged card put Add, the quick launcher and
//   Send in the same place, so nothing jumps while the card opens.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../buildConfig.ts";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ORIGIN = "http://composer-icon-grid.test";
const LOOKS = ["standard", "paper", "line", "air", "monolith", "monolith-reverse", "obsidian", "editorial"];
const MARK = 26;
const END = 18;
const MID = 28;
const SLACK = 0.5;

let browser: Browser | null = null;
let html = "";

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  html = await fixture();
});

after(async () => {
  await browser?.close();
});

async function fixture(): Promise<string> {
  const css = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
    outdir: "/tmp/opencode/composer-icon-grid-css",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  // Launchers as packages contribute them: quiet host icon buttons, as mini
  // widgets on a phone (the rail arranges those) and as slot items elsewhere;
  // one glyph on the model line, as a route indicator would add.
  const entry = `
    import { createElement as h } from "react";
    import { createRoot } from "react-dom/client";
    import { api } from "@polyth/session/web-api";
    import Composer from "./components/Composer.tsx";
    import * as store from "./store.ts";
    import { setUiSettings } from "./uiPrefs.ts";
    import { registerWidget } from "./widgets/catalog.ts";
    import { registerSlot } from "./slots.ts";
    import { mobileRailKey, writeMobileRail } from "./composer/mobileRail.ts";
    import { IconButton, MicIcon, VoiceModeIcon } from "./components/ui/index.ts";
    const q = new URLSearchParams(location.hash.slice(1));
    const SID = "s1";
    const MODEL = { providerID: "anthropic", modelID: "opus", harnessId: "claude" };
    api.listWorktrees = async () => [{ path: "/repo", branch: "master", head: "0", isMain: true }];
    api.gitBranches = async () => ({ current: "master", branches: [{ name: "master", current: true }] });
    api.listSessionSummaries = async () => ({ sessions: [] });
    // Package launchers wrap their button in an inline-flex box (dictation, voice mode).
    const wrap = { display: "inline-flex", alignItems: "center", minWidth: 0 };
    const mic = () => h("span", { className: "mic-control", style: wrap }, h(IconButton, { className: "mic-btn", icon: MicIcon, size: "md", variant: "ghost", label: "Dictate" }));
    const voice = () => h("span", { className: "voice-launch", style: wrap }, h(IconButton, { icon: VoiceModeIcon, size: "md", variant: "ghost", label: "Voice" }));
    if (q.get("phone") === "1") {
      const widget = { kind: "mini-widget", defaultVisible: true, defaultSize: { w: 1, h: 1 }, resizable: false, audience: "simple" };
      registerWidget({ ...widget, id: "grid.mic", title: "Dictate", defaultSlot: "composer.leading", supportedSlots: ["composer.leading"], order: 5, render: mic });
      registerWidget({ ...widget, id: "grid.voice", title: "Voice", defaultSlot: "composer.trailing", supportedSlots: ["composer.trailing"], order: 6, render: voice });
      if (q.get("rail") === "end") writeMobileRail(mobileRailKey("", "p1"), { start: ["host:add"], end: ["widget:grid.voice", "widget:grid.mic"] });
    } else {
      registerSlot("composer.leading", "grid.mic", mic, 5);
      registerSlot("composer.trailing", "grid.voice", voice, 6);
    }
    // A route glyph that follows the line's rhythm, as peak pricing's dot does.
    const lineGlyph = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: "calc(16px + 2 * var(--composer-line-inset))", padding: 0, border: 0, background: "none" };
    registerSlot("composer.config", "grid.indicator", () => h("span", { className: "grid-route" },
      h("button", { type: "button", className: "grid-indicator", style: lineGlyph, "aria-label": "Route" },
        h("svg", { viewBox: "0 0 16 16", width: 16, height: 16 }, h("circle", { cx: 8, cy: 8, r: 6, fill: "none", stroke: "currentColor" })))), 20);
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [{ id: "p1", path: "/repo", name: "Repo", createdAt: 0 }]);
    store.activateProject("p1");
    store.setModels([{ ...MODEL, name: "Opus", connected: true, context: 200000 }]);
    store.setSessions("p1", [{
      id: SID, projectId: "p1", title: "Grid", status: q.get("state") === "running" ? "working" : "idle", createdAt: 1, updatedAt: 1, lastTurnAt: 1,
      attention: { questions: 0, permissions: 0, unread: 0 }, model: MODEL, resolvedHarnessId: "claude",
      contextWindow: { limitTokens: 200000, usedTokens: 6000, source: "native", updatedAt: Date.now(), harnessId: "claude" },
    }]);
    store.activateSession(SID);
    if (q.get("state") === "running") store.applyEvent({ id: "e1", sessionId: SID, seq: 1, time: Date.now(), type: "turn/started", data: { turnId: "t", model: MODEL, harnessId: "claude" }, v: 1 });
    window.__look = (look) => {
      store.updateSettings({ appearanceMode: "light", themeStyle: "liquid-glass" });
      setUiSettings({ shellLook: look });
    };
    createRoot(document.querySelector("#mount")).render(
      h("div", { className: "focus-conversation" },
        h("div", { className: "timeline-wrap" }, h("div", { className: "timeline" })),
        h("div", { className: "conversation-composer-dock" }, h(Composer))));
    window.__ready = true;
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "composer-icon-grid-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/opencode/composer-icon-grid-js",
    loader: { ".css": "empty", ".json": "json" },
    write: false, sourcemap: false, minify: true, logLevel: "silent",
  })).outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${css}</style>
    <script>
      window.fetch = async (input) => String(input).includes("/api/prompt-history")
        ? new Response('{"items":[]}', { status: 200, headers: { "content-type": "application/json" } })
        : new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    </script></head>
    <body><div id="root"><div class="app"><div class="app-shell"><main class="main">
      <div id="mount" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%"></div>
    </main></div></div></div>
    <script>${js.replaceAll("</script", "<\\/script")}</script>
    </body></html>`;
}

type Device = "phone" | "tablet" | "desktop";

async function open(device: Device, hash: string): Promise<Page> {
  assert.ok(browser);
  const touch = device !== "desktop";
  const context = await browser.newContext({
    viewport: device === "phone" ? { width: 390, height: 844 } : device === "tablet" ? { width: 820, height: 1100 } : { width: 1280, height: 860 },
    isMobile: touch, hasTouch: touch,
  });
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/#${hash}${device === "phone" ? "&phone=1" : ""}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.waitForSelector(".composer-card .composer-add-trigger");
  return page;
}

async function settle(page: Page, look: string): Promise<void> {
  await page.evaluate((name) => (window as unknown as { __look: (look: string) => void }).__look(name), look);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      try { if (animation.playState !== "finished") animation.finish(); } catch { /* an endless loop has no end to jump to */ }
    }
  });
  await page.waitForTimeout(60);
}

interface Grid {
  logo: { x: number; y: number } | null;
  /** The model line's band: the logo's centre from the row's top edge and from its bottom rule. */
  band: { above: number; below: number; rule: number } | null;
  /** The model line's caret, then each glyph after it: frame edges from the card's start edge. */
  line: { name: string; left: number; right: number }[];
  /** Rail glyphs in reading order, edges and centres from the card's outer edges. */
  glyphs: { name: string; left: number; right: number; x: number; fromBottom: number }[];
  disc: { right: number; x: number; fromBottom: number; left: number };
}

const measure = (page: Page): Promise<Grid> => page.evaluate(() => {
  const card = document.querySelector(".composer-card")!.getBoundingClientRect();
  const shown = (element: Element | null): element is Element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  };
  const logo = document.querySelector(".composer-config-row .model-trigger-logo");
  const logoRect = shown(logo) ? logo.getBoundingClientRect() : null;
  const row = document.querySelector(".composer-config-row");
  let band = null;
  if (shown(row) && logoRect) {
    const rect = row.getBoundingClientRect();
    const rule = parseFloat(getComputedStyle(row).borderBottomWidth);
    const centre = logoRect.top + logoRect.height / 2;
    band = { above: centre - rect.top, below: rect.bottom - rule - centre, rule };
  }
  const line = ([
    ["caret", ".composer-config-row .config-chip-caret svg, .composer-config-row svg.config-chip-caret"],
    ["pie", ".composer-config-row .composer-context-pie svg"],
    ["route", ".composer-config-row .grid-indicator svg"],
  ] as const).flatMap(([name, selector]) => {
    const svg = document.querySelector(selector);
    if (!shown(svg)) return [];
    const rect = svg.getBoundingClientRect();
    return [{ name, left: rect.left - card.left, right: rect.right - card.left }];
  });
  const rail = [...document.querySelectorAll(".composer-card :is(.composer-add-trigger, .mic-btn, .voice-launch button) svg")]
    .filter(shown)
    .map((svg) => {
      const rect = svg.getBoundingClientRect();
      const button = svg.closest("button")!;
      const name = button.classList.contains("composer-add-trigger") ? "add" : button.classList.contains("mic-btn") ? "mic" : "voice";
      return { name, left: rect.left - card.left, right: rect.right - card.left, x: rect.left + rect.width / 2 - card.left, fromBottom: card.bottom - (rect.top + rect.height / 2) };
    })
    .sort((a, b) => a.x - b.x);
  const primary = [...document.querySelectorAll(".composer-card .composer-rail :is(.send, .stop)")].find(shown)!.getBoundingClientRect();
  return {
    logo: logoRect ? { x: logoRect.left + logoRect.width / 2 - card.left, y: logoRect.top + logoRect.height / 2 - card.top } : null,
    band,
    line,
    glyphs: rail,
    disc: { right: card.right - primary.right, x: card.right - (primary.left + primary.width / 2), fromBottom: card.bottom - (primary.top + primary.height / 2), left: primary.left - card.left },
  };
});

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= SLACK, `${what}: ${actual.toFixed(2)}px, expected ${expected}px`);

function assertGrid(grid: Grid, where: string, { engaged = true } = {}): void {
  const add = grid.glyphs.find((glyph) => glyph.name === "add");
  assert.ok(add, `${where}: Add is on the rail`);
  near(add.x, MARK, `${where}: Add centres on the leading column`);
  near(grid.disc.right, END, `${where}: the disc ends on the trailing column`);
  for (const glyph of grid.glyphs) near(glyph.fromBottom, MID, `${where}: ${glyph.name} centres on the rail line`);
  near(grid.disc.fromBottom, MID, `${where}: the disc centres on the rail line`);
  if (!engaged) return;
  assert.ok(grid.logo, `${where}: the model line shows its logo`);
  near(grid.logo.x, MARK, `${where}: the model logo centres on the leading column`);
  near(grid.logo.y, MID, `${where}: the model line centres below the card's top edge`);
}

/** «Лінія» draws a rule under the model line, so the line centres in that band. */
function assertRuledLine(grid: Grid, where: string): void {
  assert.ok(grid.band, `${where}: the model line shows its band`);
  assert.ok(grid.band.rule > 0, `${where}: a rule closes the model line`);
  near(grid.band.below, grid.band.above, `${where}: the model line centres between the row's top edge and its rule`);
}

/** The model line steps from the caret to each glyph by the rail's own space. */
function assertLine(grid: Grid, step: number, where: string): void {
  assert.deepEqual(grid.line.map((glyph) => glyph.name), ["caret", "pie", "route"], `${where}: the model line shows its caret, the context pie and the route glyph`);
  for (let index = 1; index < grid.line.length; index += 1) {
    const [before, glyph] = [grid.line[index - 1]!, grid.line[index]!];
    near(glyph.left - before.right, step, `${where}: ${before.name} → ${glyph.name} keeps the rail's glyph space`);
  }
}

/** Space between neighbouring glyphs of one run, and from the last one to the disc. */
function spacing(grid: Grid): { runs: number[]; toDisc: number } {
  const runs: number[] = [];
  for (let index = 1; index < grid.glyphs.length; index += 1) {
    const space = grid.glyphs[index]!.left - grid.glyphs[index - 1]!.right;
    if (space < 40) runs.push(space);
  }
  return { runs, toDisc: grid.disc.left - grid.glyphs.at(-1)!.right };
}

test("desktop: one grid for the model line and the rail in every look", { skip: !CHROME }, async () => {
  const page = await open("desktop", "state=running");
  try {
    for (const look of LOOKS) {
      await settle(page, look);
      const grid = await measure(page);
      assertGrid(grid, `desktop/${look}`);
      if (look === "line") assertRuledLine(grid, `desktop/${look}`);
      const { runs, toDisc } = spacing(grid);
      assert.deepEqual(grid.glyphs.map((glyph) => glyph.name), ["add", "mic", "voice"], `desktop/${look}: Add and Dictate lead, Voice stands beside Stop`);
      assert.equal(runs.length, 1, `desktop/${look}: Add and Dictate are neighbours`);
      near(toDisc, runs[0]!, `desktop/${look}: the disc stands as far from Voice as Dictate from Add`);
      assertLine(grid, runs[0]!, `desktop/${look}`);
    }
  } finally {
    await page.context().close();
  }
});

test("tablet: the touch rail keeps the grid and one rhythm", { skip: !CHROME }, async () => {
  const page = await open("tablet", "state=running");
  try {
    await settle(page, "standard");
    const grid = await measure(page);
    assertGrid(grid, "tablet");
    const { runs, toDisc } = spacing(grid);
    assert.equal(runs.length, 1, "tablet: Add and Dictate are neighbours");
    near(toDisc, runs[0]!, "tablet: the disc stands as far from Voice as Dictate from Add");
    assertLine(grid, runs[0]!, "tablet");
  } finally {
    await page.context().close();
  }
});

test("phone: the engaged card keeps the grid with the launchers beside Stop, in every look", { skip: !CHROME }, async () => {
  const page = await open("phone", "state=running&rail=end");
  try {
    await page.locator(".composer textarea[data-composer-input]").focus();
    for (const look of LOOKS) {
      await settle(page, look);
      const grid = await measure(page);
      assertGrid(grid, `phone/${look}`);
      if (look === "line") assertRuledLine(grid, `phone/${look}`);
      assert.deepEqual(grid.glyphs.map((glyph) => glyph.name), ["add", "voice", "mic"], `phone/${look}: Voice and Dictate stand beside Stop`);
      const { runs, toDisc } = spacing(grid);
      assert.equal(runs.length, 1, `phone/${look}: Voice and Dictate are neighbours`);
      near(toDisc, runs[0]!, `phone/${look}: the disc stands as far from Dictate as Dictate from Voice`);
      assertLine(grid, runs[0]!, `phone/${look}`);
    }
  } finally {
    await page.context().close();
  }
});

test("phone: launchers leading the rail step evenly from Add", { skip: !CHROME }, async () => {
  const page = await open("phone", "state=idle");
  try {
    await page.locator(".composer textarea[data-composer-input]").focus();
    await settle(page, "standard");
    const grid = await measure(page);
    assertGrid(grid, "phone/default");
    const { runs } = spacing(grid);
    assert.equal(runs.length, 2, "phone/default: Add, Dictate and Voice lead the rail together");
    near(runs[1]!, runs[0]!, "phone/default: Dictate is as far from Add as Voice from Dictate");
  } finally {
    await page.context().close();
  }
});

test("phone: Add, the quick launcher and Send hold still while the card opens", { skip: !CHROME }, async () => {
  const page = await open("phone", "state=idle&rail=end");
  try {
    await settle(page, "standard");
    assert.equal(await page.locator(".composer.composer-collapsed").count(), 1, "the composer starts as the resting row");
    const resting = await measure(page);
    assertGrid(resting, "phone/resting", { engaged: false });
    await page.locator(".composer textarea[data-composer-input]").focus();
    await settle(page, "standard");
    assert.equal(await page.locator(".composer.composer-expanded").count(), 1, "focus opens the card");
    const engaged = await measure(page);
    assertGrid(engaged, "phone/engaged");
    const restingMic = resting.glyphs.find((glyph) => glyph.name === "mic");
    const engagedMic = engaged.glyphs.find((glyph) => glyph.name === "mic");
    assert.ok(restingMic && engagedMic, "Dictate is the resting row's quick launcher and stays on the rail");
    near(engagedMic.x, restingMic.x, "Dictate keeps its column");
    near(engagedMic.fromBottom, restingMic.fromBottom, "Dictate keeps its line");
    near(engaged.disc.x, resting.disc.x, "Send keeps its column");
  } finally {
    await page.context().close();
  }
});
