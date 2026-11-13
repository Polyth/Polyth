// Phone reorder in the real ModelPicker is the Home Screen gesture: a still
// touch hold on a provider lifts it and the same finger drags it down; a tap
// still chooses. Mounts the real picker with the real CSS bundle in headless
// Chromium at 390x844 and drives real touch events through CDP.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../buildConfig.ts";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This test requires Chromium (set POLYTH_CHROMIUM_PATH).");
}
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ORIGIN = "http://model-picker-tap.test";

let browser: Browser | null = null;
let html = "";

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const css = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../src/main.tsx", import.meta.url))],
    outdir: "/tmp/model-picker-tap-css", write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((f) => f.path.endsWith("/main.css"))!.text;
  // The picker stylesheet travels with the component, not the shell bundle.
  const pickerCss = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../../../packages/models/widgets/model-picker-styles.css", import.meta.url))],
    outdir: "/tmp/model-picker-tap-picker", write: false, sourcemap: false, minify: false, logLevel: "silent",
  })).outputFiles.find((f) => f.path.endsWith(".css"))!.text;
  const entry = `
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import ModelPicker from "../../../packages/models/widgets/ModelPicker.tsx";
    const models = window.__models;
    createRoot(document.querySelector("#mount")).render(
      createElement(ModelPicker, { models, onPick: () => {} })
    );
    window.__open = () => document.querySelector(".picker-model")?.click();
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "model-picker-tap-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/model-picker-tap-js",
    write: false, sourcemap: false, minify: true, logLevel: "silent",
  })).outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${css}\n${pickerCss}</style>
<script>window.fetch=async()=>new Response("{}",{status:404});
window.__models = [
  { providerID: "openai", modelID: "gpt-5", key: "openai/gpt-5", name: "GPT-5", enabled: true, connected: true },
  { providerID: "anthropic", modelID: "sonnet", key: "anthropic/sonnet", name: "Sonnet", enabled: true, connected: true },
  { providerID: "google", modelID: "gemini", key: "google/gemini", name: "Gemini", enabled: true, connected: true },
];</script></head>
<body data-appearance="light"><div id="mount"></div>
<script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
});

after(async () => { await browser?.close(); });

async function open(): Promise<Page> {
  assert.ok(browser);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector(".picker-model", { timeout: 20000 });
  return page;
}

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs = 520) {
  const cdp = await page.context().newCDPSession(page);
  const point = (p: { x: number; y: number }) => [{ x: p.x, y: p.y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from) });
  await page.waitForTimeout(holdMs);
  for (let step = 1; step <= 12; step += 1) {
    const y = from.y + ((to.y - from.y) * step) / 12;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point({ x: from.x, y }) });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}

test("holding a provider lifts it and the same touch drags it on a phone", { skip: !CHROME }, async () => {
  const page = await open();
  await page.locator(".picker-model").tap();
  await page.waitForSelector(".model-picker-shell", { timeout: 10000 });

  const sectionOrder = () => page.evaluate(() =>
    [...document.querySelectorAll(".model-picker-providers > .model-provider-section")]
      .map((el) => el.querySelector(".model-provider-head strong")?.textContent?.trim()));
  const before = await sectionOrder();
  assert.equal(before.length, 3, "three provider sections render");
  assert.equal(await page.locator(".model-picker-shell .reorder-control, .model-picker-reorder").count(), 0, "no reorder chrome on the choosing list");

  const heads = page.locator(".model-picker-providers .model-provider-head");
  // Fold any open group first: a held provider folds its list, which would
  // shift the target under a fixed finger path.
  for (let index = 0; index < 3; index += 1) {
    if (await heads.nth(index).getAttribute("aria-expanded") === "true") { await heads.nth(index).tap(); await page.waitForTimeout(200); }
  }
  const first = (await heads.nth(0).boundingBox())!;
  const second = (await heads.nth(1).boundingBox())!;
  await touchDrag(page, { x: first.x + 40, y: first.y + first.height / 2 }, { x: first.x + 40, y: second.y + second.height * 0.9 });
  const after = await sectionOrder();
  assert.deepEqual(after, [before[1], before[0], before[2]], "the held provider lands after its neighbour");

  const persisted = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("polyth.modelPrefs")).map((k) => localStorage.getItem(k)).join(""));
  assert.match(persisted, /providerOrder/, "the reorder is written to the prefs store");
  assert.ok(await page.locator(".model-picker-shell").isVisible(), "a drag does not choose or close the picker");
  await page.close();
});
