// UX-MSG-ACTIONS live interaction gate. Drives a real Chromium against the
// isolated synthetic runtime (msgActionsFixtureSetup.mjs + the fake model
// backend) and asserts the spec's live acceptance items: reveal + traversal,
// purpose-and-target names, one copy announcement, ≥44px touch targets,
// revert/restore/replacement, fork success/failure/mismatch, semantic stable
// times, and single reasoning disclosure.
//
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --test apps/web/test/messageActions.live.ts
//
// Self-booting: builds the disposable fixture, builds apps/web/dist when
// missing, and starts an isolated Polyth server on port 4462 whose PATH
// resolves `opencode` to the synthetic fake. Override with POLYTH_LIVE_URL to
// point at an externally started fixture runtime instead.
//   POLYTH_CHROMIUM_PATH   Chromium executable (well-known paths otherwise)
//   POLYTH_LIVE_ARTIFACTS  directory for screenshots
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  FIXTURE_BIN, FIXTURE_DATA, FIXTURE_HOME, OC_SEED, OC_STATE, PROJECT_ID,
  REPO_ROOT, SESSIONS, TEXTS, buildMsgActionsFixture,
} from "./msgActionsFixtureSetup.mjs";

// ---- environment -----------------------------------------------------------

const SELF_BOOT = !process.env.POLYTH_LIVE_URL;
const BASE = (process.env.POLYTH_LIVE_URL ?? "http://127.0.0.1:4462").replace(/\/$/, "");
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? "/tmp/polyth-msgact-artifacts";

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
let targets: Record<string, number> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (SELF_BOOT) {
    ({ targets } = await buildMsgActionsFixture());
    if (!existsSync(join(REPO_ROOT, "apps/web/dist/index.html"))) {
      execFileSync(process.execPath, ["apps/web/build.ts"], { cwd: REPO_ROOT, stdio: "pipe" });
    }
    serverProc = spawn(process.execPath, ["packages/server/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: FIXTURE_HOME,
        XDG_CONFIG_HOME: join(FIXTURE_HOME, ".config"),
        XDG_DATA_HOME: join(FIXTURE_HOME, ".local/share"),
        OPENCODE_CONFIG_DIR: join(FIXTURE_HOME, "opencode"),
        POLYTH_DATA_DIR: FIXTURE_DATA,
        PORT: "4462",
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        MSGACT_OC_SEED: OC_SEED,
        MSGACT_OC_STATE: OC_STATE,
        POLYTH_FAKE_BROWSER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc.stdout?.resume();
    serverProc.stderr?.resume();
  } else {
    // External runtime: the revert/fork target seq is deterministic (u2 is
    // the 6th appended event of every two-turn session).
    targets = { copy: 6, revert: 6, fork: 6, forkFail: 6, forkMismatch: 6, queued: 6, revertActive: 6 };
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const health = await fetch(`${BASE}/api/health`).then((r) => r.json()) as { ok?: boolean };
      if (health.ok === true) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${BASE} did not become healthy`);
    await sleep(250);
  }
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
  if (serverProc && serverProc.exitCode === null) {
    const exited = new Promise<void>((resolve) => serverProc!.once("exit", () => resolve()));
    serverProc.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
    if (serverProc.exitCode === null) serverProc.kill("SIGKILL");
  }
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

async function openApp(opts: OpenOpts): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  if (opts.clipboard) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  }
  await context.addInitScript((seed: string) => {
    localStorage.setItem("polyth.prefs", seed);
  }, PERSONA_SEED);
  const page = await context.newPage();
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${opts.session}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(opts.ready ?? ".composer, .timeline", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(150);
  return page;
}

async function closePage(page: Page): Promise<void> {
  await page.context().close();
  const i = contexts.indexOf(page.context());
  if (i >= 0) contexts.splice(i, 1);
}

const fetchEvents = (sessionId: string): Promise<Array<{ seq: number; time: number; type: string; data: Record<string, unknown> }>> =>
  fetch(`${BASE}/api/sessions/${sessionId}/events?afterSeq=0`).then((r) => r.json()) as Promise<never>;

const sessionCount = async (): Promise<number> => {
  const rows = await fetch(`${BASE}/api/sessions?projectId=${PROJECT_ID}`).then((r) => r.json()) as unknown[];
  return rows.length;
};

const composerValue = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector<HTMLTextAreaElement>(".composer-input textarea")?.value ?? "");

const liveText = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector(".msg-live")?.textContent ?? "");

/** Playwright locator for the user message container whose bubble holds
 *  `text` (":text()" is a Playwright engine, not a CSS pseudo-class — inside
 *  page.evaluate the container is found by iterating instead). */
const userMsgSel = (text: string): string => `.timeline > .msg.user:has(.bubble :text("${text}"))`;

// =============================================================================
// 1+2. State matrix at 1280×900, 390×844, 320×844: truthful availability,
//      semantic times, one reasoning disclosure, touch entry presence.
// =============================================================================

test("state matrix: completed/failed/empty/active/waiting/queued/active-revert render truthfully at all three viewports", async () => {
  for (const [w, h] of [[1280, 900], [390, 844], [320, 844]] as const) {
    const desktop = w > 480;
    const ctxOf = (s: string) => `${s}@${w}x${h}`;

    // -- completed -----------------------------------------------------------
    {
      const page = await openApp({ width: w, height: h, session: SESSIONS.copy, ready: ".msg-meta" });
      const ctx = ctxOf("completed");
      const state = await page.evaluate(() => ({
        metas: document.querySelectorAll(".msg-meta").length,
        times: Array.from(document.querySelectorAll("time.msg-time")).map((t) => t.getAttribute("datetime") ?? ""),
        reasoning: document.querySelectorAll("details.reasoning").length,
        footer: document.querySelector(".turn-footer")?.textContent ?? "",
        entries: Array.from(document.querySelectorAll<HTMLElement>(".msg-actions-entry")).map((e) => {
          const r = e.getBoundingClientRect();
          return { w: r.width, h: r.height, visible: r.width > 0 };
        }),
        desktopRowDisplay: getComputedStyle(document.querySelector(".msg-actions")!).display,
      }));
      assert.ok(state.metas >= 4, `${ctx}: expected metas for 2 prompts + 2 answers, got ${state.metas}`);
      assert.ok(state.times.length >= 4, `${ctx}: missing semantic <time> elements`);
      for (const iso of state.times) {
        assert.ok(!Number.isNaN(Date.parse(iso)), `${ctx}: invalid dateTime "${iso}"`);
        assert.equal(new Date(iso).toISOString(), iso, `${ctx}: non-ISO dateTime "${iso}"`);
      }
      assert.equal(state.reasoning, 1, `${ctx}: reasoning must render exactly one disclosure`);
      assert.match(state.footer, /worked 20s/, `${ctx}: footer "${state.footer}" lacks the turn's own duration`);
      assert.match(state.footer, /420\s*in/, `${ctx}: footer "${state.footer}" lacks the turn's own usage`);
      if (desktop) {
        assert.notEqual(state.desktopRowDisplay, "none", `${ctx}: desktop action row missing`);
        assert.ok(state.entries.every((e) => !e.visible), `${ctx}: touch entry visible at desktop`);
      } else {
        assert.equal(state.desktopRowDisplay, "none", `${ctx}: hover-only row leaks into touch layout`);
        const visible = state.entries.filter((e) => e.visible);
        assert.ok(visible.length >= 4, `${ctx}: persistent touch entries missing`);
        for (const e of visible) {
          assert.ok(e.w >= 44 && e.h >= 44, `${ctx}: touch entry ${e.w}x${e.h} below 44px`);
        }
      }
      await closePage(page);
    }

    // -- failed: terminal error surfaced, actions available -------------------
    {
      const page = await openApp({ width: w, height: h, session: SESSIONS.failed, ready: ".turn-error" });
      const ctx = ctxOf("failed");
      const state = await page.evaluate(() => ({
        error: document.querySelector(".turn-error")?.textContent ?? "",
        revertDisabled: document.querySelector<HTMLButtonElement>('button[aria-label^="Revert and edit"]')?.disabled,
        menuEntry: document.querySelector(".msg-actions-entry") !== null,
      }));
      assert.match(state.error, /synthetic model failure/, `${ctx}: turn error missing`);
      assert.equal(state.revertDisabled, false, `${ctx}: revert must be available after a failed turn`);
      assert.ok(state.menuEntry, `${ctx}: named action entry missing`);
      await closePage(page);
    }

    // -- empty: no actions, composer usable -----------------------------------
    {
      const page = await openApp({ width: w, height: h, session: SESSIONS.empty, ready: ".composer-input textarea" });
      const ctx = ctxOf("empty");
      const state = await page.evaluate(() => ({
        metas: document.querySelectorAll(".msg-meta").length,
        composer: document.querySelector(".composer-input textarea") !== null,
      }));
      assert.equal(state.metas, 0, `${ctx}: action meta rendered without messages`);
      assert.ok(state.composer, `${ctx}: composer missing`);
      await closePage(page);
    }

    // -- active turn: disabled with the running-turn reason -------------------
    {
      const page = await openApp({ width: w, height: h, session: SESSIONS.active, ready: ".msg.user" });
      const ctx = ctxOf("active");
      const btn = await page.evaluate(() => {
        const b = document.querySelector<HTMLButtonElement>('button[aria-label^="Revert and edit"]');
        return b ? { disabled: b.disabled, title: b.title } : null;
      });
      assert.ok(btn, `${ctx}: revert control missing`);
      assert.equal(btn.disabled, true, `${ctx}: revert enabled during an active turn`);
      assert.match(btn.title, /while a turn is running/, `${ctx}: reason "${btn.title}" is not truthful`);
      await closePage(page);
    }

    // -- waiting: pending question blocks mutations ----------------------------
    {
      const page = await openApp({ width: w, height: h, session: SESSIONS.waiting, ready: ".question-card" });
      const ctx = ctxOf("waiting");
      const btn = await page.evaluate(() => {
        const b = document.querySelector<HTMLButtonElement>('button[aria-label^="Fork and edit"]');
        return b ? { disabled: b.disabled, title: b.title } : null;
      });
      assert.ok(btn, `${ctx}: fork control missing`);
      assert.equal(btn.disabled, true, `${ctx}: fork enabled while a request is waiting`);
      assert.match(btn.title, /while a request is waiting/, `${ctx}: reason "${btn.title}" is not truthful`);
      await closePage(page);
    }

    // -- queued: a durable queued delivery behind a live turn blocks mutations.
    // (Queued-and-idle is transient by design: an idle session's queue
    // dispatches on subscribe, so the truthful durable state holds both.)
    {
      const queueUrl = `${BASE}/api/sessions/${SESSIONS.queued}/queue`;
      const queued = await fetch(queueUrl).then((r) => r.json()) as unknown[];
      if (queued.length === 0) {
        // One hanging turn (the fake never completes it), then one queued send.
        const sendUrl = `${BASE}/api/sessions/${SESSIONS.queued}/message`;
        const post = (body: unknown) => fetch(sendUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.equal((await post({ text: "Hanging synthetic analysis" })).status, 200);
        const queuedRes = await post({ text: "Queued synthetic follow-up", delivery: "queue" });
        assert.equal(queuedRes.status, 200);
        assert.equal(((await queuedRes.json()) as { queued?: boolean }).queued, true, "follow-up was not queued");
      }
      const page = await openApp({ width: w, height: h, session: SESSIONS.queued, ready: ".msg-meta" });
      const ctx = ctxOf("queued");
      await page.waitForSelector(".queue-list .queue-chip", { state: "visible", timeout: 15_000 });
      await page.waitForFunction(
        () => document.querySelector<HTMLButtonElement>('button[aria-label^="Revert and edit"]')?.disabled === true,
        undefined, { timeout: 15_000 },
      );
      const state = await page.evaluate(() => ({
        title: document.querySelector<HTMLButtonElement>('button[aria-label^="Revert and edit"]')?.title ?? "",
        chip: document.querySelector(".queue-chip .queue-text")?.textContent ?? "",
      }));
      assert.match(
        state.title,
        /while (a turn is running|messages are queued)/,
        `${ctx}: reason "${state.title}" is not truthful`,
      );
      assert.equal(state.chip, "Queued synthetic follow-up", `${ctx}: queued delivery not listed`);
      await closePage(page);
    }

    // -- active revert: collapsed tail + replay-derived draft ------------------
    {
      const page = await openApp({ width: w, height: h, session: SESSIONS.revertActive, ready: ".rewound-tail" });
      const ctx = ctxOf("active-revert");
      const state = await page.evaluate(() => ({
        summary: document.querySelector(".rewound-tail summary")?.textContent ?? "",
        restore: document.querySelector(".rewound-tail summary button") !== null,
        revert: (() => {
          const b = document.querySelector<HTMLButtonElement>('button[aria-label^="Revert and edit"]');
          return b ? { disabled: b.disabled, title: b.title } : null;
        })(),
      }));
      assert.match(state.summary, /reverted timeline items/, `${ctx}: tail summary "${state.summary}"`);
      assert.ok(state.restore, `${ctx}: restore action missing`);
      assert.ok(state.revert, `${ctx}: remaining prompt lost its revert control`);
      assert.equal(state.revert.disabled, true, `${ctx}: a second revert must be blocked while one is active`);
      assert.match(state.revert.title, /Restore or replace/, `${ctx}: reason "${state.revert.title}"`);
      assert.equal(await composerValue(page), TEXTS.u2, `${ctx}: replay did not derive the draft from the target prompt`);
      if (w === 1280) await page.screenshot({ path: join(ARTIFACTS, "active-revert-1280.png") });
      await closePage(page);
    }
  }
});

// =============================================================================
// 1. Hover + keyboard focus reveal; Tab/Shift+Tab traverse without trapping.
// =============================================================================

test("desktop reveal: hover and focus-within show actions; Tab reaches the composer and returns", async () => {
  const page = await openApp({ width: 1280, height: 900, session: SESSIONS.copy, ready: ".msg-meta" });

  // Hidden by default: no pointer hit area, still focusable.
  const before = await page.evaluate(() => {
    const row = document.querySelector(".msg-actions")!;
    const cs = getComputedStyle(row);
    return { opacity: cs.opacity, pointer: cs.pointerEvents };
  });
  assert.equal(before.opacity, "0", "actions visible without hover/focus");
  assert.equal(before.pointer, "none", "hidden actions keep a pointer hit area");

  // Hover the second prompt reveals its row.
  await page.hover(userMsgSel(TEXTS.u2));
  await page.waitForFunction((text: string) => {
    const msg = Array.from(document.querySelectorAll(".timeline > .msg.user"))
      .find((m) => m.querySelector(".bubble")?.textContent?.includes(text));
    const row = msg?.querySelector(".msg-actions");
    return row != null && getComputedStyle(row).opacity === "1";
  }, TEXTS.u2, { timeout: 5000 });

  // Keyboard focus reveals it too (focus-within), no hover needed.
  await page.mouse.move(5, 5);
  const revealed = await page.evaluate((text: string) => {
    const msg = Array.from(document.querySelectorAll(".timeline > .msg.user"))
      .find((m) => m.querySelector(".bubble")?.textContent?.includes(text))!;
    msg.querySelector<HTMLButtonElement>(".msg-actions button")?.focus();
    return getComputedStyle(msg.querySelector(".msg-actions")!).opacity;
  }, TEXTS.u2);
  assert.equal(revealed, "1", "keyboard focus does not reveal the action row");

  // Tab forward from the timeline must reach the composer without trapping…
  let reachedComposer = false;
  for (let i = 0; i < 60 && !reachedComposer; i++) {
    await page.keyboard.press("Tab");
    reachedComposer = await page.evaluate(() =>
      document.activeElement?.closest(".composer, .composer-input") !== null
      && document.activeElement?.tagName === "TEXTAREA");
  }
  assert.ok(reachedComposer, "Tab from the timeline never reaches the composer");

  // …and Shift+Tab returns into the timeline.
  let backInTimeline = false;
  for (let i = 0; i < 60 && !backInTimeline; i++) {
    await page.keyboard.press("Shift+Tab");
    backInTimeline = await page.evaluate(() =>
      document.querySelector(".timeline")?.contains(document.activeElement) === true);
  }
  assert.ok(backInTimeline, "Shift+Tab from the composer never returns to the timeline");
  await closePage(page);
});

// =============================================================================
// 2. Purpose-and-target names, one copy announcement, retained focus,
//    reasoning toggle with pointer/Enter/Space. 6. Times stable across reload.
// =============================================================================

test("names, copy announcements, focus retention, reasoning disclosure, stable times", async () => {
  const page = await openApp({ width: 1280, height: 900, session: SESSIONS.copy, ready: ".msg-meta", clipboard: true });

  // Purpose-and-target accessible names.
  const names = await page.evaluate((text: string) => {
    const scope = Array.from(document.querySelectorAll(".timeline > .msg.user"))
      .find((m) => m.querySelector(".bubble")?.textContent?.includes(text))!;
    return {
      revert: scope.querySelector('button[aria-label^="Revert and edit"]')?.getAttribute("aria-label") ?? "",
      fork: scope.querySelector('button[aria-label^="Fork and edit"]')?.getAttribute("aria-label") ?? "",
      copy: scope.querySelector('button[aria-label^="Copy user message as Markdown"]') !== null,
      copyCount: scope.querySelectorAll('.msg-actions button[aria-label^="Copy user message"]').length,
      menu: scope.querySelector(".msg-actions-entry")?.getAttribute("aria-label") ?? "",
      time: scope.querySelector("time.msg-time")?.getAttribute("aria-label") ?? "",
    };
  }, TEXTS.u2);
  assert.match(names.revert, /^Revert and edit user message sent .+\d/, `revert name: "${names.revert}"`);
  assert.match(names.fork, /^Fork and edit from user message sent .+\d/, `fork name: "${names.fork}"`);
  assert.ok(names.copy, "unified copy action lacks its selected format name");
  assert.equal(names.copyCount, 1, "message renders more than one copy action");
  assert.match(names.menu, /^Actions for user message sent .+\d/, `menu name: "${names.menu}"`);
  assert.match(names.time, /^Sent .+\d/, `time name: "${names.time}"`);
  const assistantNames = await page.evaluate(() => {
    const metas = Array.from(document.querySelectorAll(".msg.assistant .msg-meta"));
    const last = metas[metas.length - 1];
    return {
      copy: last?.querySelector('button[aria-label="Copy assistant answer as Markdown"]') !== null,
      copyCount: last?.querySelectorAll('.msg-actions button[aria-label^="Copy assistant answer"]').length ?? 0,
      time: last?.querySelector("time.msg-time")?.getAttribute("aria-label") ?? "",
    };
  });
  assert.ok(assistantNames.copy, "assistant copy action lacks a target name");
  assert.equal(assistantNames.copyCount, 1, "assistant renders more than one copy action");
  assert.match(assistantNames.time, /^Completed .+\d/, `assistant time name: "${assistantNames.time}"`);

  // Copy as Markdown: exact text, one announcement, focus retained.
  await page.hover(userMsgSel(TEXTS.u2));
  await page.click(`${userMsgSel(TEXTS.u2)} button[aria-label^="Copy user message as Markdown"]`);
  await page.waitForFunction(() => (document.querySelector(".msg-live")?.textContent ?? "") !== "", undefined, { timeout: 5000 });
  assert.equal(await liveText(page), "Message copied as Markdown", "wrong or missing copy announcement");
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    TEXTS.u2,
    "markdown copy is not the exact projected message text",
  );
  const focusRetained = await page.evaluate((text: string) => {
    const scope = Array.from(document.querySelectorAll(".timeline > .msg.user"))
      .find((m) => m.querySelector(".bubble")?.textContent?.includes(text))!;
    return document.activeElement === scope.querySelector('button[aria-label^="Copy user message as Markdown"]');
  }, TEXTS.u2);
  assert.ok(focusRetained, "copy moved focus away from the invoking control");

  // Copy assistant answer as JSON: stable payload, no internal fields.
  await page.evaluate(() => {
    const metas = Array.from(document.querySelectorAll<HTMLButtonElement>('.msg.assistant button[aria-label="Copy assistant answer as JSON"]'));
    metas[metas.length - 1]!.click();
  });
  await page.waitForFunction(() => (document.querySelector(".msg-live")?.textContent ?? "").includes("JSON"), undefined, { timeout: 5000 });
  assert.equal(await liveText(page), "Message copied as JSON");
  const payload = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as Record<string, unknown>;
  assert.equal(payload.role, "assistant");
  assert.equal(payload.text, TEXTS.a2);
  assert.equal(payload.reasoning, TEXTS.reasoning, "disclosed reasoning missing from the JSON copy");
  assert.equal(new Date(String(payload.time)).getTime(), payload.timeMs, "ISO time and epoch disagree");
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["reasoning", "role", "text", "time", "timeMs"],
    "JSON copy carries unexpected fields",
  );
  assert.ok(!JSON.stringify(payload).includes("oc_"), "backend identifiers leaked into the copy payload");

  // Reasoning disclosure: pointer, Enter, Space; truthful expanded state.
  const summary = page.locator("details.reasoning summary");
  const expanded = () => summary.getAttribute("aria-expanded");
  const initially = await expanded();
  await summary.click();
  assert.notEqual(await expanded(), initially, "pointer toggle did not flip the disclosure");
  await summary.focus();
  await page.keyboard.press("Enter");
  assert.equal(await expanded(), initially, "Enter did not toggle the disclosure");
  await page.keyboard.press(" ");
  assert.notEqual(await expanded(), initially, "Space did not toggle the disclosure");
  // Leave it open, copy the reasoning.
  if ((await expanded()) !== "true") await summary.click();
  await page.click('button[aria-label="Copy reasoning for assistant answer"]');
  await page.waitForFunction(() => (document.querySelector(".msg-live")?.textContent ?? "").includes("Reasoning"), undefined, { timeout: 5000 });
  assert.equal(await liveText(page), "Reasoning copied");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), TEXTS.reasoning);

  // Times are semantic and stable across a full reload.
  const timesBefore = await page.evaluate(() =>
    Array.from(document.querySelectorAll("time.msg-time")).map((t) => t.getAttribute("datetime")));
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".msg-meta", { state: "visible", timeout: 15_000 });
  const timesAfter = await page.evaluate(() =>
    Array.from(document.querySelectorAll("time.msg-time")).map((t) => t.getAttribute("datetime")));
  assert.deepEqual(timesAfter, timesBefore, "reload changed rendered message times");

  await page.screenshot({ path: join(ARTIFACTS, "copy-reasoning-1280.png") });
  await closePage(page);
});

// =============================================================================
// 3. Touch entries and menu rows ≥44×44, unforced center taps, in-scrollport.
// =============================================================================

test("touch: 44px entries and menu rows, center taps hit the intended control, menu inside the scrollport", async () => {
  for (const [w, h] of [[390, 844], [320, 844]] as const) {
    const page = await openApp({ width: w, height: h, session: SESSIONS.copy, ready: ".msg-actions-entry" });
    const ctx = `touch@${w}x${h}`;

    // Every persistent entry is ≥44×44; centers INSIDE the visible scrollport
    // must hit their own control (entries scrolled out of the timeline's
    // overflow are legitimately unreachable until scrolled to).
    const entries = await page.evaluate(() => {
      const port = document.querySelector(".timeline")!.getBoundingClientRect();
      const top = Math.max(port.top, 0);
      const bottom = Math.min(port.bottom, innerHeight);
      return Array.from(document.querySelectorAll<HTMLElement>(".msg-actions-entry")).map((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
          w: r.width, h: r.height, name: el.getAttribute("aria-label") ?? "",
          inScrollport: r.top >= top && r.bottom <= bottom && r.left >= 0 && r.right <= innerWidth,
          selfHit: el === hit || el.contains(hit),
          hitDesc: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : "none",
        };
      }).filter((e) => e.w > 0);
    });
    assert.ok(entries.length >= 4, `${ctx}: touch entries missing`);
    assert.ok(entries.some((e) => e.inScrollport), `${ctx}: no touch entry inside the scrollport`);
    for (const e of entries) {
      assert.ok(e.w >= 44 && e.h >= 44, `${ctx}: entry ${e.w}x${e.h} below 44px`);
      if (e.inScrollport) {
        assert.ok(e.selfHit, `${ctx}: center of "${e.name}" is covered by ${e.hitDesc}`);
      }
    }

    // Open the menu of the last user prompt with an unforced center tap.
    const opener = page.locator(`${userMsgSel(TEXTS.u2)} .msg-actions-entry`);
    await opener.scrollIntoViewIfNeeded();
    const box = (await opener.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector(".msg-actions-popup", { state: "visible", timeout: 5000 });
    // The reveal region can mount right after the open scroll and shrink the
    // scrollport; the menu re-caps itself to the live port, so let it settle.
    await page.waitForTimeout(150);

    // UX-TIMELINE-LAYOUT-01 §2.5: the menu is bounded NORMAL-FLOW content —
    // the whole popup stays inside the visible scrollport and never covers
    // the message body it belongs to. When every ≥44px row cannot fit at
    // once, the menu scrolls internally and every row stays fully reachable.
    const menu = await page.evaluate((text: string) => {
      const popup = document.querySelector<HTMLElement>(".msg-actions-popup")!;
      const pr = popup.getBoundingClientRect();
      const port = document.querySelector(".timeline")!.getBoundingClientRect();
      const top = Math.max(port.top, 0);
      const bottom = Math.min(port.bottom, innerHeight);
      const msg = Array.from(document.querySelectorAll(".timeline > .msg.user"))
        .find((el) => el.querySelector(".bubble")?.textContent?.includes(text))!;
      const body = msg.querySelector(".bubble")!.getBoundingClientRect();
      const rows = Array.from(popup.querySelectorAll<HTMLElement>(".msg-actions-item")).map((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, name: el.getAttribute("aria-label") ?? "" };
      });
      return {
        rows,
        normalFlow: getComputedStyle(popup).position === "static",
        coversOwnBody: pr.top < body.bottom && pr.bottom > body.top
          && pr.left < body.right && pr.right > body.left,
        // 1px tolerance: scrollIntoView(nearest) can settle on a half pixel.
        inScrollport: pr.top >= top - 1 && pr.bottom <= bottom + 1 && pr.left >= -1 && pr.right <= innerWidth + 1,
      };
    }, TEXTS.u2);
    assert.ok(menu.inScrollport, `${ctx}: menu escapes the visible scrollport`);
    assert.ok(menu.normalFlow, `${ctx}: menu is not normal-flow content`);
    assert.ok(!menu.coversOwnBody, `${ctx}: menu covers the message body it belongs to`);
    assert.ok(menu.rows.length >= 3, `${ctx}: menu rows missing`);
    for (const row of menu.rows) {
      assert.ok(row.w >= 44 && row.h >= 44, `${ctx}: menu row "${row.name}" is ${row.w}x${row.h}`);
      assert.ok(row.name.length > 0, `${ctx}: menu row without an accessible name`);
    }
    // Every row is fully reachable: after revealing it inside the bounded
    // menu (internal scroll when needed), its unforced center hits itself.
    for (let i = 0; i < menu.rows.length; i++) {
      const reach = await page.evaluate((idx: number) => {
        const el = document.querySelectorAll<HTMLElement>(".msg-actions-popup .msg-actions-item")[idx]!;
        el.scrollIntoView({ block: "nearest" });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          selfHit: el === hit || el.contains(hit),
          hitDesc: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : "none",
        };
      }, i);
      assert.ok(reach.selfHit, `${ctx}: center of "${menu.rows[i]!.name}" is covered by ${reach.hitDesc}`);
    }

    // An unforced center tap on the Markdown row announces exactly one result.
    const mdRow = page.locator('.msg-actions-popup button[aria-label^="Copy user message as Markdown"]');
    await mdRow.scrollIntoViewIfNeeded();
    const mdBox = (await mdRow.boundingBox())!;
    await page.mouse.click(mdBox.x + mdBox.width / 2, mdBox.y + mdBox.height / 2);
    await page.waitForFunction(() => (document.querySelector(".msg-live")?.textContent ?? "") !== "", undefined, { timeout: 5000 });
    const announced = await liveText(page);
    assert.ok(
      announced === "Message copied as Markdown" || announced === "Couldn’t copy message",
      `${ctx}: unexpected announcement "${announced}"`,
    );
    const menuClosed = await page.evaluate(() => document.querySelector(".msg-actions-popup") === null);
    assert.ok(menuClosed, `${ctx}: menu stayed open after the action ran`);
    if (w === 390) await page.screenshot({ path: join(ARTIFACTS, "touch-menu-390.png") });
    await closePage(page);
  }
});

// =============================================================================
// 4. Revert → reload → Restore → Revert again → edit → replacement; focus
//    never lands on BODY; copy of a visible message excludes the hidden tail.
// =============================================================================

test("revert flow: hide, reload, restore, revert again, edit, replacement send", async () => {
  const page = await openApp({ width: 1280, height: 900, session: SESSIONS.revert, ready: ".msg-meta", clipboard: true });
  const eventsBefore = await fetchEvents(SESSIONS.revert);

  // Revert the second prompt.
  await page.hover(userMsgSel(TEXTS.u2));
  await page.click(`${userMsgSel(TEXTS.u2)} button[aria-label^="Revert and edit"]`);
  await page.waitForSelector(".rewound-tail", { state: "visible", timeout: 10_000 });

  // Marker is append-only, atSeq-only (no prompt copy), tail hidden, draft set.
  const afterRevert = await fetchEvents(SESSIONS.revert);
  assert.equal(afterRevert.length, eventsBefore.length + 1, "revert appended more than one marker");
  const marker = afterRevert[afterRevert.length - 1]!;
  assert.equal(marker.type, "session/rewound");
  assert.deepEqual(marker.data, { atSeq: targets.revert }, "marker must carry only atSeq");
  assert.equal(await composerValue(page), TEXTS.u2, "draft is not the exact reverted prompt");
  const hiddenInMain = await page.evaluate((needle: string) => {
    const main = Array.from(document.querySelectorAll(".timeline > .msg"));
    return main.some((m) => m.textContent?.includes(needle));
  }, TEXTS.a2);
  assert.ok(!hiddenInMain, "reverted answer still rendered in the visible flow");

  // Copy of a VISIBLE message never includes the hidden tail.
  await page.hover(".msg.assistant");
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('.timeline > .msg.assistant button[aria-label="Copy assistant answer as JSON"]')?.click();
  });
  await page.waitForFunction(() => (document.querySelector(".msg-live")?.textContent ?? "").includes("JSON"), undefined, { timeout: 5000 });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes(TEXTS.a1), "copy lost the visible answer");
  assert.ok(!copied.includes(TEXTS.u2) && !copied.includes(TEXTS.a2), "copy leaked the hidden reverted tail");

  // Reload replays the same state.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".rewound-tail", { state: "visible", timeout: 15_000 });
  assert.equal(await composerValue(page), TEXTS.u2, "reload lost the derived draft");

  // Restore with the untouched seed: silent, focus never on BODY.
  await page.click(".rewound-tail summary button");
  await page.waitForSelector(".rewound-tail", { state: "detached", timeout: 10_000 });
  const focusAfterRestore = await page.evaluate(() => document.activeElement?.tagName ?? "BODY");
  assert.notEqual(focusAfterRestore, "BODY", "restore dropped focus on BODY");
  assert.equal(await composerValue(page), "", "restore kept the seeded draft");
  const afterRestore = await fetchEvents(SESSIONS.revert);
  assert.equal(afterRestore[afterRestore.length - 1]!.type, "session/rewind-cleared");
  const visibleAgain = await page.evaluate((needle: string) =>
    Array.from(document.querySelectorAll(".timeline > .msg")).some((m) => m.textContent?.includes(needle)), TEXTS.u2);
  assert.ok(visibleAgain, "restore did not bring the original timeline back");

  // Revert again, edit the draft: Restore now demands confirmation.
  await page.hover(userMsgSel(TEXTS.u2));
  await page.click(`${userMsgSel(TEXTS.u2)} button[aria-label^="Revert and edit"]`);
  await page.waitForSelector(".rewound-tail", { state: "visible", timeout: 10_000 });
  const edited = "Second synthetic prompt, edited: explain the helper with an example.";
  await page.fill(".composer-input textarea", edited);
  await page.waitForTimeout(400); // draft autosave debounce
  await page.click(".rewound-tail summary button");
  await page.waitForSelector(".rewound-confirm", { state: "visible", timeout: 5000 });
  await page.click('.rewound-confirm button:text-is("Keep editing the draft")');
  assert.equal(await composerValue(page), edited, "keep-editing discarded the edited draft");

  // Replacement send: branch-first backend swap, then exactly one new prompt.
  await page.click(".send");
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll(".timeline > .msg.assistant")).some((m) => m.textContent?.includes("Synthetic reply")),
    undefined, { timeout: 20_000 },
  );
  const tailGone = await page.evaluate(() => document.querySelector(".rewound-tail") === null);
  assert.ok(tailGone, "replacement left the reverted tail visible");
  const finalEvents = await fetchEvents(SESSIONS.revert);
  const cleared = finalEvents.filter((e) => e.type === "session/rewind-cleared");
  assert.equal(cleared[cleared.length - 1]!.data.replaced, true, "replacement must clear the marker with replaced:true");
  const editedPrompts = finalEvents.filter((e) => e.type === "user/message" && e.data.text === edited);
  assert.equal(editedPrompts.length, 1, "replacement created a duplicate prompt");
  // Hidden originals remain on disk, but never in the visible flow.
  assert.ok(finalEvents.some((e) => e.seq === targets.revert && e.data.text === TEXTS.u2), "original prompt vanished from the log");
  const u2StillHidden = await page.evaluate((needle: string) =>
    !Array.from(document.querySelectorAll(".timeline > .msg")).some((m) => m.textContent?.includes(needle)), TEXTS.u2);
  assert.ok(u2StillHidden, "replaced prompt re-entered the visible timeline");
  // The backend branched (never reset into an empty session).
  const ocState = JSON.parse(await readFile(OC_STATE, "utf8")) as {
    forks: Array<{ source: string; child: string }>;
    prompts: Array<{ sessionID: string; text: string }>;
  };
  const branch = ocState.forks.find((f) => f.source === "oc_revert");
  assert.ok(branch, "replacement did not branch the backend history");
  assert.deepEqual(
    ocState.prompts.filter((p) => p.sessionID === branch.child).map((p) => p.text),
    [edited],
    "backend branch did not receive exactly the edited prompt",
  );

  await page.screenshot({ path: join(ARTIFACTS, "revert-replacement-1280.png") });
  await closePage(page);
});

// =============================================================================
// 5. Fork selects the child only after success, seeds the excluded prompt,
//    survives canonical URL reload, sends the seed exactly once, and keeps
//    copied event times. 6 (fork half). 
// =============================================================================

test("fork flow: child selected after success, seeded draft, stable copied times, single send", async () => {
  const page = await openApp({ width: 1280, height: 900, session: SESSIONS.fork, ready: ".msg-meta" });
  const sourceEvents = await fetchEvents(SESSIONS.fork);
  const sourceU1Time = sourceEvents.find((e) => e.type === "user/message" && e.data.text === TEXTS.u1)!.time;

  await page.hover(userMsgSel(TEXTS.u2));
  await page.click(`${userMsgSel(TEXTS.u2)} button[aria-label^="Fork and edit"]`);
  await page.waitForFunction(
    (source: string) => location.pathname.includes("/s/") && !location.pathname.endsWith(`/s/${source}`),
    SESSIONS.fork, { timeout: 15_000 },
  );
  const childId = await page.evaluate(() => location.pathname.split("/s/")[1] ?? "");
  assert.ok(childId.length > 0, "no child session in the URL");

  // The excluded prompt is the child's editable draft; the child shows only
  // turn one; the source log is untouched.
  await page.waitForFunction(
    (text: string) => (document.querySelector<HTMLTextAreaElement>(".composer-input textarea")?.value ?? "") === text,
    TEXTS.u2, { timeout: 10_000 },
  );
  const childView = await page.evaluate((needles: string[]) => ({
    hasU1: document.body.textContent?.includes(needles[0]!) === true,
    hasA1: document.body.textContent?.includes(needles[1]!) === true,
    hasA2: document.body.textContent?.includes(needles[2]!) === true,
    userMsgs: document.querySelectorAll(".timeline > .msg.user").length,
  }), [TEXTS.u1, TEXTS.a1, TEXTS.a2]);
  assert.ok(childView.hasU1 && childView.hasA1, "child lost the copied prefix");
  assert.ok(!childView.hasA2, "child leaked content from after the fork point");
  assert.equal(childView.userMsgs, 1, "child must contain exactly the first prompt");
  assert.deepEqual(await fetchEvents(SESSIONS.fork), sourceEvents, "fork mutated the source log");

  // Child log: copied prefix keeps source times; one ignorable lineage marker
  // owns the draft; the second prompt was NOT copied.
  const childEvents = await fetchEvents(childId);
  const childU1 = childEvents.find((e) => e.type === "user/message" && e.data.text === TEXTS.u1);
  assert.ok(childU1, "child log lost the copied prompt");
  assert.equal(childU1.time, sourceU1Time, "copied event time changed in the fork");
  assert.ok(!childEvents.some((e) => e.type === "user/message" && e.data.text === TEXTS.u2), "excluded prompt was copied into the child");
  const markers = childEvents.filter((e) => e.type === "session/forked");
  assert.equal(markers.length, 1, "child must carry exactly one lineage marker");
  assert.equal(markers[0]!.data.fromSessionId, SESSIONS.fork);
  assert.equal(markers[0]!.data.sourceAtSeq, targets.fork);
  assert.deepEqual(markers[0]!.data.draft, { text: TEXTS.u2 }, "marker draft is not the excluded prompt");

  // Rendered times in the child equal the source's for the same message.
  const childTimeIso = await page.evaluate(() =>
    document.querySelector(".timeline > .msg.user time.msg-time")?.getAttribute("datetime") ?? "");
  assert.equal(childTimeIso, new Date(sourceU1Time).toISOString(), "rendered child time differs from the source");

  // Direct canonical URL reload restores the same state.
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${childId}`, { waitUntil: "load" });
  await page.waitForSelector(".msg-meta", { state: "visible", timeout: 15_000 });
  assert.equal(await composerValue(page), TEXTS.u2, "reload lost the seeded draft");

  // Send the unchanged seed: exactly one second prompt, exactly one delivery.
  await page.click(".send");
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll(".timeline > .msg.assistant")).some((m) => m.textContent?.includes("Synthetic reply")),
    undefined, { timeout: 20_000 },
  );
  const afterSend = await fetchEvents(childId);
  const seedPrompts = afterSend.filter((e) => e.type === "user/message" && e.data.text === TEXTS.u2);
  assert.equal(seedPrompts.length, 1, "the seeded prompt was sent more than once");
  const ocState = JSON.parse(await readFile(OC_STATE, "utf8")) as {
    forks: Array<{ source: string; child: string }>;
    prompts: Array<{ sessionID: string; text: string }>;
  };
  const branch = ocState.forks.find((f) => f.source === "oc_fork");
  assert.ok(branch, "backend never forked the source history");
  assert.deepEqual(
    ocState.prompts.filter((p) => p.sessionID === branch.child).map((p) => p.text),
    [TEXTS.u2],
    "backend child did not receive exactly one seed prompt",
  );

  await page.screenshot({ path: join(ARTIFACTS, "fork-child-1280.png") });
  await closePage(page);
});

// =============================================================================
// 7. Disclosed fork 500 and forced history mismatch: source stays selected,
//    no canonical event, bounded actionable error.
// =============================================================================

test("fork failure and backend mismatch keep the source selected with no canonical change", async () => {
  for (const [session, expectMessage] of [
    [SESSIONS.forkFail, /Couldn’t fork:/],
    [SESSIONS.forkMismatch, /^Fork failed: the backend history didn’t match this session’s events\. Nothing was changed\.$/],
  ] as const) {
    const page = await openApp({ width: 1280, height: 900, session, ready: ".msg-meta" });
    const eventsBefore = await fetchEvents(session);
    const countBefore = await sessionCount();

    await page.hover(userMsgSel(TEXTS.u2));
    await page.click(`${userMsgSel(TEXTS.u2)} button[aria-label^="Fork and edit"]`);
    await page.waitForFunction(() => (document.querySelector(".msg-live")?.textContent ?? "") !== "", undefined, { timeout: 15_000 });

    const announced = await liveText(page);
    assert.match(announced, expectMessage, `${session}: unexpected error "${announced}"`);
    assert.ok(announced.length < 600, `${session}: error is unbounded (${announced.length} chars)`);
    assert.ok(
      await page.evaluate((s: string) => location.pathname.endsWith(`/s/${s}`), session),
      `${session}: a failed fork changed the selected session`,
    );
    assert.deepEqual(await fetchEvents(session), eventsBefore, `${session}: failed fork appended canonical events`);
    assert.equal(await sessionCount(), countBefore, `${session}: failed fork created a session`);
    assert.equal(await composerValue(page), "", `${session}: failed fork changed the draft`);
    await closePage(page);
  }

  // The mismatch orphan was deleted on the backend; the failed fork made none.
  const ocState = JSON.parse(await readFile(OC_STATE, "utf8")) as {
    forks: Array<{ source: string; child: string }>;
    deleted: string[];
  };
  const orphan = ocState.forks.find((f) => f.source === "oc_mismatch");
  assert.ok(orphan, "mismatch scenario never reached the backend fork");
  assert.ok(ocState.deleted.includes(orphan.child), "the mismatched orphan child was not discarded");
  assert.ok(!ocState.forks.some((f) => f.source === "oc_forkfail"), "a 500 fork should fail before any child exists");
});
