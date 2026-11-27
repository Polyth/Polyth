// Folding the pending stack above the REAL Composer (docs/dev/ui.md "Folding
// the pending stack"): the lines fold into one spine on the stack's grid, the
// spine names every hidden line in stack order, the fold is a per-device
// preference, Tab still takes the suggestion while folded, and a stack of one
// row never offers a fold. Measured in a real browser: these are layout facts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../buildConfig.ts";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ORIGIN = "http://pending-stack-fold.test";
const SUGGESTION = "Check the zone temperatures now and compare them with the 09:20 baseline.";

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
    outdir: "/tmp/opencode/pending-stack-fold-css",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  })).outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const entry = `
    import { createElement as h, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { api } from "@polyth/session/web-api";
    import { PENDING_STACK_CONTAINER, PendingStackProvider, PendingStackStore } from "@polyth/web-sdk/pending-stack";
    import Composer from "./components/Composer.tsx";
    import SessionWaitsLine from "./components/SessionWaitsLine.tsx";
    import * as store from "./store.ts";
    const SID = "s1";
    const OPUS = { providerID: "anthropic", modelID: "opus" };
    const params = new URLSearchParams(location.search);
    const queued = Number(params.get("queue") ?? "2");
    let queue = Array.from({ length: queued }, (_, index) => ({
      id: "q" + index, sessionId: SID, position: index, text: index === 0 ? "Run the tests after this and show the diff" : "Second", delivery: "queue", createdAt: index + 1,
    }));
    api.queueList = async () => queue;
    api.listWorktrees = async () => [{ path: "/repo", branch: "master", head: "0", isMain: true }];
    api.gitBranches = async () => ({ current: "master", branches: [{ name: "master", current: true }] });
    const WAITS = params.get("waits") === "0" ? [] : [{ id: "w1", kind: "seconds", since: Date.now(), deadline: Date.now() + (3 * 60 + 26) * 60_000 + 30_000 }];
    function Dock() {
      const [stack] = useState(() => new PendingStackStore({ defaultFolded: params.get("phone") === "1", motion: () => false }));
      return h("div", { className: "focus-conversation" },
        h("div", { className: "conversation-composer-dock", [PENDING_STACK_CONTAINER]: "" },
          h(PendingStackProvider, { store: stack },
            h(SessionWaitsLine, { waits: WAITS, idle: true }),
            h(Composer))));
    }
    const ticket = store.beginProjectListRequest();
    store.publishProjectList(ticket, [{ id: "p1", path: "/repo", name: "Repo", createdAt: 0 }]);
    store.activateProject("p1");
    store.setModels([{ providerID: "anthropic", modelID: "opus", name: "Opus", connected: true, harnessId: "claude", context: 200000 }]);
    store.setSessions("p1", [{
      id: SID, projectId: "p1", title: "Stack", status: "idle", createdAt: 1, updatedAt: 1, lastTurnAt: 1,
      attention: { questions: 0, permissions: 0, unread: 0 }, model: OPUS, resolvedHarnessId: "claude",
      promptSuggestion: ${JSON.stringify(SUGGESTION)},
      contextWindow: { limitTokens: 200000, usedTokens: 68000, source: "native", updatedAt: Date.now(), harnessId: "claude" },
    }]);
    store.activateSession(SID);
    createRoot(document.querySelector("#mount")).render(h(Dock));
    window.__ready = true;
  `;
  const js = (await build({
    ...browserBuildOptions,
    stdin: { contents: entry, resolveDir: SRC, loader: "tsx", sourcefile: "pending-stack-fold-entry.tsx" },
    format: "iife", splitting: false, external: [], outdir: "/tmp/opencode/pending-stack-fold-js",
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

async function open(query = "", phone = false): Promise<{ page: Page; context: BrowserContext }> {
  assert.ok(browser);
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : { viewport: { width: 1100, height: 760 } });
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/${query}`);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await page.waitForSelector(".composer-suggestion", { state: "attached" });
  return { page, context };
}

/** Where the stack's lines and the spine stand, in the card's coordinates. */
const probe = (page: Page) => page.evaluate(() => {
  const card = document.querySelector(".composer-card")!.getBoundingClientRect();
  const shown = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    return Boolean(element && element.getClientRects().length > 0 && getComputedStyle(element).display !== "none");
  };
  const spine = document.querySelector<HTMLElement>(".pending-stack-spine");
  const spineShown = Boolean(spine && spine.getBoundingClientRect().height > 1
    && spine.closest(".composer-notice-row")?.getAttribute("data-open") === "true");
  const rect = (element: Element | null | undefined) => element ? element.getBoundingClientRect() : null;
  const firstMark = rect(spine?.querySelector(".pending-stack-mark"));
  const chevron = rect(spine?.querySelector(".pending-stack-chevron"));
  const px = (name: string) => {
    const probeEl = document.createElement("div");
    probeEl.style.position = "absolute";
    probeEl.style.inlineSize = `var(${name})`;
    document.querySelector(".composer")!.appendChild(probeEl);
    const width = probeEl.getBoundingClientRect().width;
    probeEl.remove();
    return width;
  };
  return {
    waits: shown(".session-waits"),
    queue: shown(".queue-list"),
    suggestion: shown(".composer-suggestion"),
    spine: spineShown,
    spineHeight: rect(spine)?.height ?? 0,
    tokens: [...(spine?.querySelectorAll<HTMLElement>(".pending-stack-token") ?? [])].map((token) => ({
      id: token.dataset.token,
      lead: token.hasAttribute("data-lead"),
      text: token.textContent ?? "",
    })),
    label: spine?.getAttribute("aria-label") ?? "",
    fold: document.querySelectorAll(".pending-stack-fold").length,
    foldInFirstLine: Boolean(document.querySelector(".session-waits[data-stack-first] > .pending-stack-fold")),
    markCentre: firstMark ? firstMark.left + firstMark.width / 2 - card.left : null,
    chevronEnd: chevron ? card.right - chevron.right : null,
    stackMark: px("--composer-stack-mark"),
    stackEnd: px("--composer-stack-end"),
    pref: localStorage.getItem("polyth.composerStack.folded.v1"),
    foldGlyph: (() => {
      const glyph = document.querySelector(".pending-stack-fold svg")?.getBoundingClientRect();
      const row = document.querySelector(".session-waits-row")?.getBoundingClientRect();
      return glyph && row ? { end: card.right - glyph.right, offset: (glyph.top + glyph.height / 2) - (row.top + row.height / 2) } : null;
    })(),
  };
});

test("the open stack folds into one spine on the stack's grid and opens again", { skip: !CHROME }, async () => {
  const { page, context } = await open();
  try {
    await page.waitForSelector(".queue-chip[role='listitem']");
    await page.waitForSelector(".pending-stack-fold");
    let state = await probe(page);
    assert.equal(state.spine, false, "a desktop starts open");
    assert.ok(state.waits && state.queue && state.suggestion, "every line shows while open");
    assert.equal(state.fold, 1, "one fold control");
    assert.equal(state.foldInFirstLine, true, "the fold control sits on the stack's first line");
    assert.ok(state.foldGlyph && Math.abs(state.foldGlyph.end - state.stackEnd) <= 0.75,
      `the fold glyph ends on the trailing column (${state.foldGlyph?.end} vs ${state.stackEnd})`);
    assert.ok(state.foldGlyph && Math.abs(state.foldGlyph.offset) <= 1,
      `the fold glyph centres on the first row (${state.foldGlyph?.offset})`);

    await page.click(".pending-stack-fold");
    await page.waitForFunction(() => document.querySelector(".pending-stack-spine")?.closest(".composer-notice-row")?.getAttribute("data-open") === "true");
    state = await probe(page);
    assert.equal(state.waits || state.queue || state.suggestion, false, "every token line is folded away");
    assert.equal(state.spine, true);
    assert.ok(state.spineHeight <= 44, `the spine is one row (${state.spineHeight}px)`);
    assert.deepEqual(state.tokens.map((token) => token.id), ["waits", "queue", "suggestion"], "stack order");
    const waits = state.tokens[0]!;
    const queueToken = state.tokens[1]!;
    const lead = state.tokens[2]!;
    assert.match(waits.text, /^3h 2[67]m$/, "the timer shows its time left");
    assert.equal(queueToken.text, "2", "the queue is its count");
    assert.equal(lead.lead, true, "the suggestion speaks while no agent works");
    assert.ok(lead.text.startsWith(SUGGESTION), "the lead says its words");
    assert.match(state.label, /Queued: 2/, "the spine names every hidden line");
    assert.ok(state.markCentre !== null && Math.abs(state.markCentre - state.stackMark) <= 0.75,
      `the first mark centres on the marks' column (${state.markCentre} vs ${state.stackMark})`);
    assert.ok(state.chevronEnd !== null && Math.abs(state.chevronEnd - state.stackEnd) <= 0.75,
      `the chevron ends on the trailing column (${state.chevronEnd} vs ${state.stackEnd})`);
    assert.equal(state.fold, 0, "no fold control while folded");
    assert.equal(state.pref, "true", "the fold is remembered on this device");

    // Tab still takes the suggestion from a folded stack.
    await page.focus(".composer textarea");
    await page.keyboard.press("Tab");
    await page.waitForFunction((text) => (document.querySelector(".composer textarea") as HTMLTextAreaElement).value === text, SUGGESTION);
    await page.fill(".composer textarea", "");

    await page.click(".pending-stack-spine");
    await page.waitForSelector(".pending-stack-fold");
    state = await probe(page);
    assert.ok(state.waits && state.queue, "the lines are back");
    assert.equal(state.pref, "false");
  } finally {
    await context.close();
  }
});

test("the keyboard folds and opens the stack, and the focus follows", { skip: !CHROME }, async () => {
  const { page, context } = await open();
  try {
    await page.waitForSelector(".pending-stack-fold");
    await page.focus(".pending-stack-fold");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.classList.contains("pending-stack-spine") === true);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.classList.contains("pending-stack-fold") === true);
  } finally {
    await context.close();
  }
});

test("a phone starts folded, and one row never offers a fold", { skip: !CHROME }, async () => {
  const phone = await open("?phone=1", true);
  try {
    await phone.page.waitForFunction(() => document.querySelector(".pending-stack-spine")?.closest(".composer-notice-row")?.getAttribute("data-open") === "true");
    const state = await probe(phone.page);
    assert.equal(state.spine, true, "a phone starts folded");
    assert.equal(state.suggestion, false);
  } finally {
    await phone.context.close();
  }
  const single = await open("?queue=0&waits=0");
  try {
    await single.page.waitForSelector(".composer-suggestion");
    const state = await probe(single.page);
    assert.equal(state.fold, 0, "nothing to fold in one row");
    assert.equal(state.spine, false);
    assert.equal(state.suggestion, true);
  } finally {
    await single.context.close();
  }
});
