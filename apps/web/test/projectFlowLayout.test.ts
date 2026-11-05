// The new-project flow is one wizard: step 1 (directions) and step 2 (folder
// picker) must share a content column and a header grid, so nothing jumps when
// the flow advances. Geometry a picture can hide is measured here in a real
// browser against the real components and CSS (docs/dev/ui.md §3.4).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../buildConfig.ts";
import { chromium, type Browser } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ORIGIN = "http://project-flow-layout.test";

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
    outdir: "/tmp/project-flow-layout-css",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const entry = `
    import { createElement as h } from "react";
    import { createRoot } from "react-dom/client";
    import { api } from "@polyth/session/web-api";
    import ProjectSetupFlowDialog from "./components/ProjectSetupFlowDialog.tsx";
    import * as store from "./store.ts";
    api.packagesList = async () => ({ packages: [] });
    api.browseHost = async (path) => ({
      path: path || "/home/u", parent: "/home", home: "/home/u",
      entries: [
        { name: "code", path: "/home/u/code", modifiedAt: Date.now() - 3600e3, hidden: false },
        { name: "documents", path: "/home/u/documents", modifiedAt: Date.now() - 86400e3, hidden: false },
      ],
    });
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [{ id: "p1", path: "/repo", name: "Repo", createdAt: 0 }]);
    store.activateProject("p1");
    createRoot(document.querySelector("#mount")).render(
      h(ProjectSetupFlowDialog, { onClose: () => { window.__closed = true; } }),
    );
    window.__ready = true;
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "project-flow-layout-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/project-flow-layout-js",
    loader: { ".css": "empty", ".json": "json" },
    write: false, sourcemap: false, minify: true, logLevel: "silent",
  })).outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${css}</style>
    <script>
      window.fetch = async (input) => new Response(
        String(input).includes("/api/packages") ? '{"packages":[]}' : "[]",
        { status: 200, headers: { "content-type": "application/json" } },
      );
    </script></head>
    <body><div id="root"><div class="app"><div class="app-shell"><main class="main">
      <div id="mount" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%"></div>
    </main></div></div></div>
    <script>${js.replaceAll("</script", "<\\/script")}</script>
    </body></html>`;
}

interface Box { l: number; r: number; t: number; b: number; h: number; lh: number }

const STEP1_SELECTORS = [
  ".project-setup-flow-dialog", ".project-setup-step", ".project-setup-intro h2", ".project-setup-intro p",
  ".project-setup-intro .ui-icon-btn", ".project-direction-card",
  ".project-setup-actions", ".project-setup-actions .ui-btn",
];
const STEP2_SELECTORS = [
  ".folder-dialog", ".folder-dialog-step", ".folder-back", ".folder-dialog-title", ".folder-dialog-subtitle",
  ".folder-dialog-head-row > .ui-icon-btn:last-child", ".folder-list", ".folder-foot",
  ".folder-open-btn",
];

/** Boxes for the requested selectors, plus every button label on screen. */
function readStage(selectors: string[]) {
  return (args: { selectors: string[] }) => {
    const boxes: Record<string, Box | null> = {};
    for (const selector of args.selectors) {
      const element = document.querySelector(selector);
      if (!element) { boxes[selector] = null; continue; }
      const rect = element.getBoundingClientRect();
      boxes[selector] = {
        l: rect.left, r: rect.right, t: rect.top, b: rect.bottom, h: rect.height,
        lh: Number.parseFloat(getComputedStyle(element).lineHeight) || 0,
      };
    }
    return {
      boxes,
      buttons: [...document.querySelectorAll<HTMLElement>("button")]
        .flatMap((button) => [button.textContent?.trim() ?? "", button.getAttribute("aria-label") ?? ""])
        .filter(Boolean),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  };
}

async function measure(phone: boolean) {
  assert.ok(browser, "Chromium is available");
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  try {
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    await page.waitForSelector(".project-setup-flow-dialog");
    const step1 = await page.evaluate(readStage(STEP1_SELECTORS), { selectors: STEP1_SELECTORS });
    await page.getByRole("button", { name: /continue/i }).click();
    await page.waitForSelector(".folder-dialog .folder-list");
    // The picker enters with a surface motion; measure the settled panel, or
    // a fractional scale moves every measured edge by a pixel.
    await page.waitForFunction(() => {
      const panel = document.querySelector<HTMLElement>(".folder-dialog");
      return panel !== null && getComputedStyle(panel).transform === "none";
    });
    await page.waitForTimeout(80);
    const step2 = await page.evaluate(readStage(STEP2_SELECTORS), { selectors: STEP2_SELECTORS });
    return {
      step1: step1.boxes, step2: step2.boxes,
      step1Buttons: step1.buttons, step2Buttons: step2.buttons,
      overflow: step1.overflow || step2.overflow,
    };
  } finally {
    await context.close();
  }
}

const close = (a: number, b: number, message: string) =>
  assert.ok(Math.abs(a - b) <= 1, `${message} (${a.toFixed(1)} vs ${b.toFixed(1)})`);

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"}: both steps share one content column, one X and one footer`, { skip: !CHROME }, async () => {
    const { step1, step2, step1Buttons, step2Buttons, overflow } = await measure(phone);
    const step1Panel = step1[".project-setup-flow-dialog"]!;
    const step2Panel = step2[".folder-dialog"]!;
    const step1X = step1[".project-setup-intro .ui-icon-btn"]!;
    const step1Title = step1[".project-setup-intro h2"]!;
    const step1Footer = step1[".project-setup-actions"]!;
    const step1Primary = step1[".project-setup-actions .ui-btn"]!;
    const step2X = step2[".folder-dialog-head-row > .ui-icon-btn:last-child"]!;
    const step2Title = step2[".folder-dialog-title"]!;
    const step2Footer = step2[".folder-foot"]!;
    const step2Primary = step2[".folder-open-btn"]!;

    // Step 1 promises one exit and no bottom Cancel; step 2 adds only Back.
    assert.ok(!step1Buttons.some((label) => /^cancel$/i.test(label)), "step 1 has no Cancel button");
    assert.equal(step1X ? 1 : 0, 1, "step 1 has exactly one close control");
    assert.ok(step2Buttons.some((label) => /^back$/i.test(label)), "step 2 offers Back");

    // The text column, the cards/list and both primary actions sit on the same
    // left and right edge in both steps.
    close(step1Title.l, step2Title.l, "titles share the content column left edge");
    close(step1[".project-direction-card"]!.l, step2[".folder-list"]!.l, "content starts on the same left edge");
    close(step1[".project-direction-card"]!.r, step2[".folder-list"]!.r, "content ends on the same right edge");
    close(step1Primary.r, step2Primary.r, "primary actions share the same end edge");

    // One close affordance, in the same place, whatever the step. Vertical
    // positions are measured from each panel's own top-left: the panels differ
    // in height and therefore in where the backdrop centres them.
    close(step1X.r, step2X.r, "the X keeps one right edge");
    close(step1X.l, step2X.l, "the X keeps one left edge");
    close(step1Title.t - step1Panel.t, step2Title.t - step2Panel.t, "the title keeps one offset from the panel top");
    // Each X centres on its own title line, so a wrapped phone title does not
    // drag the control into the middle of the block.
    const centresOn = (x: Box, title: Box, at: string) =>
      assert.ok(Math.abs(x.t + x.h / 2 - (title.t + title.lh / 2)) <= 2, `${at}: the X centres on the title line`);
    centresOn(step1X, step1Title, "step 1");
    centresOn(step2X, step2Title, "step 2");

    // Footers are the same bar. On a phone the picker stacks its ways-to-add
    // row above the primary action, so only the primary itself is comparable.
    if (!phone) close(step1Footer.h, step2Footer.h, "both footers measure the same");
    close(step1Primary.h, step2Primary.h, "both primary actions measure the same");
    if (phone) {
      assert.ok(step1Primary.h >= 44, "the phone primary action keeps a full touch target");
      close(step1Primary.r - step1Primary.l, step2Primary.r - step2Primary.l, "the phone primary action spans the same width");
    }

    // Step 2 leads with Back on the flow label's line, never beside the title,
    // so the title and the X never move between steps.
    const back = step2[".folder-back"]!;
    const eyebrow2 = step2[".folder-dialog-step"]!;
    assert.ok(back, "step 2 shows Back");
    assert.ok(back.b <= step2Title.t + 1, `Back sits on the label line, above the title (${back.b.toFixed(1)} vs ${step2Title.t.toFixed(1)})`);
    close((back.t + back.b) / 2, (eyebrow2.t + eyebrow2.b) / 2, "Back and the flow label share a centre line");

    assert.equal(overflow, false, "nothing overflows the viewport");
  });
}
