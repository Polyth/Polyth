// The agent activity panel in a real engine: the REAL status line, composer
// and panel host inside a conversation. The panel stands on the line and never
// covers the composer, as wide as the composer card, on the phone and on the
// desktop; its first frame is a strip lying exactly on the line (it grows out
// of it) and its close folds back into it; reduced motion opens it in place.
// Arranging is the iOS kind: a still hold sinks the block, then turns editing
// on and lifts it under the pointer so the same press drags it; the panel
// keeps its size meanwhile, blocks jiggle with `rotate` only (`transform`
// stays free for the glides) and the head's Close becomes Done.
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
const ORIGIN = "http://session-activity-panel.test";

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
    outdir: "/tmp/opencode/session-activity-panel-css",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const entry = `
    import { createElement as h, useMemo } from "react";
    import { createRoot } from "react-dom/client";
    import { api } from "@polyth/session/web-api";
    import Composer from "./components/Composer.tsx";
    import AgentLiveStatusDock from "./components/AgentLiveStatusDock.tsx";
    import SessionActivityPanelHost from "./components/SessionActivityPanel.tsx";
    import { buildModel } from "./reduce.ts";
    import { resolveSessionActivity } from "./sessionActivity.ts";
    import * as store from "./store.ts";
    import { setUiSettings } from "./uiPrefs.ts";
    const SID = "s1";
    const OPUS = { providerID: "anthropic", modelID: "opus" };
    api.queueList = async () => [];
    api.listWorktrees = async () => [{ path: "/repo", branch: "master", head: "0", isMain: true }];
    api.gitBranches = async () => ({ current: "master", branches: [{ name: "master", current: true }] });
    setUiSettings({ sessionActivityDetails: "tabs" });
    function Conversation() {
      const events = store.useStore((s) => s.events[SID]);
      const session = store.useStore((s) => s.sessions.find((x) => x.id === SID) ?? null);
      const model = useMemo(() => buildModel(events ?? []), [events]);
      const activity = resolveSessionActivity(session, model.turn, []);
      return h("div", { className: "focus-conversation" },
        h("div", { className: "timeline-wrap" }, h("div", { className: "timeline" })),
        h("div", { className: "conversation-composer-dock" },
          activity.working ? h(AgentLiveStatusDock, { activity, model }) : null,
          h(SessionActivityPanelHost, { sessionId: SID, model }),
          h(Composer)));
    }
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [{ id: "p1", path: "/repo", name: "Repo", createdAt: 0 }]);
    store.activateProject("p1");
    store.setModels([{ providerID: "anthropic", modelID: "opus", name: "Opus", connected: true, harnessId: "claude", context: 200000 }]);
    store.setSessions("p1", [{
      id: SID, projectId: "p1", title: "Release date theories", titleSource: "native", status: "working", createdAt: 1, updatedAt: 1, lastTurnAt: 1,
      attention: { questions: 0, permissions: 0, unread: 0 }, model: OPUS, resolvedHarnessId: "claude",
      contextWindow: { limitTokens: 200000, usedTokens: 68000, source: "native", updatedAt: Date.now(), harnessId: "claude" },
    }]);
    store.activateSession(SID);
    store.applyEvent({ id: "e0", sessionId: SID, seq: 1, time: Date.now() - 4000, type: "user/message", data: { text: "Collect the theories" }, v: 1 });
    store.applyEvent({ id: "e1", sessionId: SID, seq: 2, time: Date.now(), type: "turn/started", data: { turnId: "t", model: OPUS, harnessId: "claude" }, v: 1 });
    store.applyEvent({ id: "e2", sessionId: SID, seq: 3, time: Date.now(), type: "tool/call", data: { callId: "c", tool: "bash", input: { command: "npm test", description: "Run the tests" } }, v: 1 });
    createRoot(document.querySelector("#mount")).render(h(Conversation));
    window.__ready = true;
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "session-activity-panel-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/opencode/session-activity-panel-js",
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
    <body><div id="root"><div class="app"><div class="app-shell"><div class="workspace"><main class="main">
      <div id="mount" style="display:flex;flex-direction:column;flex:1;min-height:0;height:100%"></div>
    </main></div></div></div></div>
    <script>${js.replaceAll("</script", "<\\/script")}</script>
    </body></html>`;
}

async function open(phone: boolean, reducedMotion = false): Promise<Page> {
  assert.ok(browser);
  const context = await browser.newContext(phone
    ? { viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1100, height: 760 } });
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  const page = await context.newPage();
  if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.waitForSelector(".agent-status-dock");
  await page.waitForSelector(".composer-card");
  return page;
}

type Box = { left: number; top: number; right: number; bottom: number; width: number };
const box = (page: Page, selector: string) => page.evaluate((query): Box => {
  const rect = document.querySelector(query)!.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width };
}, selector);
/** The status line's own top: its touch target reaches above it. */
const lineTop = (page: Page) => page.evaluate(() => {
  const line = document.querySelector<HTMLElement>(".agent-status-dock")!;
  return line.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(line).paddingTop);
});

for (const phone of [true, false]) {
  test(`${phone ? "phone" : "desktop"}: the panel stands on the status line and never covers the composer`, { skip: !CHROME }, async () => {
    const page = await open(phone);
    try {
      await page.click(".agent-status-dock");
      await page.waitForSelector(".session-activity-panel");
      await page.waitForTimeout(500);
      assert.equal(await page.getAttribute(".agent-status-dock", "aria-expanded"), "true");
      const panel = await box(page, ".session-activity-panel");
      const card = await box(page, ".composer-card");
      const top = await lineTop(page);
      assert.ok(panel.bottom <= top, `panel ${panel.bottom} stands on the line ${top}`);
      assert.ok(top - panel.bottom <= 12, "and close to it, not floating away");
      assert.ok(panel.bottom <= card.top, "the composer card stays uncovered");
      assert.ok(Math.abs(panel.left - card.left) < 1 && Math.abs(panel.width - card.width) < 1, "as wide as the composer card");
      assert.ok(panel.top >= 0, "inside the window");
      // The composer still takes a press while the panel is open; the press closes the panel.
      await page.click(".composer-card .composer-editor");
      await page.waitForTimeout(400);
      assert.equal(await page.$(".session-activity-panel"), null);
    } finally {
      await page.context().close();
    }
  });
}

test("the panel grows out of the status line and folds back into it", { skip: !CHROME }, async () => {
  const page = await open(true);
  try {
    await page.evaluate(() => { (window as unknown as { __before: Set<Animation> }).__before = new Set(document.getAnimations()); });
    await page.click(".agent-status-dock");
    const first = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".session-activity-panel")!;
      const before = (window as unknown as { __before: Set<Animation> }).__before;
      const motion = document.getAnimations().find((animation) => !before.has(animation) && (animation.effect as KeyframeEffect).target === panel)!;
      const duration = Number(motion.effect!.getTiming().duration);
      motion.pause();
      motion.currentTime = 0;
      const style = getComputedStyle(panel);
      const shown = panel.getBoundingClientRect();
      const top = Number(/inset\((-?[\d.]+)px/.exec(style.clipPath)?.[1]);
      return { duration, visibleTop: shown.top + top, visibleBottom: shown.bottom };
    });
    const top = await lineTop(page);
    const line = await box(page, ".agent-status-dock");
    assert.ok(first.duration > 0);
    assert.ok(Math.abs(first.visibleTop - top) < 1.5, `the first frame starts at the line's top (${first.visibleTop} vs ${top})`);
    assert.ok(Math.abs(first.visibleBottom - line.bottom) < 1.5, "and ends at its bottom: a strip lying on the line");

    // Finish the opening (the live status line's own glow loops forever).
    await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        if (Number.isFinite(Number(animation.effect?.getTiming().iterations))) animation.finish();
      }
    });
    await page.waitForTimeout(100);
    await page.evaluate(() => { (window as unknown as { __before: Set<Animation> }).__before = new Set(document.getAnimations()); });
    await page.click(".agent-status-dock");
    const last = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".session-activity-panel")!;
      const before = (window as unknown as { __before: Set<Animation> }).__before;
      const motion = document.getAnimations().find((animation) => !before.has(animation) && (animation.effect as KeyframeEffect).target === panel)!;
      motion.pause();
      // Paused, the end frame holds without finishing the animation.
      motion.currentTime = Number(motion.effect!.getTiming().duration);
      const shown = panel.getBoundingClientRect();
      const inset = Number(/inset\((-?[\d.]+)px/.exec(getComputedStyle(panel).clipPath)?.[1]);
      const state = panel.parentElement!.dataset.state;
      motion.play();
      return { visibleTop: shown.top + inset, visibleBottom: shown.bottom, state };
    });
    assert.equal(last.state, "closing");
    assert.ok(Math.abs(last.visibleTop - top) < 1.5, `the last frame is back on the line (${JSON.stringify(last)} vs ${top})`);
    assert.ok(Math.abs(last.visibleBottom - line.bottom) < 1.5, "lying on it");
    await page.waitForTimeout(400);
    assert.equal(await page.$(".session-activity-panel"), null, "and then it is gone");
    assert.equal(await page.getAttribute(".agent-status-dock", "aria-expanded"), "false");
  } finally {
    await page.context().close();
  }
});

test("reduced motion opens and closes the panel in place", { skip: !CHROME }, async () => {
  const page = await open(true, true);
  try {
    await page.evaluate(() => { (window as unknown as { __before: Set<Animation> }).__before = new Set(document.getAnimations()); });
    await page.click(".agent-status-dock");
    const moving = await page.evaluate(() => {
      const before = (window as unknown as { __before: Set<Animation> }).__before;
      return document.getAnimations().filter((animation) => !before.has(animation)
        && (animation.effect as KeyframeEffect).target instanceof Element
        && ((animation.effect as KeyframeEffect).target as Element).closest(".session-activity-layer")).length;
    });
    assert.equal(moving, 0);
    await page.keyboard.press("Escape");
    assert.equal(await page.$(".session-activity-panel"), null);
  } finally {
    await page.context().close();
  }
});

test("holding a block arranges in place: it sinks, lifts under the pointer and the same press drags it", { skip: !CHROME }, async () => {
  const page = await open(false);
  try {
    await page.evaluate(() => localStorage.removeItem("polyth.sessionActivityLayout.v1"));
    await page.click(".agent-status-dock");
    await page.waitForSelector(".session-activity-panel");
    await page.waitForTimeout(500);
    const order = () => page.$$eval(".session-activity-blocks > [data-activity-block]", (nodes) => nodes.map((node) => (node as HTMLElement).dataset.activityBlock));
    const headButtons = () => page.$$eval(".session-activity-panel-actions button", (nodes) => nodes.map((node) => node.getAttribute("aria-label") || node.textContent));
    assert.deepEqual(await headButtons(), ["Close"], "no edit button on screen");
    const before = await box(page, ".session-activity-panel");
    const start = await order();
    const from = await box(page, "[data-activity-block='messages']");
    const to = await box(page, "[data-activity-block='duration']");
    await page.mouse.move(from.left + from.width / 2, from.top + 20);
    await page.mouse.down();
    await page.waitForTimeout(250);
    const holding = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>("[data-activity-block='messages']")!;
      return { pressing: block.dataset.arrangePressing, scale: Number(getComputedStyle(block).scale) };
    });
    assert.equal(holding.pressing, "activate");
    assert.ok(holding.scale < 1, `the held block sinks (${holding.scale})`);
    await page.waitForTimeout(300);
    const lifted = await page.evaluate(() => {
      const details = document.querySelector<HTMLElement>(".session-activity-details")!;
      const ghost = details.querySelector<HTMLElement>(".workspace-arrange-ghost");
      const block = details.querySelector<HTMLElement>("[data-activity-block='duration']")!;
      const jiggle = block.getAnimations().find((animation) => (animation as CSSAnimation).animationName?.startsWith("session-activity-jiggle"));
      const properties = new Set((jiggle?.effect as KeyframeEffect | undefined)?.getKeyframes()
        .flatMap((frame) => Object.keys(frame).filter((key) => !["offset", "computedOffset", "easing", "composite"].includes(key))) ?? []);
      return {
        editing: details.dataset.editing,
        ghost: ghost ? ghost.getBoundingClientRect().toJSON() as DOMRect : null,
        jiggle: (jiggle as CSSAnimation | undefined)?.animationName,
        properties: [...properties],
      };
    });
    assert.equal(lifted.editing, "true");
    assert.ok(lifted.ghost, "a copy is lifted");
    assert.ok(lifted.ghost!.left <= from.left + from.width / 2 && from.left + from.width / 2 <= lifted.ghost!.right, `under the pointer: ${JSON.stringify({ ghost: lifted.ghost, from })}`);
    assert.equal(lifted.jiggle, "session-activity-jiggle-tile");
    assert.deepEqual(lifted.properties, ["rotate"], "the jiggle leaves transform to the glides");
    assert.deepEqual(await headButtons(), ["Done"], "Close became Done");
    const editingBox = await box(page, ".session-activity-panel");
    assert.ok(Math.abs(editingBox.top - before.top) < 1 && Math.abs(editingBox.bottom - before.bottom) < 1, "the panel keeps its size while arranging");
    // The same press carries it before the first figure.
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(from.left + from.width / 2 + (to.left + 12 - from.left - from.width / 2) * step / 10, from.top + 20 + (to.top + 20 - from.top - 20) * step / 10);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
    const moved = await order();
    assert.equal(moved.indexOf("messages"), start.indexOf("duration"), `${JSON.stringify(moved)} from ${JSON.stringify(start)}`);
    await page.click(".session-activity-panel-actions .session-activity-done");
    await page.waitForTimeout(500);
    assert.equal(await page.getAttribute(".session-activity-details", "data-editing"), null);
    assert.deepEqual(await headButtons(), ["Close"]);
    const after = await box(page, ".session-activity-panel");
    assert.ok(Math.abs(after.top - before.top) < 1, "and leaves it where it was");
  } finally {
    await page.context().close();
  }
});
