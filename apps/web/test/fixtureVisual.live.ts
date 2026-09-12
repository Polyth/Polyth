// UX-FIXTURE-VISUAL live repair gate. Drives a real Chromium against the
// disposable UX audit fixture (docs/ux-audit/FIXTURE-SPEC.md) and asserts the
// repaired behavior for every finding in docs/ux-audit/FIXTURE-VISUAL.md.
//
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --test apps/web/test/fixtureVisual.live.ts
//
// Requirements: the fixture runtime from FIXTURE-SPEC.md must be running and
// serving the current apps/web/dist bundle. Ids, paths, and the port are
// deterministic per the spec, so everything defaults; override with:
//   POLYTH_FIXTURE_URL        (default http://127.0.0.1:4418)
//   POLYTH_FIXTURE_ROOT       (default /tmp/polyth-ux-fixture-58a2)
//   POLYTH_FIXTURE_WORKTREE   (default /tmp/polyth-ux-fixture-worktree-58a2)
//   POLYTH_CHROMIUM_PATH      Chromium executable (well-known paths otherwise)
//   POLYTH_LIVE_ARTIFACTS     directory for screenshots
//
// Safety: read-only against the fixture except (a) one probe file written and
// deleted through /api/files with the worktree session, and (b) loop rescans +
// one dismiss/undismiss cycle, which the final explicit rescan restores. No
// question or permission is answered; no session status is changed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

// ---- environment -----------------------------------------------------------

const BASE = (process.env.POLYTH_FIXTURE_URL ?? "http://127.0.0.1:4418").replace(/\/$/, "");
const FIXTURE_ROOT = process.env.POLYTH_FIXTURE_ROOT ?? "/tmp/polyth-ux-fixture-58a2";
const WORKTREE_ROOT = process.env.POLYTH_FIXTURE_WORKTREE ?? "/tmp/polyth-ux-fixture-worktree-58a2";
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? "/tmp/polyth-fixture-visual-artifacts";

// Deterministic ids from FIXTURE-SPEC.md §Isolated session seed.
const PROJECT = "ux-fixture-project";
const S_IDLE = "fixture-idle";
const S_QUESTION = "fixture-question";
const S_PERMISSION = "fixture-permission";
const S_ARCHIVED = "fixture-archived";
const S_WORKTREE = "fixture-worktree";

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

// ---- browser lifecycle -----------------------------------------------------

let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  // The fixture must actually be the disposable one (sentinel contract).
  assert.ok(existsSync(join(FIXTURE_ROOT, ".ux-fixture-sentinel")), `${FIXTURE_ROOT} is not the disposable fixture`);
  assert.ok(existsSync(WORKTREE_ROOT), `${WORKTREE_ROOT} missing — run the fixture builder first`);
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()) as { ok?: boolean };
  assert.equal(health.ok, true, `${BASE} is not a healthy fixture runtime`);
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
});

// Persona seed skips first-run onboarding deterministically (prefs contract).
const PERSONA_SEED = JSON.stringify({ persona: "engineer", plugins: [] });

interface OpenOpts {
  width: number;
  height: number;
  path: string;
  ready: string;
  storage?: Record<string, string>;
}

async function openApp(opts: OpenOpts): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  const storage = { "polyth.prefs": PERSONA_SEED, ...(opts.storage ?? {}) };
  await context.addInitScript((entries: Record<string, string>) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, storage);
  const page = await context.newPage();
  await page.goto(BASE + opts.path, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(opts.ready, { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(120);
  return page;
}

async function closePage(page: Page): Promise<void> {
  await page.context().close();
  const i = contexts.indexOf(page.context());
  if (i >= 0) contexts.splice(i, 1);
}

/** Raw event-log body — the UI must never resolve/duplicate seeded requests. */
const fetchEvents = (sessionId: string): Promise<string> =>
  fetch(`${BASE}/api/sessions/${sessionId}/events?afterSeq=0`).then((r) => r.text());

// =============================================================================
// P0 — pending question/permission surfaces take precedence over the hero
// =============================================================================

test("P0: zero-message question session shows the question stepper, not the hero", async () => {
  const events = await fetchEvents(S_QUESTION);
  for (const [w, h] of [[1280, 900], [390, 844]] as const) {
    const page = await openApp({ width: w, height: h, path: `/p/${PROJECT}/s/${S_QUESTION}`, ready: ".question-card" });
    const ctx = `question@${w}x${h}`;

    const surfaces = await page.evaluate(() => ({
      hero: document.querySelector(".hero") !== null,
      cards: document.querySelectorAll(".question-card").length,
    }));
    assert.equal(surfaces.hero, false, `${ctx}: empty-session hero rendered over the pending question`);
    assert.equal(surfaces.cards, 1, `${ctx}: expected exactly one question card, got ${surfaces.cards}`);

    // Keyboard completeness: tabbing must reach a control inside the stepper.
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() =>
        document.querySelector(".question-cards")?.contains(document.activeElement) === true);
    }
    assert.ok(reached, `${ctx}: the pending question is not reachable by keyboard`);

    // Reload/replay must re-render the surface without resolving/duplicating.
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".question-card", { state: "visible", timeout: 15_000 });
    const cardsBack = await page.evaluate(() => document.querySelectorAll(".question-card").length);
    assert.equal(cardsBack, 1, `${ctx}: reload duplicated or dropped the question card`);

    if (w === 1280) await page.screenshot({ path: join(ARTIFACTS, "question-over-hero-1280.png") });
    await closePage(page);
  }
  assert.equal(await fetchEvents(S_QUESTION), events, "rendering the question surface mutated the session event log");
});

test("P0: zero-message permission session shows the permission banner, not the hero", async () => {
  const events = await fetchEvents(S_PERMISSION);
  for (const [w, h] of [[1280, 900], [390, 844]] as const) {
    const page = await openApp({ width: w, height: h, path: `/p/${PROJECT}/s/${S_PERMISSION}`, ready: ".perm-banner" });
    const ctx = `permission@${w}x${h}`;

    const surfaces = await page.evaluate(() => ({
      hero: document.querySelector(".hero") !== null,
      banner: document.querySelector(".perm-banner") !== null,
      preview: document.body.textContent?.includes("Read fixture guide") === true,
    }));
    assert.equal(surfaces.hero, false, `${ctx}: empty-session hero rendered over the pending permission`);
    assert.equal(surfaces.banner, true, `${ctx}: permission banner missing`);
    assert.equal(surfaces.preview, true, `${ctx}: permission preview title missing`);

    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() =>
        document.querySelector(".perm-banner")?.contains(document.activeElement) === true);
    }
    assert.ok(reached, `${ctx}: the pending permission is not reachable by keyboard`);
    await closePage(page);
  }
  assert.equal(await fetchEvents(S_PERMISSION), events, "rendering the permission surface mutated the session event log");
});

// =============================================================================
// P0 — Files (and header/status) resolve the selected session's worktree
// =============================================================================

test("P0: Files view of the worktree session shows the attached checkout, not the primary", async () => {
  const page = await openApp({
    width: 1280, height: 900,
    path: `/p/${PROJECT}/s/${S_WORKTREE}`,
    ready: ".ft-row",
    storage: { "polyth.activeView": "files" },
  });

  // Header subtitle and status bar must carry the worktree branch.
  await page.waitForFunction(
    () => document.querySelector(".header-sub")?.textContent?.includes("fixture/worktree") === true,
    undefined, { timeout: 15_000 },
  );
  const statusBranch = await page.textContent(".sb-branch");
  assert.match(statusBranch ?? "", /fixture\/worktree/, "status bar reports the wrong branch for the worktree session");

  // The tree must contain docs/worktree-note.md (worktree-only) and must not
  // contain docs/renamed-guide.md (primary-checkout rename).
  await page.click('.ft-row:has(.ft-name:text-is("docs"))');
  await page.waitForSelector('.ft-name:text-is("worktree-note.md")', { state: "visible", timeout: 15_000 });
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".ft-name")).map((n) => n.textContent ?? ""));
  assert.ok(names.includes("worktree-note.md"), "worktree-only file missing from Files");
  assert.ok(!names.includes("renamed-guide.md"), "primary-checkout file leaked into the worktree session's Files");

  // Opening the worktree-only file renders its committed content.
  await page.click('.ft-row:has(.ft-name:text-is("worktree-note.md"))');
  await page.waitForFunction(
    () => document.body.textContent?.includes("Synthetic attached-worktree content") === true,
    undefined, { timeout: 15_000 },
  );
  await page.screenshot({ path: join(ARTIFACTS, "files-worktree-session-1280.png") });
  await closePage(page);
});

test("P0: /api/files resolves per-session roots and writes cannot touch the primary checkout", async () => {
  const treeOf = async (sessionId: string): Promise<string[]> => {
    const r = await fetch(`${BASE}/api/files/tree?projectId=${PROJECT}&sessionId=${sessionId}&path=docs`);
    assert.equal(r.status, 200, `tree(${sessionId}) failed: ${r.status}`);
    const entries = await r.json() as Array<{ name: string }>;
    return entries.map((e) => e.name);
  };

  const worktreeDocs = await treeOf(S_WORKTREE);
  assert.ok(worktreeDocs.includes("worktree-note.md"), "worktree session tree misses worktree-note.md");
  assert.ok(!worktreeDocs.includes("renamed-guide.md"), "worktree session tree leaks the primary rename");

  const primaryDocs = await treeOf(S_IDLE);
  assert.ok(primaryDocs.includes("renamed-guide.md"), "primary session tree misses renamed-guide.md");
  assert.ok(!primaryDocs.includes("worktree-note.md"), "primary session tree leaks the worktree file");

  // Write through the worktree session, then prove on disk that only the
  // worktree received the file; delete it again to leave the checkout clean.
  const probe = "live-probe-fixture-visual.txt";
  const write = await fetch(`${BASE}/api/files/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: PROJECT, sessionId: S_WORKTREE, path: probe, content: "synthetic probe\n" }),
  });
  assert.equal(write.status, 200, "worktree write failed");
  try {
    assert.ok(existsSync(join(WORKTREE_ROOT, probe)), "probe missing from the worktree checkout");
    assert.ok(!existsSync(join(FIXTURE_ROOT, probe)), "worktree write leaked into the primary checkout");
  } finally {
    const del = await fetch(`${BASE}/api/files/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: PROJECT, sessionId: S_WORKTREE, path: probe }),
    });
    assert.equal(del.status, 200, "probe cleanup failed");
  }
  assert.ok(!existsSync(join(WORKTREE_ROOT, probe)), "probe cleanup left the worktree dirty");
});

// =============================================================================
// P1 — archived sessions replace the composer with an explicit restore action
// =============================================================================

test("P1: archived session blocks composition behind a restore action", async () => {
  const events = await fetchEvents(S_ARCHIVED);
  for (const [w, h] of [[1280, 900], [390, 844]] as const) {
    const page = await openApp({ width: w, height: h, path: `/p/${PROJECT}/s/${S_ARCHIVED}`, ready: ".archived-guard" });
    const ctx = `archived@${w}x${h}`;
    const state = await page.evaluate(() => ({
      guard: document.querySelector(".archived-guard") !== null,
      restore: document.querySelector(".archived-restore-btn") !== null,
      restoreDisabled: document.querySelector<HTMLButtonElement>(".archived-restore-btn")?.disabled ?? true,
      composerInput: document.querySelector(".composer-input textarea") !== null,
      send: document.querySelector(".send") !== null,
      transcript: document.querySelectorAll(".timeline .msg").length,
    }));
    assert.equal(state.guard, true, `${ctx}: archived guard missing`);
    assert.equal(state.restore, true, `${ctx}: restore action missing`);
    assert.equal(state.restoreDisabled, false, `${ctx}: restore action is not actionable`);
    assert.equal(state.composerInput, false, `${ctx}: archived session still presents an editable composer`);
    assert.equal(state.send, false, `${ctx}: archived session still presents Send`);
    assert.ok(state.transcript > 0, `${ctx}: archived transcript should stay readable`);
    if (w === 1280) await page.screenshot({ path: join(ARTIFACTS, "archived-guard-1280.png") });
    await closePage(page);
  }
  // Presence-only checks: the archived projection and log must be untouched.
  assert.equal(await fetchEvents(S_ARCHIVED), events, "archived guard mutated the session event log");
});

// =============================================================================
// P1 — the Git toolbar never overpaints the selected diff heading
// =============================================================================

test("P1: Git changes toolbar and the selected diff heading do not overlap at 1440", async () => {
  const page = await openApp({
    width: 1440, height: 900,
    path: `/p/${PROJECT}/s/${S_IDLE}`,
    ready: ".git-changes-head",
    storage: { "polyth.activeView": "git" },
  });

  // Force the flat list, then select the conflicted file (the audit case).
  await page.click('.git-changes-head button:text-is("Flat")');
  await page.waitForSelector('.git-file-row:has(.git-file-path[title="conflict.txt"])', { state: "visible", timeout: 15_000 });
  await page.click('.git-file-row:has(.git-file-path[title="conflict.txt"])');
  await page.waitForFunction(
    () => document.querySelector(".git-col-right .wt-file")?.textContent?.includes("conflict.txt") === true,
    undefined, { timeout: 15_000 },
  );

  const geometry = await page.evaluate(() => {
    const heading = document.querySelector(".git-col-right .wt-file")!.getBoundingClientRect();
    const head = document.querySelector(".git-changes-head")!;
    const headRect = head.getBoundingClientRect();
    const leftCol = document.querySelector(".git-col")!.getBoundingClientRect();
    const controls = Array.from(head.querySelectorAll<HTMLElement>("button, span"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { text: (el.textContent ?? "").slice(0, 24), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      });
    return {
      heading: { left: heading.left, right: heading.right, top: heading.top, bottom: heading.bottom },
      headRight: headRect.right,
      colRight: leftCol.right,
      overflowX: head.scrollWidth - head.clientWidth,
      controls,
    };
  });

  // No toolbar control may intersect the right-pane heading box.
  for (const c of geometry.controls) {
    const w = Math.min(c.right, geometry.heading.right) - Math.max(c.left, geometry.heading.left);
    const h = Math.min(c.bottom, geometry.heading.bottom) - Math.max(c.top, geometry.heading.top);
    const area = Math.max(0, w) * Math.max(0, h);
    assert.ok(area < 0.5, `"${c.text}" overpaints the diff heading by ${area.toFixed(1)}px²`);
  }
  // The toolbar itself must stay inside its own column and never overflow.
  assert.ok(geometry.headRight <= geometry.colRight + 0.5,
    `changes toolbar (${geometry.headRight}) escapes its column (${geometry.colRight})`);
  assert.ok(geometry.overflowX <= 1, `changes toolbar scrolls horizontally by ${geometry.overflowX}px`);

  await page.screenshot({ path: join(ARTIFACTS, "git-toolbar-conflict-1440.png") });
  await closePage(page);
});

// =============================================================================
// P1 — loop validation errors survive rescan/refresh and support dismissal
// =============================================================================

test("P1: loop rescan diagnostics persist across refresh and dismiss explicitly", async () => {
  const RESCAN = 'button[title="Rescan .agents/loops for Markdown-managed tasks"]';
  const page = await openApp({
    width: 1280, height: 900,
    path: `/p/${PROJECT}/s/${S_IDLE}`,
    ready: RESCAN,
    storage: { "polyth.activeView": "schedule" },
  });

  const errorTexts = () =>
    page.evaluate(() => Array.from(document.querySelectorAll(".loop-error-row")).map((r) => r.textContent ?? ""));

  await page.click(RESCAN);
  await page.waitForFunction(() => document.querySelectorAll(".loop-error-row").length === 2, undefined, { timeout: 15_000 });
  let texts = await errorTexts();
  assert.ok(texts.some((t) => t.includes("invalid-cron.md")), `cron-alias diagnostic missing: ${texts.join(" | ")}`);
  assert.ok(texts.some((t) => t.includes("invalid-id.md")), `lowercase-id diagnostic missing: ${texts.join(" | ")}`);

  // A full page refresh re-lists the schedule; the diagnostics must survive.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(RESCAN, { state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll(".loop-error-row").length === 2, undefined, { timeout: 15_000 });
  await page.screenshot({ path: join(ARTIFACTS, "loop-errors-persist-1280.png") });

  // Explicit dismissal removes exactly the dismissed diagnostic…
  await page.click('button[aria-label*="invalid-cron.md"]');
  await page.waitForFunction(() => document.querySelectorAll(".loop-error-row").length === 1, undefined, { timeout: 15_000 });
  texts = await errorTexts();
  assert.ok(texts.every((t) => !t.includes("invalid-cron.md")), "dismissed diagnostic still listed");
  assert.ok(texts.some((t) => t.includes("invalid-id.md")), "dismissal removed the wrong diagnostic");

  // …and it stays dismissed across refresh until the next explicit rescan.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(RESCAN, { state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => document.querySelectorAll(".loop-error-row").length === 1, undefined, { timeout: 15_000 });
  await page.click(RESCAN);
  await page.waitForFunction(() => document.querySelectorAll(".loop-error-row").length === 2, undefined, { timeout: 15_000 });

  await closePage(page);
});

// =============================================================================
// P1 — status metadata meets 4.5:1 normal-text contrast in the default theme
// =============================================================================

test("P1: sidebar status/time labels and the header subtitle meet 4.5:1", async () => {
  const page = await openApp({ width: 1280, height: 900, path: `/p/${PROJECT}/s/${S_IDLE}`, ready: ".session-row.active" });

  const ratios = await page.evaluate(() => {
    type RGB = { r: number; g: number; b: number };
    const parse = (s: string): { r: number; g: number; b: number; a: number } | null => {
      const m = /rgba?\(([^)]+)\)/.exec(s);
      if (!m) return null;
      const p = m[1]!.split(",").map((x) => parseFloat(x));
      return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 };
    };
    const effBg = (el: Element): RGB => {
      const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) layers.push(c);
        if (c && c.a >= 1) break;
      }
      let bg: RGB = { r: 128, g: 128, b: 128 };
      for (let i = layers.length - 1; i >= 0; i--) {
        const c = layers[i]!;
        bg = { r: c.r * c.a + bg.r * (1 - c.a), g: c.g * c.a + bg.g * (1 - c.a), b: c.b * c.a + bg.b * (1 - c.a) };
      }
      return bg;
    };
    const lum = (c: RGB): number => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const contrast = (sel: string): number | null => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg) return null;
      // Effective foreground includes any inherited opacity on the row.
      let alpha = fg.a;
      for (let n: Element | null = el; n; n = n.parentElement) {
        alpha *= parseFloat(getComputedStyle(n).opacity || "1");
      }
      const bg = effBg(el);
      const eff: RGB = {
        r: fg.r * alpha + bg.r * (1 - alpha),
        g: fg.g * alpha + bg.g * (1 - alpha),
        b: fg.b * alpha + bg.b * (1 - alpha),
      };
      const l1 = Math.max(lum(eff), lum(bg));
      const l2 = Math.min(lum(eff), lum(bg));
      return (l1 + 0.05) / (l2 + 0.05);
    };
    return {
      selectedStatus: contrast(".session-row.active .session-sub"),
      restingStatus: contrast(".session-row:not(.active) .session-sub"),
      sessionDate: contrast(".session-date-divider"),
      headerSub: contrast(".header-sub"),
      archivedTitle: contrast(".session-row.archived .session-title"),
    };
  });

  const cases: Array<[string, number | null]> = [
    ["selected status label", ratios.selectedStatus],
    ["resting status label", ratios.restingStatus],
    ["session date divider", ratios.sessionDate],
    ["header subtitle", ratios.headerSub],
    ["archived session title", ratios.archivedTitle],
  ];
  for (const [label, ratio] of cases) {
    assert.ok(ratio !== null, `${label}: element missing`);
    assert.ok(ratio! >= 4.5, `${label}: contrast ${ratio!.toFixed(2)} < 4.5`);
  }

  await page.screenshot({ path: join(ARTIFACTS, "status-contrast-1280.png") });
  await closePage(page);
});
