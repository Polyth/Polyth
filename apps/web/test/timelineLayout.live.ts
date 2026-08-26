// UX-TIMELINE-LAYOUT-01 live layout gate. Drives a real Chromium against the
// isolated synthetic runtime (timelineLayoutFixtureSetup.mjs + the shared
// fake model backend) and asserts the spec's acceptance items: centered
// reading measure with zero document overflow, reserved utility/reveal
// regions that never cover transcript content, tail clearance, streaming
// tail-follow and reader-held positions, a named keyboard-operable
// `Jump to latest`, suffix-window reveal/jump/anchor stability across reload
// and server restart, and event-log purity for every layout interaction.
//
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --test apps/web/test/timelineLayout.live.ts
//
// Self-booting: builds the disposable fixture, builds apps/web/dist when
// missing, and starts an isolated Polyth server on port 4463 whose PATH
// resolves `opencode` to the synthetic fake. Override with POLYTH_LIVE_URL to
// point at an externally started fixture runtime instead.
//   POLYTH_CHROMIUM_PATH   Chromium executable (well-known paths otherwise)
//   POLYTH_LIVE_ARTIFACTS  directory for screenshots
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  FIXTURE_BIN, FIXTURE_DATA, FIXTURE_HOME, MANY_TURNS, OC_SEED, OC_STATE,
  PROJECT_ID, REPO_ROOT, SESSIONS, TEXTS, buildTimelineLayoutFixture,
} from "./timelineLayoutFixtureSetup.mjs";

// ---- environment -----------------------------------------------------------

const SELF_BOOT = !process.env.POLYTH_LIVE_URL;
const BASE = (process.env.POLYTH_LIVE_URL ?? "http://127.0.0.1:4463").replace(/\/$/, "");
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? "/tmp/polyth-tl01-artifacts";

const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
];

async function chromiumPath(): Promise<string> {
  const candidates = process.env.POLYTH_CHROMIUM_PATH
    ? [process.env.POLYTH_CHROMIUM_PATH]
    : CHROMIUM_CANDIDATES;
  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  throw new Error("No Chromium executable found; set POLYTH_CHROMIUM_PATH.");
}

// ---- fixture + server + browser lifecycle -----------------------------------

let browser: Browser;
let serverProc: ChildProcess | undefined;
const contexts: BrowserContext[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SERVER_ENV = () => ({
  ...process.env,
  HOME: FIXTURE_HOME,
  XDG_CONFIG_HOME: join(FIXTURE_HOME, ".config"),
  XDG_DATA_HOME: join(FIXTURE_HOME, ".local/share"),
  OPENCODE_CONFIG_DIR: join(FIXTURE_HOME, "opencode"),
  POLYTH_DATA_DIR: FIXTURE_DATA,
  PORT: "4463",
  PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
  MSGACT_OC_SEED: OC_SEED,
  MSGACT_OC_STATE: OC_STATE,
  POLYTH_FAKE_BROWSER: "1",
});

const startServer = () => {
  serverProc = spawn(process.execPath, ["packages/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: SERVER_ENV(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout?.resume();
  serverProc.stderr?.resume();
};

const stopServer = async () => {
  if (serverProc && serverProc.exitCode === null) {
    const exited = new Promise<void>((resolve) => serverProc!.once("exit", () => resolve()));
    serverProc.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
    if (serverProc.exitCode === null) serverProc.kill("SIGKILL");
  }
};

const waitHealthy = async () => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const health = await fetch(`${BASE}/api/health`).then((r) => r.json()) as { ok?: boolean };
      if (health.ok === true) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${BASE} did not become healthy`);
    await sleep(250);
  }
};

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (SELF_BOOT) {
    await buildTimelineLayoutFixture();
    if (!existsSync(join(REPO_ROOT, "apps/web/dist/index.html"))) {
      execFileSync(process.execPath, ["apps/web/build.ts"], { cwd: REPO_ROOT, stdio: "pipe" });
    }
    startServer();
  }
  await waitHealthy();
  const pw = await import("playwright-core");
  browser = await pw.chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
  });
});

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopServer();
});

// Persona seed skips first-run onboarding deterministically (prefs contract).
const PERSONA_SEED = JSON.stringify({ persona: "engineer", plugins: [] });

interface OpenOpts {
  width: number;
  height: number;
  session: string;
  ready?: string;
  clipboard?: boolean;
}

interface LivePage {
  page: Page;
  /** Uncaught page errors collected since open — must stay empty. */
  errors: string[];
}

async function openApp(opts: OpenOpts): Promise<LivePage> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  if (opts.clipboard) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  }
  await context.addInitScript(({ seed, projectId }: { seed: string; projectId: string }) => {
    localStorage.setItem("polyth.prefs", seed);
    localStorage.setItem(`polyth.projectSetup.v1.${projectId}`, "completed");
  }, { seed: PERSONA_SEED, projectId: PROJECT_ID });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${opts.session}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(opts.ready ?? ".composer, .timeline", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(200);
  return { page, errors };
}

async function closePage(lp: LivePage): Promise<void> {
  assert.deepEqual(lp.errors, [], `uncaught page errors: ${lp.errors.join(" | ")}`);
  await lp.page.context().close();
  const i = contexts.indexOf(lp.page.context());
  if (i >= 0) contexts.splice(i, 1);
}

type EventRow = { seq: number; time: number; type: string; data: Record<string, unknown> };
const fetchEvents = (sessionId: string): Promise<EventRow[]> =>
  fetch(`${BASE}/api/sessions/${sessionId}/events?afterSeq=0`).then((r) => r.json()) as Promise<never>;

const sendMessage = async (sessionId: string, text: string) => {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200, `send to ${sessionId} failed`);
};

/** Distance from the scroll maximum, visible row-id list, and duplicates. */
const scrollState = (page: Page) => page.evaluate(() => {
  const el = document.querySelector<HTMLElement>(".timeline")!;
  const ids = Array.from(el.querySelectorAll<HTMLElement>("[data-msg-id]")).map((n) => n.dataset.msgId ?? "");
  return {
    distance: el.scrollHeight - el.scrollTop - el.clientHeight,
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    msgCount: el.querySelectorAll(":scope > .msg").length,
    ids,
    duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
  };
});

/** Topmost usable-visible anchored row (mirrors captureTimelineAnchor). */
const topAnchor = (page: Page) => page.evaluate(() => {
  const el = document.querySelector<HTMLElement>(".timeline")!;
  const edge = el.getBoundingClientRect().top;
  for (const node of el.querySelectorAll<HTMLElement>("[data-msg-id]")) {
    const r = node.getBoundingClientRect();
    if (r.bottom >= edge) return { id: node.dataset.msgId ?? "", offset: r.top - edge };
  }
  return { id: "", offset: 0 };
});

test("user message actions wrap without making the timeline horizontally pannable", async () => {
  for (const width of [390, 1280]) {
    const lp = await openApp({ width, height: width === 390 ? 844 : 900, session: SESSIONS.rich, ready: ".msg.user .msg-actions button" });
    const { page } = lp;
    const lastUser = page.locator(".timeline > .msg.user").last();
    await lastUser.scrollIntoViewIfNeeded();
    if (width > 480) await lastUser.hover();
    await page.waitForTimeout(150);

    const geometry = await page.evaluate(() => {
      const timeline = document.querySelector<HTMLElement>(".timeline")!;
      const port = timeline.getBoundingClientRect();
      const messages = Array.from(timeline.querySelectorAll<HTMLElement>(":scope > .msg.user"));
      const rows = messages.map((message) => message.querySelector<HTMLElement>(".msg-actions")!).filter(Boolean);
      const buttons = rows.flatMap((row) => Array.from(row.querySelectorAll<HTMLButtonElement>("button")));
      const outside = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        return rect.left < port.left - 1 || rect.right > port.right + 1;
      };
      return {
        buttonCount: buttons.length,
        timelineOverflow: timeline.scrollWidth - timeline.clientWidth,
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        overflowingMessages: messages.filter(outside).length,
        overflowingRows: rows.filter(outside).length,
        overflowingButtons: buttons.flatMap((button) =>
          outside(button) ? [button.getAttribute("aria-label") ?? "unnamed user action"] : []),
        nonWrappingRows: rows.filter((row) => getComputedStyle(row).flexWrap !== "wrap").length,
      };
    });

    assert.ok(geometry.buttonCount >= 3, `${width}px: expected user message actions`);
    assert.ok(geometry.timelineOverflow <= 1, `${width}px: timeline pans by ${geometry.timelineOverflow}px`);
    assert.ok(geometry.documentOverflow <= 1, `${width}px: document overflows by ${geometry.documentOverflow}px`);
    assert.equal(geometry.overflowingMessages, 0, `${width}px: user messages leave the timeline`);
    assert.equal(geometry.overflowingRows, 0, `${width}px: user action rows leave the timeline`);
    assert.deepEqual(geometry.overflowingButtons, [], `${width}px: user action buttons leave the timeline`);
    assert.equal(geometry.nonWrappingRows, 0, `${width}px: user action rows cannot wrap`);

    await page.screenshot({ path: join(ARTIFACTS, `fix_round6_user_actions_${width}.png`) });
    await closePage(lp);
  }
});

test("Compare responses leaves Project files and opens Multi-Run", async () => {
  const lp = await openApp({ width: 390, height: 844, session: SESSIONS.rich, ready: ".mobile-navigation-trigger" });
  const { page } = lp;

  await page.getByRole("button", { name: "Application" }).click();
  await page.getByRole("menuitem", { name: "Project files", exact: true }).click();
  await page.waitForSelector('.rail-fullscreen[aria-label="Project files"]', { state: "visible", timeout: 10_000 });

  await page.getByRole("button", { name: "Application" }).click();
  await page.getByRole("menuitem", { name: "Compare responses", exact: true }).click();
  await page.waitForSelector(".multirun-prompt", { state: "visible", timeout: 10_000 });
  await page.waitForTimeout(250);

  const state = await page.evaluate(() => ({
    multiRun: document.querySelector(".app.view-multirun .multirun-prompt") !== null,
    filesOpen: document.querySelector('.rail-fullscreen[aria-label="Project files"]') !== null,
    title: document.querySelector(".view-title")?.textContent?.trim() ?? "",
  }));
  assert.equal(state.multiRun, true, "Compare responses did not remain on Multi-Run");
  assert.equal(state.filesOpen, false, "Project files stayed open over Multi-Run");
  assert.match(state.title, /Multi-Run/i, `unexpected destination title "${state.title}"`);

  await page.screenshot({ path: join(ARTIFACTS, "fix_round6_compare_responses_390.png") });
  await closePage(lp);
});

test("mobile response actions wrap inside the timeline and remain operable", async () => {
  for (const width of [390, 320]) {
    const lp = await openApp({ width, height: 844, session: SESSIONS.rich, ready: ".agent-reply-actions button" });
    const { page } = lp;
    await page.evaluate(() => {
      const timeline = document.querySelector<HTMLElement>(".timeline")!;
      timeline.scrollTop = timeline.scrollHeight;
    });
    await page.waitForTimeout(150);

    const geometry = await page.evaluate(() => {
      const timeline = document.querySelector<HTMLElement>(".timeline")!;
      const port = timeline.getBoundingClientRect();
      const groups = Array.from(document.querySelectorAll<HTMLElement>(".agent-reply-actions"));
      const buttons = groups.flatMap((group) => Array.from(group.querySelectorAll<HTMLButtonElement>("button")));
      const overflows = buttons.flatMap((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left < port.left - 1 || rect.right > port.right + 1
          ? [button.getAttribute("aria-label") ?? "unnamed response action"]
          : [];
      });
      const undersized = buttons.flatMap((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width < 43.5 || rect.height < 43.5
          ? [button.getAttribute("aria-label") ?? "unnamed response action"]
          : [];
      });
      const unwrappedRows = groups.filter((actions) => {
        const header = actions.closest<HTMLElement>(".agent-reply-header")!;
        return actions.getBoundingClientRect().top <= header.getBoundingClientRect().top + 1;
      }).length;
      const inactive = groups.filter((actions) => {
        const style = getComputedStyle(actions);
        return style.opacity !== "1" || style.pointerEvents === "none";
      }).length;
      return {
        buttonCount: buttons.length,
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        groupOverflow: groups.some((group) => group.scrollWidth > group.clientWidth + 1),
        overflows,
        undersized,
        unwrappedRows,
        inactive,
      };
    });

    assert.ok(geometry.buttonCount >= 6, `${width}px: expected configured response actions`);
    assert.ok(geometry.documentOverflow <= 1, `${width}px: document overflows by ${geometry.documentOverflow}px`);
    assert.equal(geometry.groupOverflow, false, `${width}px: response action group overflows`);
    assert.deepEqual(geometry.overflows, [], `${width}px: response action buttons leave the timeline`);
    assert.deepEqual(geometry.undersized, [], `${width}px: response action touch targets are smaller than 44px`);
    assert.equal(geometry.unwrappedRows, 0, `${width}px: response actions still share the metadata row`);
    assert.equal(geometry.inactive, 0, `${width}px: response actions are not touch-operable`);

    if (width === 390) {
      await page.screenshot({ path: join(ARTIFACTS, "fix_round6_assistant_actions_390.png") });
    }

    if (width === 390) {
      const action = page.getByRole("button", { name: "Start new multi-run from this answer" }).last();
      const seededAnswer = await action.evaluate((button) =>
        button.closest(".msg")?.querySelector<HTMLElement>(".bubble")?.innerText ?? "");
      await action.click();
      await page.waitForSelector(".multirun-prompt", { state: "visible" });
      assert.equal(await page.locator(".multirun-prompt").inputValue(), seededAnswer);
    }
    await closePage(lp);
  }
});

// =============================================================================
// 1. Geometry matrix (spec 9.1 item 3): centered measure, zero document
//    overflow, disjoint reserved chrome, tail clearance, pointer-center hits —
//    at required viewports plus the 125%/200% zoom CSS sizes.
// =============================================================================

test("geometry: centered measure, disjoint reserved chrome, tail clearance at all required sizes", async () => {
  const sizes: Array<[number, number, string]> = [
    [1440, 900, "1440"],
    [1024, 900, "1024"],
    [768, 900, "768"],
    [390, 844, "390"],
    [320, 844, "320"],
    [614, 720, "zoom125"],
    [384, 450, "zoom200"],
  ];
  for (const [w, h, label] of sizes) {
    const lp = await openApp({ width: w, height: h, session: SESSIONS.rich, ready: ".msg" });
    const { page } = lp;
    const ctx = `rich@${label} (${w}x${h})`;
    // Settle at the tail so the final surface geometry is measured.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".timeline")!;
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(150);

    const g = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".timeline")!;
      const port = el.getBoundingClientRect();
      const clip = (r: DOMRect) => ({
        top: Math.max(r.top, port.top),
        bottom: Math.min(r.bottom, port.bottom),
        left: Math.max(r.left, port.left),
        right: Math.min(r.right, port.right),
      });
      const visible = (r: DOMRect) => {
        const c = clip(r);
        return c.bottom - c.top > 1 && c.right - c.left > 1;
      };
      const intersects = (
        a: { top: number; bottom: number; left: number; right: number },
        b: { top: number; bottom: number; left: number; right: number },
      ) => a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;

      const contentSel = ":scope > .msg, :scope > .timeline-earlier, :scope > .turn-error, :scope > .turn-footer, :scope > .rewound-tail";
      const contentRects = Array.from(el.querySelectorAll<HTMLElement>(contentSel))
        .map((n) => n.getBoundingClientRect())
        .filter(visible)
        .map(clip);

      const utility = document.querySelector<HTMLElement>(".timeline-utility");
      const utilityRect = utility?.getBoundingClientRect() ?? null;
      // Chips inside the horizontally scrollable strip are clipped by it; the
      // pairwise-overlap gate compares their VISIBLE boxes.
      const utilityControls = utility
        ? Array.from(utility.querySelectorAll<HTMLElement>("button")).flatMap((n) => {
            const r = n.getBoundingClientRect();
            const strip = n.closest<HTMLElement>(".prompt-nav-items");
            const s = strip?.getBoundingClientRect();
            const rect = {
              top: r.top,
              bottom: r.bottom,
              left: s ? Math.max(r.left, s.left) : r.left,
              right: s ? Math.min(r.right, s.right) : r.right,
            };
            if (rect.right - rect.left <= 1) return [];
            return [{ name: n.getAttribute("aria-label") ?? n.textContent ?? "", rect }];
          })
        : [];
      const composer = document.querySelector<HTMLElement>(".composer")?.getBoundingClientRect() ?? null;

      // Per-message: body and footer occupy disjoint boxes.
      const bodyFooterOverlaps = Array.from(document.querySelectorAll<HTMLElement>(".timeline > .msg"))
        .map((m) => {
          const bubble = m.querySelector(":scope > .bubble")?.getBoundingClientRect();
          const meta = m.querySelector(":scope > .msg-meta")?.getBoundingClientRect();
          return bubble && meta && intersects(bubble, meta) ? 1 : 0;
        })
        .reduce((a: number, b) => a + b, 0);

      const msgs = Array.from(document.querySelectorAll<HTMLElement>(".timeline > .msg"));
      const lastBottom = contentRects.reduce((max, r) => Math.max(max, r.bottom), port.top);

      // Pointer centers of visible utility controls + persistent action entries.
      const centerMisses: string[] = [];
      const centerCheck = (n: HTMLElement, name: string) => {
        const r = n.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) return;
        const strip = n.closest<HTMLElement>(".prompt-nav-items");
        if (strip) {
          const s = strip.getBoundingClientRect();
          if (r.left < s.left - 1 || r.right > s.right + 1) return; // scrolled out of the strip
        }
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!(n === hit || n.contains(hit))) {
          centerMisses.push(`${name} covered by ${hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : "nothing"}`);
        }
      };
      for (const n of document.querySelectorAll<HTMLElement>(".prompt-nav-item, .timeline-open, .jump-latest")) {
        centerCheck(n, n.getAttribute("aria-label") ?? n.className);
      }
      for (const n of document.querySelectorAll<HTMLElement>(".msg-actions-entry")) {
        const r = n.getBoundingClientRect();
        const c = clip(r);
        if (r.width > 0 && c.bottom - c.top >= r.height - 1) centerCheck(n, n.getAttribute("aria-label") ?? "entry");
      }

      return {
        docOverflowX: document.documentElement.scrollWidth - innerWidth,
        maxMsgWidth: msgs.reduce((max, m) => Math.max(max, m.getBoundingClientRect().width), 0),
        dirAuto: document.querySelectorAll('.timeline .bubble[dir="auto"]').length,
        utilityPresent: utility !== null,
        utilityOverlapsContent: utilityRect !== null
          && contentRects.some((r) => intersects(utilityRect, r)),
        utilityControlOverlaps: utilityControls.filter((a, i) =>
          utilityControls.some((b, j) => j > i && intersects(a.rect, b.rect))).length,
        composerOverlapsContent: composer !== null && contentRects.some((r) => intersects(composer, r)),
        bodyFooterOverlaps,
        tailClearance: port.bottom - lastBottom,
        portHeight: el.clientHeight,
        centerMisses,
        timelineName: `${el.getAttribute("role")}:${el.getAttribute("aria-label")}`,
        navName: document.querySelector(".prompt-nav")?.getAttribute("aria-label") ?? "",
        firstChipName: document.querySelector(".prompt-nav-item")?.getAttribute("aria-label") ?? "",
        openName: document.querySelector(".timeline-open")?.getAttribute("aria-label") ?? "",
      };
    });

    assert.ok(g.docOverflowX <= 1, `${ctx}: document scrolls horizontally by ${g.docOverflowX}px`);
    assert.ok(g.maxMsgWidth <= 768.5, `${ctx}: reading measure ${g.maxMsgWidth}px exceeds 768px`);
    assert.ok(g.dirAuto >= 12, `${ctx}: message bubbles missing dir=auto (${g.dirAuto})`);
    assert.ok(g.utilityPresent, `${ctx}: reserved utility region missing`);
    assert.ok(!g.utilityOverlapsContent, `${ctx}: utility region overlaps transcript content`);
    assert.equal(g.utilityControlOverlaps, 0, `${ctx}: utility controls overlap each other`);
    assert.ok(!g.composerOverlapsContent, `${ctx}: composer overlaps the last visible surface`);
    assert.equal(g.bodyFooterOverlaps, 0, `${ctx}: message body and footer boxes intersect`);
    if (h >= 560) {
      assert.ok(g.tailClearance >= 32, `${ctx}: tail clearance ${g.tailClearance}px below 32px`);
    } else {
      assert.ok(g.portHeight >= 120, `${ctx}: usable timeline height ${g.portHeight}px below 120px at 200% zoom`);
    }
    assert.deepEqual(g.centerMisses, [], `${ctx}: covered pointer centers`);
    assert.equal(g.timelineName, "region:Conversation timeline", `${ctx}: scroll root is not the named region`);
    assert.equal(g.navName, "Prompts in this session", `${ctx}: prompt nav name "${g.navName}"`);
    assert.match(g.firstChipName, /^Jump to prompt 1 of 6: /, `${ctx}: chip name "${g.firstChipName}"`);
    assert.equal(g.openName, "Open session timeline", `${ctx}: timeline entry name "${g.openName}"`);

    const state = await scrollState(page);
    assert.deepEqual(state.duplicateIds, [], `${ctx}: duplicate visible message ids`);
    if (label === "1440") await page.screenshot({ path: join(ARTIFACTS, "layout-rich-1440.png") });
    if (label === "390") await page.screenshot({ path: join(ARTIFACTS, "layout-rich-390.png") });
    if (label === "zoom200") await page.screenshot({ path: join(ARTIFACTS, "layout-rich-zoom200.png") });
    await closePage(lp);
  }
});

// =============================================================================
// 2. Empty state: one honest empty state, no phantom utilities or reveal.
// =============================================================================

test("empty session: honest empty state, no phantom nav/reveal, composer reachable", async () => {
  const lp = await openApp({ width: 1280, height: 900, session: SESSIONS.empty, ready: ".composer-input textarea" });
  const state = await lp.page.evaluate(() => ({
    // One honest empty presentation: either the hero start screen (no mounted
    // timeline) or the timeline's own explicit empty state.
    honestEmpty: document.querySelector(".timeline") === null
      || /No messages yet/.test(document.querySelector(".timeline .empty")?.textContent ?? ""),
    msgs: document.querySelectorAll(".timeline .msg").length,
    metas: document.querySelectorAll(".msg-meta").length,
    utility: document.querySelector(".timeline-utility") !== null,
    reveal: document.querySelector(".timeline-reveal") !== null,
    composer: document.querySelector(".composer-input textarea") !== null,
  }));
  assert.ok(state.honestEmpty, "no honest empty state rendered");
  assert.equal(state.msgs, 0, "phantom message rendered");
  assert.equal(state.metas, 0, "phantom message actions rendered");
  assert.equal(state.utility, false, "phantom utility region rendered");
  assert.equal(state.reveal, false, "phantom reveal region rendered");
  assert.ok(state.composer, "composer missing");
  await closePage(lp);
});

// =============================================================================
// 3. Streaming (spec 9.1 item 4): tail follow within 2px; a reader who
//    scrolled up holds within 1px while scrollHeight grows; one named
//    Jump to latest with keyboard activation, arrival, resumed follow, and
//    non-BODY focus.
// =============================================================================

test("streaming: tail follow, reader-held position, keyboard Jump to latest, resumed follow", async () => {
  const lp = await openApp({ width: 1280, height: 900, session: SESSIONS.stream, ready: ".msg" });
  const { page } = lp;

  // --- at the tail: growth follows -----------------------------------------
  const before = await scrollState(page);
  assert.ok(before.distance <= 2, `not at the tail before streaming (distance ${before.distance})`);
  await sendMessage(SESSIONS.stream, "Stream one: follow the tail.");
  await page.waitForSelector('.msg.assistant[aria-label="Assistant answer streaming"]', { timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelector('.msg.assistant[aria-label="Assistant answer streaming"]') === null,
    undefined, { timeout: 15_000 },
  );
  await page.waitForTimeout(250); // layout settles
  const followed = await scrollState(page);
  assert.ok(followed.distance <= 2, `tail follow drifted to ${followed.distance}px`);
  assert.ok(
    await page.evaluate(() => document.querySelectorAll('.msg.assistant[aria-label^="Assistant answer completed"]').length >= 1),
    "finalized assistant container lost its completed name",
  );

  // --- scrolled-up reader holds while the stream grows ----------------------
  const held = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    el.scrollTop = Math.max(0, el.scrollTop - Math.max(200, el.clientHeight / 2));
    return el.scrollTop;
  });
  await page.waitForSelector(".timeline-reveal .jump-latest", { state: "visible", timeout: 5000 });
  await sendMessage(SESSIONS.stream, "Stream two: hold the reading line.");
  const hold = await page.evaluate(async (heldTop: number) => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    const h0 = el.scrollHeight;
    const samples: Array<{ top: number; h: number }> = [];
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 100));
      samples.push({ top: el.scrollTop, h: el.scrollHeight });
    }
    return {
      grew: samples.some((s) => s.h > h0 + 40),
      maxDrift: samples.reduce((max, s) => Math.max(max, Math.abs(s.top - heldTop)), 0),
    };
  }, held);
  assert.ok(hold.grew, "stream two never grew the scroll maximum");
  assert.ok(hold.maxDrift <= 1, `reader position drifted ${hold.maxDrift}px during streaming`);

  // --- Jump to latest: named, keyboard-operable, arrives, resumes follow ----
  const jump = page.locator(".timeline-reveal .jump-latest");
  assert.equal((await jump.textContent())?.trim(), "Jump to latest", "reveal control lost its visible name");
  await page.screenshot({ path: join(ARTIFACTS, "streaming-jump-latest-1280.png") });
  await jump.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    return {
      distance: el.scrollHeight - el.scrollTop - el.clientHeight,
      revealGone: document.querySelector(".timeline-reveal") === null,
      activeTag: document.activeElement?.tagName ?? "NONE",
      activeInTimeline: el.contains(document.activeElement),
    };
  });
  assert.ok(after.distance <= 2, `Jump to latest stopped ${after.distance}px short of the tail`);
  assert.ok(after.revealGone, "reveal region stayed mounted at the tail");
  assert.notEqual(after.activeTag, "BODY", "keyboard jump dropped focus to BODY");
  assert.ok(after.activeInTimeline, "focus did not move into the timeline");

  // --- follow resumes for later growth --------------------------------------
  await sendMessage(SESSIONS.stream, "Stream three: follow resumes.");
  await page.waitForSelector('.msg.assistant[aria-label="Assistant answer streaming"]', { timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelector('.msg.assistant[aria-label="Assistant answer streaming"]') === null,
    undefined, { timeout: 15_000 },
  );
  await page.waitForTimeout(250);
  const resumed = await scrollState(page);
  assert.ok(resumed.distance <= 2, `follow did not resume (distance ${resumed.distance})`);
  assert.deepEqual(resumed.duplicateIds, [], "streaming duplicated a visible message id");
  await closePage(lp);
});

// =============================================================================
// 4. Suffix window + anchors (spec 9.1 item 5): earlier reveal keeps the
//    anchored row, hidden prompt jumps grow the window, dialog jumps hand off
//    focus, and the anchor survives reload, session switch, and restart.
// =============================================================================

test("windowing: reveal keeps the anchor; hidden prompt and dialog jumps land and focus correctly", async () => {
  const lp = await openApp({ width: 1280, height: 900, session: SESSIONS.many, ready: ".timeline-earlier" });
  const { page } = lp;
  const totalRows = MANY_TURNS * 2;

  const initial = await scrollState(page);
  assert.equal(initial.msgCount, 150, `suffix window rendered ${initial.msgCount} rows`);
  assert.deepEqual(initial.duplicateIds, [], "duplicate ids in the initial window");
  const hidden = totalRows - 150;
  const earlier = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".timeline-earlier button")).map((b) => b.textContent ?? ""));
  assert.match(earlier[0] ?? "", new RegExp(`Show ${hidden} earlier`), `earlier reveal caption ${earlier[0]}`);
  assert.match(earlier[1] ?? "", new RegExp(`Show all \\(${hidden} hidden\\)`), `show-all caption ${earlier[1]}`);

  // Hold a mid-scroll reading position, then reveal earlier rows: the anchored
  // row keeps its usable-edge offset and nothing duplicates.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    el.scrollTop = el.scrollHeight / 2;
  });
  await page.waitForTimeout(120);
  const anchorBefore = await topAnchor(page);
  assert.notEqual(anchorBefore.id, "", "no anchored row at the held position");
  // Programmatic activation: a pointer click would auto-scroll the reveal bar
  // into view first and move the reading position this assertion protects.
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>(".timeline-earlier button")!.click();
  });
  await page.waitForFunction(
    (n: number) => document.querySelectorAll(".timeline > .msg").length === n,
    totalRows, { timeout: 10_000 },
  );
  const anchorAfter = await topAnchor(page);
  const grown = await scrollState(page);
  assert.equal(anchorAfter.id, anchorBefore.id, "earlier reveal changed the anchored row");
  assert.ok(
    Math.abs(anchorAfter.offset - anchorBefore.offset) <= 1,
    `earlier reveal moved the anchored row by ${Math.abs(anchorAfter.offset - anchorBefore.offset)}px`,
  );
  assert.deepEqual(grown.duplicateIds, [], "earlier reveal duplicated a row");
  assert.equal(await page.evaluate(() => document.querySelector(".timeline-earlier") !== null), false,
    "reveal bar persists after everything is shown");

  // Hidden prompt jump from the reserved utility strip: the window grows, the
  // target lands in the scrollport, and focus stays on the invoking chip.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".timeline-earlier", { timeout: 15_000 });
  await page.waitForTimeout(200);
  const chip = page.locator(".prompt-nav-item").first();
  assert.match(
    (await chip.getAttribute("aria-label")) ?? "",
    new RegExp(`^Jump to prompt 1 of ${MANY_TURNS}: `),
    "first chip lost its ordered accessible name",
  );
  await chip.click();
  await page.waitForTimeout(250);
  const jumped = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    const rows = el.querySelectorAll<HTMLElement>("[data-msg-id]");
    const first = rows[0]!;
    const r = first.getBoundingClientRect();
    const port = el.getBoundingClientRect();
    return {
      firstVisible: r.bottom > port.top && r.top < port.bottom,
      firstText: first.textContent ?? "",
      focusOnChip: document.activeElement?.classList.contains("prompt-nav-item") ?? false,
      msgCount: el.querySelectorAll(":scope > .msg").length,
    };
  });
  assert.ok(jumped.firstVisible, "hidden prompt jump did not land the target in the scrollport");
  assert.match(jumped.firstText, /Synthetic prompt 1 of /, "jump landed on the wrong row");
  assert.ok(jumped.focusOnChip, "navigator activation moved focus off the invoking chip");
  assert.ok(jumped.msgCount > 150, "hidden prompt jump did not grow the window");

  // Dialog jump: focus hands off to the target message container, never BODY.
  await page.click(".timeline-open");
  await page.waitForSelector(".timeline-dialog-prompt", { timeout: 5000 });
  await page.click(".timeline-dialog-row:nth-child(3) .timeline-dialog-prompt");
  await page.waitForTimeout(250);
  const dialogJump = await page.evaluate(() => ({
    dialogGone: document.querySelector(".timeline-dialog-prompt") === null,
    activeTag: document.activeElement?.tagName ?? "NONE",
    activeIsMsg: document.activeElement?.classList.contains("msg") ?? false,
    activeText: (document.activeElement?.textContent ?? "").slice(0, 40),
  }));
  assert.ok(dialogJump.dialogGone, "timeline dialog stayed open after the jump");
  assert.notEqual(dialogJump.activeTag, "BODY", "dialog jump dropped focus to BODY");
  assert.ok(dialogJump.activeIsMsg, `dialog jump focused ${dialogJump.activeTag} instead of the message container`);
  assert.match(dialogJump.activeText, /Synthetic prompt 3 of /, "dialog jump focused the wrong container");
  await closePage(lp);
});

test("anchors: reading position survives reload, session switch, and server restart", async () => {
  const lp = await openApp({ width: 1280, height: 900, session: SESSIONS.many, ready: ".timeline-earlier" });
  const { page } = lp;

  // Hold a position away from the tail and let the debounced anchor save run.
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    el.scrollTop = el.scrollHeight / 2;
  });
  await page.waitForTimeout(450);
  const anchorBefore = await topAnchor(page);
  assert.notEqual(anchorBefore.id, "", "no anchored row before reload");

  // Direct reload restores the same row at the same usable-edge offset.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".timeline .msg", { timeout: 15_000 });
  await page.waitForTimeout(300);
  const afterReload = await topAnchor(page);
  assert.equal(afterReload.id, anchorBefore.id, "reload restored a different row");
  assert.ok(
    Math.abs(afterReload.offset - anchorBefore.offset) <= 2,
    `reload moved the anchored row by ${Math.abs(afterReload.offset - anchorBefore.offset)}px`,
  );

  // Session switch away and back (same tab) keeps the stored anchor.
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${SESSIONS.rich}`, { waitUntil: "load" });
  await page.waitForSelector(".timeline .msg", { timeout: 15_000 });
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${SESSIONS.many}`, { waitUntil: "load" });
  await page.waitForSelector(".timeline .msg", { timeout: 15_000 });
  await page.waitForTimeout(300);
  const afterSwitch = await topAnchor(page);
  assert.equal(afterSwitch.id, anchorBefore.id, "session switch lost the anchored row");
  assert.ok(
    Math.abs(afterSwitch.offset - anchorBefore.offset) <= 2,
    `session switch moved the anchored row by ${Math.abs(afterSwitch.offset - anchorBefore.offset)}px`,
  );

  // Server restart + canonical replay restores identical content and anchor.
  if (SELF_BOOT) {
    const idsBefore = (await scrollState(page)).ids;
    await stopServer();
    startServer();
    await waitHealthy();
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".timeline .msg", { timeout: 15_000 });
    await page.waitForTimeout(300);
    const restarted = await scrollState(page);
    assert.deepEqual(restarted.ids, idsBefore, "server restart changed visible content or order");
    assert.deepEqual(restarted.duplicateIds, [], "server restart duplicated a row");
    const afterRestart = await topAnchor(page);
    assert.equal(afterRestart.id, anchorBefore.id, "server restart lost the anchored row");
    assert.ok(
      Math.abs(afterRestart.offset - anchorBefore.offset) <= 2,
      `server restart moved the anchored row by ${Math.abs(afterRestart.offset - anchorBefore.offset)}px`,
    );
  }
  await closePage(lp);
});

// =============================================================================
// 5. Event-log purity (spec 9.1 item 8): layout interactions append nothing.
// =============================================================================

test("event purity: hover, jumps, dialog, reveal, menu, copy, and reasoning append no event", async () => {
  const eventsBefore = await fetchEvents(SESSIONS.rich);
  assert.ok(eventsBefore.length > 0, "rich session has no events to compare");

  // Desktop interactions.
  {
    const lp = await openApp({ width: 1280, height: 900, session: SESSIONS.rich, ready: ".msg-meta", clipboard: true });
    const { page } = lp;
    // Prompt hover + focus preview, then a prompt jump.
    await page.hover(".prompt-nav-item");
    await page.waitForSelector(".prompt-nav-preview", { timeout: 5000 });
    await page.locator(".prompt-nav-item").first().focus();
    await page.click(".prompt-nav-item");
    // Timeline dialog open + Escape close.
    await page.click(".timeline-open");
    await page.waitForSelector(".timeline-dialog-prompt", { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    // Scroll away, reveal Jump to latest, activate it.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(".timeline")!;
      el.scrollTop = 0;
    });
    await page.waitForSelector(".timeline-reveal .jump-latest", { state: "visible", timeout: 5000 });
    await page.click(".jump-latest");
    await page.waitForTimeout(150);
    // Reasoning disclosure open + close.
    const summary = page.locator("details.reasoning summary");
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
    await summary.click();
    // Copy Markdown from the hover row.
    const firstUser = ".timeline > .msg.user";
    await page.hover(firstUser);
    await page.click(`${firstUser} button[aria-label^="Copy user message as Markdown"]`);
    await page.waitForFunction(() => (document.querySelector(".msg-live")?.textContent ?? "") !== "", undefined, { timeout: 5000 });
    await closePage(lp);
  }

  // Narrow menu interactions (open, internal scroll, Escape, reopen, copy).
  {
    const lp = await openApp({ width: 390, height: 844, session: SESSIONS.rich, ready: ".msg-actions-entry" });
    const { page } = lp;
    const opener = page.locator(".timeline > .msg.user .msg-actions-entry").first();
    await opener.scrollIntoViewIfNeeded();
    const box = (await opener.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector(".msg-actions-popup", { state: "visible", timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(() => document.querySelector(".msg-actions-popup") === null), true,
      "Escape left the menu open");
    // The open/close cycle scrolled the port to reveal the menu; re-measure
    // the opener before the second unforced center tap.
    await opener.scrollIntoViewIfNeeded();
    const box2 = (await opener.boundingBox())!;
    await page.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.waitForSelector(".msg-actions-popup", { state: "visible", timeout: 5000 });
    const mdRow = page.locator('.msg-actions-popup button[aria-label^="Copy user message as Markdown"]');
    await mdRow.scrollIntoViewIfNeeded();
    const mdBox = (await mdRow.boundingBox())!;
    await page.mouse.click(mdBox.x + mdBox.width / 2, mdBox.y + mdBox.height / 2);
    await page.waitForFunction(() => (document.querySelector(".msg-live")?.textContent ?? "") !== "", undefined, { timeout: 5000 });
    await closePage(lp);
  }

  const eventsAfter = await fetchEvents(SESSIONS.rich);
  assert.deepEqual(eventsAfter, eventsBefore, "a layout interaction appended or mutated session events");
});

// =============================================================================
// 6. Repair gate (verifier finding 1 + 2): at the 200% zoom CSS viewport the
//    short-height composer bar is ONE non-overlapping sequence whose groups
//    have disjoint geometry (internal horizontal scroll keeps every control
//    reachable), and the 120px timeline floor holds with EVERY reserved
//    region mounted — prompt keyboard focus and the latest-reveal region.
// =============================================================================

test("zoom200 dynamic: disjoint composer controls, reachable strip, 120px floor with reserved regions mounted", async () => {
  const lp = await openApp({ width: 384, height: 450, session: SESSIONS.rich, ready: ".msg" });
  const { page } = lp;
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(150);

  // --- composer bar geometry -------------------------------------------------
  const measureBar = () => page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".composer-bar")!;
    const barRect = bar.getBoundingClientRect();
    const controls = Array.from(bar.querySelectorAll<HTMLElement>("button, select"))
      .flatMap((n) => {
        const r = n.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return [];
        return [{
          name: (n.getAttribute("aria-label") ?? n.textContent ?? n.className).trim().slice(0, 48),
          rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        }];
      });
    const inter = (
      a: { top: number; bottom: number; left: number; right: number },
      b: { top: number; bottom: number; left: number; right: number },
    ) => a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
    const overlaps: string[] = [];
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        if (inter(controls[i]!.rect, controls[j]!.rect)) overlaps.push(`${controls[i]!.name} × ${controls[j]!.name}`);
      }
    }
    const groupRect = (sel: string) => {
      const g = document.querySelector(sel)?.getBoundingClientRect();
      return g ? { top: g.top, bottom: g.bottom, left: g.left, right: g.right } : null;
    };
    const selectors = groupRect(".composer-selectors");
    const actions = groupRect(".composer-actions");
    // Center hits for controls whose center is inside the bar's visible clip
    // (the strip scrolls; scrolled-out controls are reached by scrolling it).
    const centerMisses: string[] = [];
    for (const c of controls) {
      const x = (c.rect.left + c.rect.right) / 2;
      const y = (c.rect.top + c.rect.bottom) / 2;
      if (x < barRect.left || x > barRect.right || y < barRect.top || y > barRect.bottom) continue;
      if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) continue;
      const hit = document.elementFromPoint(x, y) as HTMLElement | null;
      const el = Array.from(bar.querySelectorAll<HTMLElement>("button, select")).find((n) =>
        (n.getAttribute("aria-label") ?? n.textContent ?? n.className).trim().slice(0, 48) === c.name);
      if (el && hit && !(el === hit || el.contains(hit) || hit.contains(el))) {
        centerMisses.push(`${c.name}: covered by ${hit.tagName}.${hit.className}`);
      }
    }
    return {
      controls: controls.length,
      overlaps,
      groupsIntersect: selectors !== null && actions !== null && inter(selectors, actions),
      centerMisses,
      scrollable: bar.scrollWidth > bar.clientWidth + 1,
      scrollLeftMax: bar.scrollWidth - bar.clientWidth,
    };
  });

  const settled = await measureBar();
  assert.ok(settled.controls >= 6, `expected the full control set, found ${settled.controls}`);
  assert.deepEqual(settled.overlaps, [], "composer controls intersect at 200%");
  assert.equal(settled.groupsIntersect, false, "selector and action groups share paint area");
  assert.deepEqual(settled.centerMisses, [], "visible composer control centers are covered");

  // Every control stays reachable through the internal horizontal scroll:
  // after scrolling the strip to its end, the trailing controls (Send et al)
  // are visible and their centers hit themselves.
  if (settled.scrollable) {
    await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".composer-bar")!;
      bar.scrollLeft = bar.scrollWidth;
    });
    await page.waitForTimeout(100);
    const scrolled = await measureBar();
    assert.deepEqual(scrolled.overlaps, [], "composer controls intersect after strip scroll");
    assert.deepEqual(scrolled.centerMisses, [], "scrolled-in composer control centers are covered");
    const sendVisible = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".composer-bar")!;
      const send = bar.querySelector<HTMLElement>(".send, .stop");
      if (!send) return false;
      const r = send.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return r.left >= b.left - 1 && r.right <= b.right + 1 && (send === hit || send.contains(hit));
    });
    assert.ok(sendVisible, "Send is not reachable at the end of the strip");
    await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".composer-bar")!;
      bar.scrollLeft = 0;
    });
  }

  // --- dynamic 120px floor ---------------------------------------------------
  const portHeight = () => page.evaluate(() => document.querySelector<HTMLElement>(".timeline")!.clientHeight);
  assert.ok(await portHeight() >= 120, `settled port ${await portHeight()}px below 120px`);

  // Keyboard focus of a prompt chip must not starve the scrollport. The chip
  // keeps its full ordered accessible name (index, total, bounded preview);
  // the visual preview adapts to the strip presentation (§2.3) here.
  const chip = page.locator(".prompt-nav-item").first();
  await chip.focus();
  await page.waitForTimeout(150);
  assert.match(
    (await chip.getAttribute("aria-label")) ?? "",
    /^Jump to prompt 1 of 6: /,
    "chip lost its ordered accessible name at 200%",
  );
  const withFocus = await portHeight();
  assert.ok(withFocus >= 120, `prompt focus reduced the port to ${withFocus}px`);
  const previewOverlap = await page.evaluate(() => {
    const preview = document.querySelector<HTMLElement>(".prompt-nav-preview");
    if (!preview) return false;
    const r = preview.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false; // no layout consumed
    const port = document.querySelector<HTMLElement>(".timeline")!.getBoundingClientRect();
    return r.top < port.bottom && r.bottom > port.top && r.left < port.right && r.right > port.left;
  });
  assert.equal(previewOverlap, false, "prompt preview paints over the scrollport at 200%");

  // Scrolling away mounts the reserved Jump to latest region: floor holds and
  // the control is visible, named, and center-hit-testable.
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); });
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    el.scrollTop = 0;
  });
  await page.waitForSelector(".timeline-reveal .jump-latest", { state: "visible", timeout: 5000 });
  const withReveal = await portHeight();
  assert.ok(withReveal >= 120, `latest reveal reduced the port to ${withReveal}px`);
  const jump = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".jump-latest")!;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    return { name: el.textContent?.trim() ?? "", selfHit: el === hit || el.contains(hit) };
  });
  assert.equal(jump.name, "Jump to latest", "reveal control lost its visible name at 200%");
  assert.ok(jump.selfHit, "Jump to latest center is covered at 200%");

  // Every reserved region at once: reveal mounted AND a chip focused.
  await chip.focus();
  await page.waitForTimeout(150);
  const withBoth = await portHeight();
  assert.ok(withBoth >= 120, `reveal + prompt focus reduced the port to ${withBoth}px`);
  await page.screenshot({ path: join(ARTIFACTS, "layout-rich-zoom200-reveal-focus.png") });

  // Keyboard activation still arrives and keeps focus off BODY at 200%.
  await page.locator(".jump-latest").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    return {
      distance: el.scrollHeight - el.scrollTop - el.clientHeight,
      activeTag: document.activeElement?.tagName ?? "NONE",
    };
  });
  assert.ok(after.distance <= 2, `Jump to latest stopped ${after.distance}px short at 200%`);
  assert.notEqual(after.activeTag, "BODY", "200% keyboard jump dropped focus to BODY");
  await closePage(lp);
});

// =============================================================================
// 7. Repair gate (verifier finding 3): a delayed canonical event load presents
//    as loading — the fresh-session hero must never flash over a populated
//    session, and the timeline appears only once replay has resolved.
// =============================================================================

test("initial replay: delayed events present as loading, never the fresh-session hero", async () => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addInitScript((seed: string) => {
    localStorage.setItem("polyth.prefs", seed);
  }, PERSONA_SEED);
  // Record ANY fresh-session hero appearance, however brief, from document
  // start (init scripts run before <html> exists, so the document itself is
  // observed). The registry's "Loading your projects…" hero is an HONEST
  // loading representation; the prohibited flash is the fresh-SESSION hero —
  // the start screen with the hero composer.
  await context.addInitScript(() => {
    (window as unknown as { __sawHero: boolean }).__sawHero = false;
    new MutationObserver(() => {
      const hero = document.querySelector(".hero");
      if (!hero) return;
      const freshSession = hero.querySelector(".composer-hero") !== null
        || /^What are we working on/.test(hero.querySelector("h2")?.textContent ?? "");
      if (freshSession) (window as unknown as { __sawHero: boolean }).__sawHero = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await context.route(`**/api/sessions/${SESSIONS.rich}/events*`, async (route) => {
    await sleep(2000);
    await route.continue();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${SESSIONS.rich}`, { waitUntil: "load" });

  // While the canonical load is unresolved: one honest loading row, no hero,
  // no phantom timeline or composer claiming a fresh session.
  await page.waitForSelector(".session-loading", { timeout: 15_000 });
  const during = await page.evaluate(() => ({
    loadingRole: document.querySelector(".session-loading")?.getAttribute("role") ?? "",
    hero: document.querySelector(".hero") !== null,
    msgs: document.querySelectorAll(".timeline .msg").length,
  }));
  assert.equal(during.loadingRole, "status", "loading row is not a status region");
  assert.equal(during.hero, false, "fresh-session hero rendered during replay");
  assert.equal(during.msgs, 0, "phantom rows rendered before replay resolved");

  // After replay resolves: the full timeline, loading gone, hero never seen.
  await page.waitForFunction(
    () => document.querySelectorAll(".timeline .msg").length >= 12,
    undefined, { timeout: 20_000 },
  );
  const after = await page.evaluate(() => ({
    sawHero: (window as unknown as { __sawHero: boolean }).__sawHero,
    loadingGone: document.querySelector(".session-loading") === null,
    utility: document.querySelector(".timeline-utility") !== null,
  }));
  assert.equal(after.sawHero, false, "fresh-session hero flashed at some point during replay");
  assert.ok(after.loadingGone, "loading row persisted after replay resolved");
  assert.ok(after.utility, "utilities missing after replay resolved");
  assert.deepEqual(errors, [], `uncaught page errors: ${errors.join(" | ")}`);
  await context.close();
  const i = contexts.indexOf(context);
  if (i >= 0) contexts.splice(i, 1);
});

// =============================================================================
// 8. Repair gate (verifier finding 4): reveal-control unmount hands focus to
//    the named timeline region; outside-press menu close restores the opener
//    while a press on another interactive control keeps its own focus.
// =============================================================================

test("reveal focus: keyboard Show all and final Show earlier hand focus to the timeline region", async () => {
  const totalRows = MANY_TURNS * 2;
  const expectRegionFocus = async (page: Page, label: string) => {
    const state = await page.evaluate(() => ({
      barGone: document.querySelector(".timeline-earlier") === null,
      activeTag: document.activeElement?.tagName ?? "NONE",
      activeName: document.activeElement?.getAttribute?.("aria-label") ?? "",
      activeIsRegion: document.activeElement?.classList.contains("timeline") ?? false,
      duplicates: (() => {
        const ids = Array.from(document.querySelectorAll<HTMLElement>(".timeline [data-msg-id]"))
          .map((n) => n.dataset.msgId ?? "");
        return ids.filter((id, i) => ids.indexOf(id) !== i);
      })(),
    }));
    assert.ok(state.barGone, `${label}: reveal bar persisted`);
    assert.notEqual(state.activeTag, "BODY", `${label}: focus dropped to BODY`);
    assert.ok(
      state.activeIsRegion && state.activeName === "Conversation timeline",
      `${label}: focus landed on ${state.activeTag} "${state.activeName}" instead of the named region`,
    );
    assert.deepEqual(state.duplicates, [], `${label}: reveal duplicated a row`);
  };

  const lp = await openApp({ width: 1280, height: 900, session: SESSIONS.many, ready: ".timeline-earlier" });
  const { page } = lp;
  await page.locator(".timeline-earlier button").nth(1).focus(); // Show all
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (n: number) => document.querySelectorAll(".timeline > .msg").length === n,
    totalRows, { timeout: 10_000 },
  );
  await expectRegionFocus(page, "Show all");

  // The final Show earlier chunk unmounts the bar too — same handoff.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".timeline-earlier", { timeout: 15_000 });
  await page.waitForTimeout(200);
  await page.locator(".timeline-earlier button").first().focus(); // Show earlier
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (n: number) => document.querySelectorAll(".timeline > .msg").length === n,
    totalRows, { timeout: 10_000 },
  );
  await expectRegionFocus(page, "final Show earlier");
  await closePage(lp);
});

test("narrow action menu: outside press restores the opener; interactive targets keep their own focus", async () => {
  const lp = await openApp({ width: 390, height: 844, session: SESSIONS.rich, ready: ".msg-actions-entry" });
  const { page } = lp;
  const opener = page.locator(".timeline > .msg.user .msg-actions-entry").first();

  const openMenu = async () => {
    await opener.scrollIntoViewIfNeeded();
    const box = (await opener.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector(".msg-actions-popup", { state: "visible", timeout: 5000 });
    await page.waitForTimeout(150);
  };

  // Outside press on inert transcript content: the menu closes and the OPENER
  // regains focus — matching Escape and action activation (UX-MSG-ACTIONS).
  await openMenu();
  const bubble = (await page.locator(".timeline > .msg.user .bubble").first().boundingBox())!;
  await page.mouse.click(bubble.x + 8, bubble.y + 8);
  await page.waitForFunction(() => document.querySelector(".msg-actions-popup") === null, undefined, { timeout: 5000 });
  await page.waitForTimeout(250); // the restore runs after the press's default focus handling
  const restored = await page.evaluate(() => ({
    tag: document.activeElement?.tagName ?? "NONE",
    name: document.activeElement?.getAttribute?.("aria-label") ?? "",
    isEntry: document.activeElement?.classList.contains("msg-actions-entry") ?? false,
  }));
  assert.ok(
    restored.isEntry && /^Actions for user message sent /.test(restored.name),
    `outside press left focus on ${restored.tag} "${restored.name}" instead of the opener`,
  );

  // A press on another interactive control (the composer textarea) closes the
  // menu and KEEPS that control's own focus — no steal, no composer trap.
  await openMenu();
  await page.click(".composer-input textarea");
  await page.waitForFunction(() => document.querySelector(".msg-actions-popup") === null, undefined, { timeout: 5000 });
  await page.waitForTimeout(250);
  const kept = await page.evaluate(() => document.activeElement?.tagName ?? "NONE");
  assert.equal(kept, "TEXTAREA", "outside press on the composer stole its focus back to the opener");
  await closePage(lp);
});
