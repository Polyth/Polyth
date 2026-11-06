// The new-project flow is one wizard: on the Engineering path the directions
// step and the folder picker are steps 1 and 2, and they must share a content
// column and a header grid, so nothing jumps when the flow advances. (Anything
// else goes from the directions straight to the naming window.) Geometry a
// picture can hide is measured here in a real browser against the real
// components and CSS (docs/dev/ui.md §3.4).
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
  ".project-setup-flow-dialog", ".project-setup-head", ".project-setup-step",
  ".project-setup-head-top .ui-icon-btn", ".project-setup-title", ".project-setup-hint",
  ".project-direction-card", ".project-setup-actions", ".project-setup-actions .ui-btn",
];
const STEP2_SELECTORS = [
  ".folder-dialog", ".folder-dialog-head", ".folder-dialog-step",
  ".folder-dialog-step-row .ui-icon-btn", ".folder-dialog-title", ".folder-dialog-subtitle",
  ".folder-list", ".folder-foot", ".folder-back", ".folder-new-folder", ".folder-open-btn",
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

async function measure(options: { phone?: boolean; height?: number; rtl?: boolean } = {}) {
  assert.ok(browser, "Chromium is available");
  const { phone = false, height = 760, rtl = false } = options;
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1100, height }, deviceScaleFactor: 2 });
  try {
    if (rtl) await context.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => { document.documentElement.dir = "rtl"; });
    });
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    await page.waitForSelector(".project-setup-flow-dialog");
    const step1 = await page.evaluate(readStage(STEP1_SELECTORS), { selectors: STEP1_SELECTORS });
    // Engineering is the path whose second step is the folder picker; any other
    // direction goes straight to the naming window.
    await page.getByRole("button", { name: /engineering/i }).click();
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
  test(`${phone ? "phone" : "desktop"}: both steps share one box, one head grid and one footer`, { skip: !CHROME }, async () => {
    const { step1, step2, step1Buttons, step2Buttons, overflow } = await measure({ phone });
    const panel1 = step1[".project-setup-flow-dialog"]!;
    const panel2 = step2[".folder-dialog"]!;
    const x1 = step1[".project-setup-head-top .ui-icon-btn"]!;
    const x2 = step2[".folder-dialog-step-row .ui-icon-btn"]!;
    const eyebrow1 = step1[".project-setup-step"]!;
    const eyebrow2 = step2[".folder-dialog-step"]!;
    const title1 = step1[".project-setup-title"]!;
    const title2 = step2[".folder-dialog-title"]!;
    const hint2 = step2[".folder-dialog-subtitle"]!;
    const foot1 = step1[".project-setup-actions"]!;
    const foot2 = step2[".folder-foot"]!;
    const primary1 = step1[".project-setup-actions .ui-btn"]!;
    const primary2 = step2[".folder-open-btn"]!;

    // Step 1 promises one exit and no bottom Cancel; step 2 adds only Back.
    assert.ok(!step1Buttons.some((label) => /^cancel$/i.test(label)), "step 1 has no Cancel button");
    assert.ok(step2Buttons.some((label) => /^back$/i.test(label)), "step 2 offers Back");

    // The flow is one dialog box: the same panel, at the same place, on both
    // steps, so advancing never resizes or re-centres the window.
    close(step1[".project-setup-head"]!.b - step1[".project-setup-head"]!.t, step2[".folder-dialog-head"]!.b - step2[".folder-dialog-head"]!.t, "both head frames measure the same");
    if (!phone) {
      close(panel1.r - panel1.l, panel2.r - panel2.l, "both panels have one width");
      close(panel1.h, panel2.h, "both panels have one height");
      close(panel1.t, panel2.t, "both panels sit at one position");
    }

    // One head: flow label, X, title and hint keep exact positions.
    close(eyebrow1.l, eyebrow2.l, "flow labels share one left edge");
    close(eyebrow1.t - panel1.t, eyebrow2.t - panel2.t, "flow labels sit at one height");
    close(x1.r, x2.r, "the X keeps one right edge");
    close(x1.l, x2.l, "the X keeps one left edge");
    close(x1.t - panel1.t, x2.t - panel2.t, "the X keeps one height");
    close(title1.l, title2.l, "titles share one left edge");
    close(title1.t - panel1.t, title2.t - panel2.t, "titles sit at one height");
    close(title1.lh, title2.lh, "titles share the same measure");
    assert.ok(hint2.r - hint2.l <= 480, `the step-2 hint keeps a reading measure (${Math.round(hint2.r - hint2.l)}px)`);

    // The content column and the primary action share edges across steps.
    close(step1[".project-direction-card"]!.l, step2[".folder-list"]!.l, "content starts on the same left edge");
    close(step1[".project-direction-card"]!.r, step2[".folder-list"]!.r, "content ends on the same right edge");
    close(primary1.r, primary2.r, "primary actions share the same end edge");

    // Both footers are pinned bars of one height, below the scrolling body.
    const back = step2[".folder-back"]!;
    assert.ok(back, "step 2 shows Back");
    assert.ok(back.t >= step2[".folder-list"]!.b - 1, "Back sits below the scrolling list");
    close(back.l, step2[".folder-list"]!.l, "Back starts at the content column");
    close(foot1.h, foot2.h, "both footers measure the same");
    assert.ok(back.t >= foot2.t - 0.5 && back.b <= foot2.b + 0.5, "Back lives inside the footer bar");
    close(primary1.h, primary2.h, "both primary actions measure the same");
    if (phone) {
      assert.ok(primary1.h >= 44, "the phone primary action keeps a full touch target");
      assert.ok(x1.h <= 32 && x2.h <= 32, "the head stays compact on a phone");
    }

    assert.equal(overflow, false, "nothing overflows the viewport");
  });
}

test("short desktop window: the pinned footers stay inside both panels", { skip: !CHROME }, async () => {
  const { step1, step2 } = await measure({ height: 520 });
  for (const [name, boxes] of [["step 1", step1], ["step 2", step2]] as const) {
    const panel = name === "step 1" ? boxes[".project-setup-flow-dialog"]! : boxes[".folder-dialog"]!;
    const foot = name === "step 1" ? boxes[".project-setup-actions"]! : boxes[".folder-foot"]!;
    assert.ok(foot.b <= panel.b + 0.5, `${name}: the footer stays inside the panel (${foot.b.toFixed(1)} <= ${panel.b.toFixed(1)})`);
    assert.ok(foot.h >= 40, `${name}: the footer keeps its bar`);
  }
  close(
    (step1[".project-setup-flow-dialog"]!.b - step1[".project-setup-flow-dialog"]!.t),
    (step2[".folder-dialog"]!.b - step2[".folder-dialog"]!.t),
    "both panels still share one height in a short window",
  );
});

test("Back from the picker returns focus to Continue", { skip: !CHROME }, async () => {
  assert.ok(browser, "Chromium is available");
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  try {
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    await page.waitForSelector(".project-setup-flow-dialog");
    await page.getByRole("button", { name: /engineering/i }).click();
    await page.getByRole("button", { name: /continue/i }).click();
    await page.waitForSelector(".folder-dialog .folder-list");
    await page.locator(".folder-back").click();
    await page.waitForSelector(".project-setup-flow-dialog");
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return { tag: active?.tagName ?? null, text: active?.textContent?.trim() ?? null, inFoot: !!active?.closest(".project-setup-actions") };
    });
    assert.equal(focused.inFoot, true, `focus returns to the step-1 footer (${focused.tag} "${focused.text}")`);
    assert.match(focused.text ?? "", /continue/i);
  } finally {
    await context.close();
  }
});

test("RTL: the head mirrors without moving the content column", { skip: !CHROME }, async () => {
  const { step1, step2, overflow } = await measure({ rtl: true });
  const x1 = step1[".project-setup-head-top .ui-icon-btn"]!;
  const x2 = step2[".folder-dialog-step-row .ui-icon-btn"]!;
  const eyebrow1 = step1[".project-setup-step"]!;
  const eyebrow2 = step2[".folder-dialog-step"]!;
  // In RTL the end column is the left edge; the X keeps it on both steps.
  close(x1.l, x2.l, "the X keeps one start edge in RTL");
  close(eyebrow1.r, eyebrow2.r, "flow labels keep one edge in RTL");
  close(step1[".project-direction-card"]!.l, step2[".folder-list"]!.l, "content keeps its column in RTL");
  assert.equal(overflow, false, "RTL does not overflow");
});
