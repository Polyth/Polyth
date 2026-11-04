// The pending stack above the REAL Composer: the status line and the queued
// prompts are text on one grid in every look, with the card as the one surface,
// and the primary action is a calm disc with no ring. These are geometry and
// paint facts a picture can hide, so they are measured in a real browser
// (docs/dev/ui.md "Status above the composer", styles.css "The pending stack").
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
const ORIGIN = "http://composer-pending-stack.test";
const LOOKS = ["standard", "paper", "line", "air", "monolith", "monolith-reverse", "obsidian", "editorial"];
const SCHEMES = ["light", "dark"] as const;

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
    outdir: "/tmp/opencode/composer-pending-stack-css",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const entry = `
    import { createElement as h, useMemo } from "react";
    import { createRoot } from "react-dom/client";
    import { api } from "@polyth/session/web-api";
    import Composer from "./components/Composer.tsx";
    import AgentLiveStatusDock from "./components/AgentLiveStatusDock.tsx";
    import { buildModel } from "./reduce.ts";
    import { resolveSessionActivity } from "./sessionActivity.ts";
    import * as store from "./store.ts";
    import { setUiSettings } from "./uiPrefs.ts";
    const SID = "s1";
    const OPUS = { providerID: "anthropic", modelID: "opus" };
    const QUEUE = [
      { id: "q1", sessionId: SID, position: 0, text: "First queued prompt with enough words to run off the row and truncate", delivery: "queue", createdAt: 1 },
      { id: "q2", sessionId: SID, position: 1, text: "Second", delivery: "queue", createdAt: 2 },
    ];
    let queue = QUEUE;
    api.queueList = async () => queue;
    api.queueReorder = async (_sessionId, ids) => {
      queue = ids.map((id, position) => ({ ...queue.find((item) => item.id === id), position }));
      return queue;
    };
    api.listWorktrees = async () => [{ path: "/repo", branch: "master", head: "0", isMain: true }];
    api.gitBranches = async () => ({ current: "master", branches: [{ name: "master", current: true }] });
    function Dock() {
      const events = store.useStore((s) => s.events[SID]);
      const session = store.useStore((s) => s.sessions.find((x) => x.id === SID) ?? null);
      const model = useMemo(() => buildModel(events ?? []), [events]);
      const activity = resolveSessionActivity(session, model.turn, []);
      return h("div", { className: "focus-conversation" },
        h("div", { className: "conversation-composer-dock" },
          activity.working ? h(AgentLiveStatusDock, { activity, model }) : null,
          h(Composer)));
    }
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [{ id: "p1", path: "/repo", name: "Repo", createdAt: 0 }]);
    store.activateProject("p1");
    store.setModels([{ providerID: "anthropic", modelID: "opus", name: "Opus", connected: true, harnessId: "claude", context: 200000 }]);
    store.setSessions("p1", [{
      id: SID, projectId: "p1", title: "Stack", status: "working", createdAt: 1, updatedAt: 1, lastTurnAt: 1,
      attention: { questions: 0, permissions: 0, unread: 0 }, model: OPUS, resolvedHarnessId: "claude",
      contextWindow: { limitTokens: 200000, usedTokens: 68000, source: "native", updatedAt: Date.now(), harnessId: "claude" },
    }]);
    store.activateSession(SID);
    store.applyEvent({ id: "e1", sessionId: SID, seq: 1, time: Date.now(), type: "turn/started", data: { turnId: "t", model: OPUS, harnessId: "claude" }, v: 1 });
    store.applyEvent({ id: "e2", sessionId: SID, seq: 2, time: Date.now(), type: "tool/call", data: { callId: "c", tool: "bash", input: { command: "npm test", description: "Run the tests" } }, v: 1 });
    window.__look = (look, mode) => {
      store.updateSettings({ appearanceMode: mode, themeStyle: "liquid-glass" });
      setUiSettings({ shellLook: look });
    };
    createRoot(document.querySelector("#mount")).render(h(Dock));
    window.__ready = true;
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "composer-pending-stack-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/opencode/composer-pending-stack-js",
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

async function open(phone: boolean, tablet = false): Promise<Page> {
  assert.ok(browser);
  const context = await browser.newContext(phone
    ? { viewport: { width: tablet ? 820 : 390, height: tablet ? 1100 : 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1100, height: 760 } });
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.waitForSelector(".queue-chip[role='listitem']");
  await page.waitForSelector(".composer-stop-primary");
  return page;
}

/** Paint and geometry the pending stack promises, whatever the look. */
const probe = (page: Page) => page.evaluate(() => {
  const painted = (element: Element) => {
    const style = getComputedStyle(element);
    const edge = (["Top", "Right", "Bottom", "Left"] as const).some((side) =>
      Number.parseFloat(style[`border${side}Width`]) > 0
      && style[`border${side}Style`] !== "none"
      && style[`border${side}Color`] !== "rgba(0, 0, 0, 0)");
    return style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none"
      || style.boxShadow !== "none" || style.backdropFilter !== "none" || edge;
  };
  const rect = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`missing ${selector}`);
    return element.getBoundingClientRect();
  };
  const card = rect(".composer-card");
  const stop = document.querySelector(".composer-stop-primary")!;
  const stopRect = stop.getBoundingClientRect();
  const stopAfter = getComputedStyle(stop, "::after");
  const stopStyle = getComputedStyle(stop);
  return {
    plates: [".agent-status-dock", ".queue-list", ".queue-block", ".queue-chip[role='listitem']"]
      .filter((selector) => [...document.querySelectorAll(selector)].some(painted)),
    statusText: rect(".agent-status-dock-state").left - card.left,
    queueText: rect(".queue-chip[role='listitem'] .queue-text").left - card.left,
    statusMark: rect(".agent-status-dock-icon").left + rect(".agent-status-dock-icon").width / 2 - card.left,
    queueMark: rect(".queue-chip[role='listitem'] .queue-mark").left + rect(".queue-chip[role='listitem'] .queue-mark").width / 2 - card.left,
    rowHeight: rect(".queue-chip[role='listitem']").height,
    stop: { width: stopRect.width, height: stopRect.height, shadow: stopStyle.boxShadow, ring: stopAfter.borderTopWidth, border: stopStyle.borderTopWidth, target: Number.parseFloat(stopAfter.height) },
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});

for (const phone of [false, true]) {
  test(`${phone ? "phone" : "desktop"}: every look keeps the stack plateless and on one grid, and Stop calm`, { skip: !CHROME }, async () => {
    const page = await open(phone);
    try {
      for (const look of LOOKS) for (const mode of SCHEMES) {
        await page.evaluate(([nextLook, nextMode]) => (window as unknown as { __look(a: string, b: string): void }).__look(nextLook!, nextMode!), [look, mode]);
        await page.waitForFunction((value) => document.body.dataset.shellLook === value, look);
        const facts = await probe(page);
        const at = `${look}/${mode}`;
        assert.deepEqual(facts.plates, [], `${at}: no line paints a surface`);
        assert.ok(Math.abs(facts.statusText - facts.queueText) <= 1, `${at}: queue text starts under the status words (${facts.statusText} vs ${facts.queueText})`);
        assert.ok(Math.abs(facts.statusMark - facts.queueMark) <= 1, `${at}: marks share a column (${facts.statusMark} vs ${facts.queueMark})`);
        assert.ok(facts.rowHeight <= 30, `${at}: a queued prompt reads one quiet row (${facts.rowHeight}px)`);
        assert.equal(facts.stop.width, facts.stop.height, `${at}: Stop is a true disc or square`);
        assert.equal(facts.stop.ring, "0px", `${at}: no ring`);
        assert.equal(facts.stop.border, "0px", `${at}: no border either`);
        assert.equal(facts.stop.shadow, "none", `${at}: no glow`);
        assert.equal(facts.overflow, false, `${at}: nothing overflows the page`);
        if (phone) assert.ok(facts.stop.target >= 44, `${at}: Stop keeps a full touch target (${facts.stop.target}px)`);
      }
    } finally {
      await page.context().close();
    }
  });
}

test("phone: the queue block is one full target and its sheet offers full-size actions", { skip: !CHROME }, async () => {
  const page = await open(true);
  try {
    const block = await page.locator(".queue-open").boundingBox();
    assert.ok(block && block.height >= 44, `the block is a full target (${block?.height}px)`);
    assert.equal(await page.locator(".queue-actions").count(), 0);
    await page.locator(".queue-open").tap();
    await page.waitForSelector(".queue-sheet-row");
    const targets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".queue-sheet-row .queue-sheet-grip, .queue-sheet-row .queue-sheet-text, .queue-sheet-row .ui-icon-btn")].map((element) => {
      const rect = element.getBoundingClientRect();
      const after = getComputedStyle(element, "::after");
      return Math.max(rect.height, Number.parseFloat(after.height) || 0);
    }));
    assert.ok(targets.length >= 8 && targets.every((height) => height >= 44), `every target is at least 44px tall: ${targets.join(", ")}`);
  } finally {
    await page.context().close();
  }
});

test("phone: a real touch drags a queued prompt by its handle and the new order persists", { skip: !CHROME }, async () => {
  const page = await open(true);
  try {
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const block = (await page.locator(".queue-open").boundingBox())!;
    await touch("touchStart", block.x + block.width / 2, block.y + block.height / 2);
    await touch("touchEnd");
    await page.waitForSelector(".queue-sheet-row");
    await page.waitForTimeout(450);
    const order = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-sheet-row]")].map((row) => row.dataset.sheetRow));
    assert.deepEqual(await order(), ["q1", "q2"]);
    const grip = (await page.locator(".queue-sheet-row:nth-child(1) .queue-sheet-grip").boundingBox())!;
    const last = (await page.locator(".queue-sheet-row:nth-child(2)").boundingBox())!;
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    await touch("touchStart", x, y);
    for (let step = 1; step <= 8; step += 1) {
      await touch("touchMove", x, y + ((last.y + last.height - y) * step) / 8);
      await page.waitForTimeout(16);
    }
    assert.equal(await page.locator("[data-lifted]").count(), 1, "the row stays lifted under the finger: the browser did not take the gesture for a pan");
    assert.deepEqual(await order(), ["q2", "q1"], "neighbours make room during the drag");
    await touch("touchEnd");
    await page.waitForFunction(() => document.querySelectorAll("[data-lifted]").length === 0);
    assert.deepEqual(await order(), ["q2", "q1"], "the new order stands after the server answers");
    assert.equal(await page.locator(".queue-sheet").count(), 1, "dragging a row does not dismiss the sheet");
  } finally {
    await page.context().close();
  }
});

test("tablet: a coarse pointer keeps full targets outside the phone shell, unclipped", { skip: !CHROME }, async () => {
  const page = await open(true, true);
  try {
    assert.equal(await page.locator(".composer-mobile").count(), 0, "this is not the phone shell");
    assert.equal(await page.locator(".queue-open").count(), 1, "no hover: the queue block opens the sheet");
    // The target is what a tap actually reaches, past the disc and any clipping row.
    const reaches = await page.evaluate(() => {
      const stop = document.querySelector(".composer-stop-primary")!;
      const rect = stop.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hits = (px: number, py: number) => document.elementFromPoint(px, py)?.closest(".composer-stop-primary") === stop;
      return { size: rect.width, top: hits(x, rect.top - 3), bottom: hits(x, rect.bottom + 3), left: hits(rect.left - 3, y), right: hits(rect.right + 3, y) };
    });
    assert.equal(reaches.size, 36);
    assert.deepEqual([reaches.top, reaches.bottom, reaches.left, reaches.right], [true, true, true, true], "Stop answers 4px past its disc on every side");
  } finally {
    await page.context().close();
  }
});
