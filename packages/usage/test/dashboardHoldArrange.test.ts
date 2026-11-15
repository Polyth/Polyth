// Usage blocks on a phone follow the Home Screen: a still touch hold on a block
// turns editing on and the same finger drags it; while editing the blocks
// sway, a corner − hides one, the hidden list's + brings it back, Done ends.
// Mounts the real UsageDashboard with the real CSS bundle in headless Chromium
// at 390x844 and drives real touch events through CDP.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../../../apps/web/buildConfig.ts";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "../../../apps/web/test/chromium.ts";
import { buildUsageStatsReport } from "../src/analytics/aggregate.ts";
import type { UsageObservation, UsageStatsQuery } from "../src/analytics/contracts.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This test requires Chromium (set POLYTH_CHROMIUM_PATH).");
}
const SRC = fileURLToPath(new URL("../../../apps/web/src/", import.meta.url));
const ORIGIN = "http://usage-hold.test";
const now = Date.UTC(2026, 10, 12, 12);
const observations: UsageObservation[] = Array.from({ length: 8 }, (_, index) => ({
  id: `o-${index}`, timestamp: now - (index + 1) * 43_200_000, projectId: "project-a", sessionId: `s-${index % 2}`, turnId: `t-${index}`,
  harnessId: index % 2 ? "codex" : "claude", modelId: index % 2 ? "gpt-5" : "sonnet",
  tokens: { input: 1000 * (index + 1), output: 200, reasoning: 10, cacheRead: 300, cacheWrite: 30 }, cost: 0.02 * (index + 1), quality: "exact",
}));

let browser: Browser | null = null;
let html = "";

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const css = (await build({
    ...browserBuildOptions,
    entryPoints: [fileURLToPath(new URL("../../../apps/web/src/main.tsx", import.meta.url))],
    outdir: "/tmp/usage-hold-css", write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n")
    // The Usage package carries its own stylesheet (widgets/index.tsx).
    + (await build({
      ...browserBuildOptions,
      entryPoints: [fileURLToPath(new URL("../widgets/usageAnalytics.css", import.meta.url))],
      outdir: "/tmp/usage-hold-pkg-css", write: false, sourcemap: false, minify: false, logLevel: "silent",
      plugins: [uiFontScalePlugin],
    })).outputFiles.map((f) => f.text).join("\n");
  const entry = `
    import { createElement } from "react";
    import { createRoot } from "react-dom/client";
    import { applyProjectAdded, activateProject } from "./store.ts";
    import { UsageDashboard } from "../../../packages/usage/widgets/usage/UsageDashboard.tsx";
    applyProjectAdded({ id: "project-a", name: "Project A", path: "/a", createdAt: 1 });
    activateProject("project-a");
    createRoot(document.querySelector("#mount")).render(createElement(UsageDashboard, { active: true, projectId: "project-a" }));
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "usage-hold-entry.tsx" },
    format: "iife", splitting: false, external: ["/assets/*"], outdir: "/tmp/usage-hold-js",
    write: false, sourcemap: false, minify: true, logLevel: "silent",
  })).outputFiles.filter((f) => f.path.endsWith(".js")).map((f) => f.text).join("\n");
  html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${css}\nhtml,body,#mount{margin:0;height:100%}</style></head>
<body><div id="mount"></div><script>${js.replaceAll("</script", "<\\/script")}</script></body></html>`;
});

after(async () => { await browser?.close(); });

async function open(): Promise<Page> {
  assert.ok(browser);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    if (url.pathname === "/api/usage/identity") return route.fulfill({ json: { serverInstanceId: "s", spaceId: "sp" } });
    if (url.pathname === "/api/usage/stats") {
      const query = JSON.parse(route.request().postData() ?? "{}") as UsageStatsQuery;
      return route.fulfill({ json: buildUsageStatsReport({
        serverInstanceId: "s", spaceId: "sp", query, observations, projects: [{ id: "project-a", name: "Project A" }],
        sessions: new Map([["s-0", { id: "s-0", title: "One", status: "idle" }], ["s-1", { id: "s-1", title: "Two", status: "idle" }]]), now,
      }) });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector(".usage-clean-block[data-block]", { timeout: 20000 });
  return page;
}

async function touchDrag(page: Page, from: { x: number; y: number }, toY: number, holdMs: number) {
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number, y: number) => [{ x, y, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(from.x, from.y) });
  await page.waitForTimeout(holdMs);
  for (let step = 1; step <= 14; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(from.x, from.y + ((toY - from.y) * step) / 14) });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(150);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
}

const order = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>(".usage-clean-stack > .usage-clean-block")].map((el) => el.dataset.block));

test("holding a Usage block turns editing on and the same touch drags it", { skip: !CHROME }, async () => {
  const page = await open();
  const before = await order(page);
  assert.ok(before.length >= 3, "several blocks render");
  assert.equal(await page.locator("[data-arrange-editing]").count(), 0, "not editing at rest");

  const first = (await page.locator(`.usage-clean-block[data-block="${before[0]}"]`).boundingBox())!;
  const second = (await page.locator(`.usage-clean-block[data-block="${before[1]}"]`).boundingBox())!;
  // The held block's centre aims: carry it to three quarters down its neighbour.
  const grabY = first.y + Math.min(40, first.height / 2);
  const toY = grabY + (second.y + second.height * 0.75) - (first.y + first.height / 2);
  await touchDrag(page, { x: first.x + first.width / 2, y: grabY }, toY, 560);

  assert.equal(await page.locator(".usage-clean-stack[data-arrange-editing]").count(), 1, "the hold turned editing on");
  const after = await order(page);
  assert.deepEqual(after.slice(0, 2), [before[1], before[0]], "the held block landed after its neighbour");

  // While editing: every block has its corner − and its content is inert.
  const badges = await page.locator(".usage-clean-block > .arrange-badge").count();
  assert.equal(badges, after.length, "each block carries a − badge");
  const box = (await page.locator(".usage-clean-block > .arrange-badge").first().boundingBox())!;
  assert.ok(box.width >= 24 && box.height >= 24, "the badge is a visible mark");
  assert.equal(await page.locator(".usage-clean-block-body[inert]").count(), after.length, "block content is inert while editing");

  // − hides a block into the Hidden list; its + brings it back.
  const hidden = after[0]!;
  await page.locator(`.usage-clean-block[data-block="${hidden}"] > .arrange-badge`).tap();
  await page.waitForTimeout(300);
  assert.ok(!(await order(page)).includes(hidden), "− hides the block");
  await page.evaluate(() => document.querySelector(".usage-clean-hidden-row")?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(100);
  await page.locator(".usage-clean-hidden-row").first().tap();
  await page.waitForTimeout(300);
  assert.ok((await order(page)).includes(hidden), "+ brings it back");

  // Done ends editing.
  await page.evaluate(() => document.querySelector(".usage-clean-done")?.scrollIntoView({ block: "center" }));
  await page.locator(".usage-clean-done").tap();
  await page.waitForTimeout(200);
  assert.equal(await page.locator("[data-arrange-editing]").count(), 0, "Done ends editing");
  assert.equal(await page.locator(".usage-clean-block > .arrange-badge").count(), 0);
  await page.close();
});
