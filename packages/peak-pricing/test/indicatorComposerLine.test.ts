// The REAL indicator on the REAL composer's model line, in a browser: the dot
// stands in the middle of its own cell and one glyph gap from the context pie,
// the same space the composer keeps between rail buttons (the host's icon grid,
// docs/dev/ui.md "The composer's icon grid"), on a touch phone and with a mouse.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { browserBuildOptions, uiFontScalePlugin } from "../../../apps/web/buildConfig.ts";
import { scaleUiFontSizes } from "../../../apps/web/fontScaleCss.ts";
import { findChromium } from "../../../apps/web/test/chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const HOST = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
const WIDGETS = fileURLToPath(new URL("../widgets/", import.meta.url));
const ORIGIN = "http://peak-pricing-line.test";
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
  const host = (await build({
    ...browserBuildOptions,
    entryPoints: [`${HOST}main.tsx`],
    outdir: "/tmp/opencode/peak-pricing-line-css",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  // Package CSS loads with the package, after the host's, as in the app.
  const css = `${host}\n${scaleUiFontSizes(await readFile(`${WIDGETS}styles.css`, "utf8"))}`;
  const entry = `
    import { createElement as h } from "react";
    import { createRoot } from "react-dom/client";
    import { api } from "@polyth/session/web-api";
    import Composer from "./components/Composer.tsx";
    import * as store from "./store.ts";
    import { registerWidget } from "./widgets/catalog.ts";
    import { registerSlot } from "./slots.ts";
    import { mobileRailKey, writeMobileRail } from "./composer/mobileRail.ts";
    import { IconButton, MicIcon, VoiceModeIcon } from "./components/ui/index.ts";
    import PeakPricingIndicator from ${JSON.stringify(`${WIDGETS}PeakPricingIndicator.tsx`)};
    import { DEFAULT_PEAK_PRICING_PREFS, replacePeakPricingPrefs } from ${JSON.stringify(`${WIDGETS}prefs.ts`)};
    const q = new URLSearchParams(location.hash.slice(1));
    const SID = "s1";
    const MODEL = { providerID: "deepseek-official", modelID: "deepseek-flash", harnessId: "deepseek" };
    api.listWorktrees = async () => [{ path: "/repo", branch: "master", head: "0", isMain: true }];
    api.gitBranches = async () => ({ current: "master", branches: [{ name: "master", current: true }] });
    api.listSessionSummaries = async () => ({ sessions: [] });
    replacePeakPricingPrefs({ ...DEFAULT_PEAK_PRICING_PREFS, enabled: true, display: "dot" });
    // As the package registers it (widgets/index.tsx).
    registerSlot("composer.config", "peak-pricing.indicator", (context) => h(PeakPricingIndicator, {
      model: context.model,
      harnessId: typeof context.resolvedHarnessId === "string" ? context.resolvedHarnessId : context.model?.harnessId,
    }), 20);
    // Two quiet launchers beside Stop give the rail's own glyph space.
    const wrap = { display: "inline-flex", alignItems: "center", minWidth: 0 };
    const mic = () => h("span", { style: wrap }, h(IconButton, { className: "mic-btn", icon: MicIcon, size: "md", variant: "ghost", label: "Dictate" }));
    const voice = () => h("span", { style: wrap }, h(IconButton, { className: "line-voice", icon: VoiceModeIcon, size: "md", variant: "ghost", label: "Voice" }));
    if (q.get("phone") === "1") {
      const widget = { kind: "mini-widget", defaultVisible: true, defaultSize: { w: 1, h: 1 }, resizable: false, audience: "simple" };
      registerWidget({ ...widget, id: "line.mic", title: "Dictate", defaultSlot: "composer.trailing", supportedSlots: ["composer.trailing"], order: 5, render: mic });
      registerWidget({ ...widget, id: "line.voice", title: "Voice", defaultSlot: "composer.trailing", supportedSlots: ["composer.trailing"], order: 6, render: voice });
      writeMobileRail(mobileRailKey("", "p1"), { start: ["host:add"], end: ["widget:line.voice", "widget:line.mic"] });
    } else {
      registerSlot("composer.trailing", "line.voice", voice, 5);
      registerSlot("composer.trailing", "line.mic", mic, 6);
    }
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [{ id: "p1", path: "/repo", name: "Repo", createdAt: 0 }]);
    store.activateProject("p1");
    store.setModels([{ ...MODEL, name: "DeepSeek Flash", connected: true, context: 200000 }]);
    store.setSessions("p1", [{
      id: SID, projectId: "p1", title: "Line", status: "idle", createdAt: 1, updatedAt: 1, lastTurnAt: 1,
      attention: { questions: 0, permissions: 0, unread: 0 }, model: MODEL, resolvedHarnessId: "deepseek",
      contextWindow: { limitTokens: 200000, usedTokens: 6000, source: "native", updatedAt: Date.now(), harnessId: "deepseek" },
    }]);
    store.activateSession(SID);
    createRoot(document.querySelector("#mount")).render(
      h("div", { className: "focus-conversation" },
        h("div", { className: "timeline-wrap" }, h("div", { className: "timeline" })),
        h("div", { className: "conversation-composer-dock" }, h(Composer))));
    window.__ready = true;
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: HOST, loader: "tsx", sourcefile: "peak-pricing-line-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/opencode/peak-pricing-line-js",
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

async function open(phone: boolean): Promise<Page> {
  assert.ok(browser);
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 860 } });
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/#${phone ? "phone=1" : ""}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  // A resting phone row shows only the pie; focus opens the model line.
  await page.waitForSelector(".composer-config-row .peak-pricing-chip[data-display='dot']", { state: "attached" });
  await page.locator(".composer textarea[data-composer-input]").focus();
  await page.waitForSelector(".composer-config-row .peak-pricing-chip[data-display='dot']");
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      try { if (animation.playState !== "finished") animation.finish(); } catch { /* an endless loop has no end */ }
    }
  });
  return page;
}

const measure = (page: Page) => page.evaluate(() => {
  const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
  const chip = rect(".composer-config-row .peak-pricing-chip");
  const ring = rect(".composer-config-row .peak-pricing-glyph");
  const pie = rect(".composer-config-row .composer-context-pie svg");
  const voice = rect(".composer-card .line-voice svg");
  const mic = rect(".composer-card .mic-btn svg");
  return {
    before: ring.left - chip.left,
    after: chip.right - ring.right,
    height: chip.height,
    fromPie: ring.left - pie.right,
    railStep: mic.left - voice.right,
    ringMiddle: ring.top + ring.height / 2,
    pieMiddle: pie.top + pie.height / 2,
  };
});

for (const phone of [true, false]) {
  const where = phone ? "phone" : "desktop";
  test(`${where}: the dot stands in the middle of its cell, one glyph gap after the context pie`, { skip: !CHROME }, async () => {
    const page = await open(phone);
    try {
      const m = await measure(page);
      assert.ok(Math.abs(m.before - m.after) <= SLACK, `${where}: the ring is centred in its cell (${m.before.toFixed(1)}px before, ${m.after.toFixed(1)}px after)`);
      assert.ok(Math.abs(m.fromPie - m.railStep) <= SLACK, `${where}: pie → dot ${m.fromPie.toFixed(1)}px keeps the rail's glyph space ${m.railStep.toFixed(1)}px`);
      assert.ok(Math.abs(m.ringMiddle - m.pieMiddle) <= SLACK, `${where}: the ring shares the pie's line`);
      if (phone) assert.ok(m.height >= 44, `${where}: a tap-tall target (${m.height}px)`);
    } finally {
      await page.context().close();
    }
  });
}
