// P2-W2 chat presentation QA driver (manual; not part of `npm test`).
// Screenshots + a streaming pass over every surface the wave redesigned.
//
// Usage:
//   1. node apps/web/test/wave2ChatFixtureSetup.mjs
//   2. Start the fixture server:
//        HOME=/tmp/polyth-w2-home-7d20 POLYTH_DATA_DIR=/tmp/polyth-w2-data-7d20 \
//        PORT=4471 PATH=/tmp/polyth-w2-bin-7d20:$PATH \
//        MSGACT_OC_SEED=/tmp/polyth-w2-data-7d20/oc-seed.json \
//        MSGACT_OC_STATE=/tmp/polyth-w2-data-7d20/oc-state.json \
//        node packages/server/src/index.ts
//   3. node apps/web/test/wave2ChatQa.mjs   (OUT=/dir for screenshots)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = process.env.POLYTH_FIXTURE_URL ?? "http://127.0.0.1:4471";
const OUT = process.env.OUT ?? "/tmp/w2-shots";
const CHROME = process.env.POLYTH_CHROMIUM_PATH ?? "/usr/bin/google-chrome";
mkdirSync(OUT, { recursive: true });

const PERSONA = JSON.stringify({ persona: "engineer", plugins: [] });
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
});

async function open(width, height, path, extra = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    ...extra,
  });
  await context.addInitScript((entries) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, { "polyth.prefs": PERSONA, "polyth.projectSetup.v1.w2-project": "completed" });
  const page = await context.newPage();
  await page.goto(BASE + path, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15000 });
  await page.waitForTimeout(600);
  return { page, context };
}

const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });
const overflow = (page) => page.evaluate(() =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth);
const P = "w2-project";

// ---- thinking: collapsed label, expanded capped body, live tail ---------------
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w2-thinking`);
  await page.waitForSelector(".reasoning", { timeout: 15000 });
  console.log("thinking collapsed label:", JSON.stringify(await page.locator(".reasoning-label").textContent()));
  await shot(page, "01-thinking-collapsed-desktop");
  await page.locator(".reasoning-toggle").click();
  await page.waitForTimeout(300);
  console.log("thinking expanded body height:", (await page.locator(".reasoning-body").boundingBox())?.height);
  await shot(page, "02-thinking-expanded-desktop");
  await context.close();
}
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w2-thinking-live`);
  await page.waitForSelector(".reasoning", { timeout: 15000 });
  console.log(
    "live label:", JSON.stringify(await page.locator(".reasoning-label").textContent()),
    "preview:", JSON.stringify(await page.locator(".reasoning-preview").textContent().catch(() => "(none)")),
  );
  await shot(page, "03-thinking-live-desktop");
  await context.close();
}

// ---- tools: overview, task list, failed, huge output, MCP ---------------------
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w2-tools`);
  await page.waitForSelector(".execution-summary, .execution-group", { timeout: 15000 });
  await page.waitForTimeout(500);
  await shot(page, "04-tools-overview-desktop");
  const taskSummary = page.locator(".task-list-summary");
  console.log("task summary:", JSON.stringify(await taskSummary.textContent()));
  if (await taskSummary.getAttribute("aria-expanded") === "false") await taskSummary.click();
  await page.waitForTimeout(200);
  await taskSummary.scrollIntoViewIfNeeded();
  await shot(page, "05-tasklist-expanded-desktop");
  await context.close();
}
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w2-tools`);
  await page.waitForTimeout(600);
  const failed = page.locator(".execution-summary", { hasText: "npm run build" }).first();
  await failed.scrollIntoViewIfNeeded();
  await failed.click();
  await page.waitForTimeout(300);
  await shot(page, "06-tool-failed-expanded-desktop");
  await context.close();
}
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w2-tools`);
  await page.waitForTimeout(600);
  const huge = page.locator(".execution-summary", { hasText: "tee /tmp/full.log" }).first();
  await huge.scrollIntoViewIfNeeded();
  await huge.click();
  await page.waitForTimeout(400);
  await shot(page, "07-tool-huge-output-desktop");
  console.log("huge output rendered height:", (await page.locator(".execution-output").first().boundingBox())?.height);
  const mcp = page.locator(".execution-summary", { hasText: "GitHub" }).first();
  await mcp.scrollIntoViewIfNeeded();
  console.log("mcp collapsed:", JSON.stringify(await mcp.textContent()));
  await mcp.click();
  await page.waitForTimeout(300);
  console.log("mcp technical id in details:", JSON.stringify(await page.locator(".execution-tool-id").first().textContent().catch(() => "(missing)")));
  await shot(page, "08-mcp-expanded-desktop");
  await context.close();
}

// ---- markdown: tables, KaTeX, Mermaid, wide code, long URL --------------------
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w2-markdown`);
  await page.waitForSelector(".msg.assistant", { timeout: 15000 });
  await page.waitForTimeout(1800);
  console.log("katex nodes rendered:", await page.locator(".math-block, .math-inline").count());
  console.log("markdown page horizontal overflow:", await overflow(page));
  await shot(page, "09-markdown-desktop");
  await context.close();
}

// ---- permissions: always action-required, desktop + phone + 320 ---------------
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w2-permission`);
  await page.waitForSelector(".perm-banner", { timeout: 15000 });
  console.log("visible perm action rows without any click:", await page.locator(".perm-actions").count());
  await shot(page, "10-permissions-desktop");
  await context.close();
}
{
  const { page, context } = await open(390, 844, `/p/${P}/s/w2-permission`);
  await page.waitForSelector(".perm-banner", { timeout: 15000 });
  await page.locator(".perm-banner").scrollIntoViewIfNeeded();
  const box = await page.locator(".perm-actions .ui-btn").first().boundingBox();
  console.log("phone allow button size:", box?.width, "x", box?.height);
  await shot(page, "11-permissions-phone");
  await context.close();
}
{
  const { page, context } = await open(320, 700, `/p/${P}/s/w2-permission`);
  await page.waitForSelector(".perm-banner", { timeout: 15000 });
  console.log("permission 320px horizontal overflow:", await overflow(page));
  await shot(page, "14-permissions-320");
  await context.close();
}

// ---- phone widths: thinking + tools --------------------------------------------
{
  const { page, context } = await open(390, 844, `/p/${P}/s/w2-thinking`);
  await page.waitForSelector(".reasoning", { timeout: 15000 });
  await page.locator(".reasoning-toggle").click();
  await page.waitForTimeout(300);
  console.log("thinking phone horizontal overflow:", await overflow(page));
  await shot(page, "12-thinking-expanded-phone");
  await context.close();
}
{
  const { page, context } = await open(390, 844, `/p/${P}/s/w2-tools`);
  await page.waitForTimeout(800);
  console.log("tools phone horizontal overflow:", await overflow(page));
  await shot(page, "13-tools-phone");
  await context.close();
}

// ---- streaming: live thinking, tool lifecycle, streamed answer, scroll hold ----
{
  const { page, context } = await open(1280, 900, `/p/${P}/s/w2-stream`, {
    reducedMotion: "no-preference",
    recordVideo: { dir: OUT, size: { width: 1280, height: 900 } },
  });
  await page.waitForSelector(".composer textarea", { timeout: 15000 });
  const input = page.locator(".composer textarea").first();
  await input.fill("Run the synthetic verification turn for streaming QA.");
  await input.press("Enter");
  await page.waitForSelector(".reasoning-mark.running", { timeout: 10000 });
  console.log("live thinking tail:", JSON.stringify(await page.locator(".reasoning-preview").textContent().catch(() => "(none)")));
  await shot(page, "15-stream-thinking-live");
  await page.waitForSelector(".execution-summary", { timeout: 10000 });
  console.log("tool row during stream:", JSON.stringify(await page.locator(".execution-summary").last().textContent()));
  await shot(page, "16-stream-tool-running");
  await page.waitForSelector(".msg.assistant .bubble", { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot(page, "17-stream-text");
  // Reader-hold: scrolling up mid-stream must not be fought by auto-follow.
  await page.evaluate(() => {
    const scroller = document.querySelector(".timeline-scroll, .chat-scroll, main");
    (scroller ?? window).scrollTo?.({ top: 0 });
  });
  const held = await page.evaluate(() => (document.querySelector(".timeline-scroll, .chat-scroll, main")?.scrollTop ?? window.scrollY));
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => (document.querySelector(".timeline-scroll, .chat-scroll, main")?.scrollTop ?? window.scrollY));
  console.log("reader hold: scrollTop stayed", held, "->", after, after <= held + 4 ? "(held)" : "(FOUGHT)");
  await page.waitForFunction(() => !document.querySelector(".reasoning-mark.running"), { timeout: 15000 });
  await page.waitForTimeout(600);
  console.log("settled thinking label:", JSON.stringify(await page.locator(".reasoning-label").last().textContent().catch(() => "(none)")));
  await page.evaluate(() => {
    const scroller = document.querySelector(".timeline-scroll, .chat-scroll, main");
    scroller?.scrollTo({ top: scroller.scrollHeight });
  });
  await page.waitForTimeout(300);
  await shot(page, "18-stream-settled");
  const video = page.video();
  await context.close();
  if (video) console.log("video:", await video.path());
}

await browser.close();
console.log("done ->", OUT);
