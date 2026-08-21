// UX-PANE-MODEL live regressions for the PANE-VERIFY-01/02 repair, in a real
// Chromium against the real server:
//
//  1. A seeded open-Files preference plus a reload of the canonical session
//     URL renders one app, one Timeline, one Composer, and no React error —
//     the guard promotion must latch instead of self-cancelling into the
//     maximum-update-depth loop (React #185).
//  2. The exact crash shape: a FRESH session (hero composer) with a typed
//     draft, Files open, reload. The app must render and keep the draft.
//  3. Center hit-test gates at 1440/1200/1024/1000/900 with the full
//     engineer composer: a settled dock leaves every visible composer action
//     winning its own center hit test; an invalid dock promotes to the
//     full-screen layer without a render loop, and the chosen mode is stable.
//
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --test apps/web/test/paneModelGuard.live.ts
//
// Requirements: playwright-core installed (npm i --no-save playwright-core),
// a Chromium/Chrome executable, and the opencode CLI on PATH (session
// creation spawns the per-project runtime). The harness is self-contained:
// it builds apps/web/dist, boots the real server on a free port with a
// throwaway data dir, and creates a throwaway project directory.
//   POLYTH_CHROMIUM_PATH   Chromium executable (well-known paths otherwise)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") srv.close(() => res(addr.port));
      else rej(new Error("no port"));
    });
    srv.on("error", rej);
  });
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
    child.on("error", rej);
  });
}

// ---- server + browser lifecycle ---------------------------------------------

let BASE = "";
let server: ChildProcess | undefined;
let browser: Browser;
const contexts: BrowserContext[] = [];

// One real project + one message-bearing session + one fresh session, shared
// by every gate (session creation spawns the per-project opencode runtime).
let projectId = "";
let messageSessionId = "";
let freshSessionId = "";

before(async () => {
  // Always rebuild so the bundle under test is the working tree, not a stale dist.
  await run(process.execPath, ["apps/web/build.ts"], REPO_ROOT);

  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), "polyth-pane-live-data-"));
  // detached → own process group, so cleanup can take the spawned per-project
  // opencode runtime down with the server.
  server = spawn(process.execPath, ["packages/server/src/index.ts"], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(port), POLYTH_DATA_DIR: dataDir },
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const health = await fetch(`${BASE}/api/health`).then((r) => r.json()) as { ok?: boolean };
      if (health.ok === true) break;
    } catch { /* not up yet */ }
    assert.ok(Date.now() < deadline, `server at ${BASE} did not become healthy`);
    await new Promise((r) => setTimeout(r, 200));
  }

  const projectDir = await mkdtemp(join(tmpdir(), "polyth-pane-live-project-"));
  await writeFile(join(projectDir, "README.md"), "# pane guard fixture\n");
  const project = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectDir, name: "pane-guard" }),
  }).then((r) => r.json()) as { id: string };
  assert.ok(project.id, "project creation failed");
  projectId = project.id;

  const mkSession = async (title: string): Promise<string> => {
    const s = await fetch(`${BASE}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, title }),
    }).then((r) => r.json()) as { id: string };
    assert.ok(s.id, `session "${title}" creation failed (is opencode on PATH?)`);
    return s.id;
  };
  messageSessionId = await mkSession("pane guard timeline");
  freshSessionId = await mkSession("pane guard hero");

  // A user message makes the Timeline render (the message event is appended
  // to the session log immediately; the model's reply is irrelevant here).
  await fetch(`${BASE}/api/sessions/${messageSessionId}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Anchor message for the pane guard gates." }),
  });
  const events = await fetch(`${BASE}/api/sessions/${messageSessionId}/events`)
    .then((r) => r.json()) as Array<{ type: string }>;
  assert.ok(
    events.some((e) => e.type === "user/message"),
    `no user message event landed; got: ${events.map((e) => e.type).join(", ")}`,
  );

  const pw = await import("playwright-core");
  browser = await pw.chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
  });
}, { timeout: 300_000 });

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
  }
});

// Persona seed skips first-run onboarding; empty plugins fill from the
// engineer persona defaults → the FULL composer (Model/Agent pickers, Attach,
// focused editor, Send) and the files/git/terminal/preview launchers.
const PERSONA_SEED = JSON.stringify({ persona: "engineer", plugins: [] });

interface Harness {
  page: Page;
  errors: string[];
}

/** Opens the app with the engineer persona and optional extra localStorage
 *  seeds, collecting every page error and console error. */
async function openApp(
  path: string,
  viewport: { width: number; height: number },
  seeds: Record<string, string> = {},
): Promise<Harness> {
  const context = await browser.newContext({
    viewport,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addInitScript((entries: Record<string, string>) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, { "polyth.prefs": PERSONA_SEED, ...seeds });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  await page.goto(BASE + path, { waitUntil: "load" });
  return { page, errors };
}

async function closeApp(h: Harness): Promise<void> {
  await h.page.context().close();
  const i = contexts.indexOf(h.page.context());
  if (i >= 0) contexts.splice(i, 1);
}

const paneSeed = (openSurface: string): Record<string, string> => ({
  [`polyth.workspacePane.v1.${projectId}`]: JSON.stringify({
    version: 1, openSurface, expanded: false, widths: {}, lastResource: {},
  }),
});

/** Two settle frames plus a beat for observers/models to land. */
async function settle(page: Page, ms = 400): Promise<void> {
  await page.evaluate(() =>
    new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.waitForTimeout(ms);
}

const reactLoopErrors = (errors: string[]): string[] =>
  errors.filter((e) =>
    e.includes("Maximum update depth") || e.includes("error #185") || e.includes("Minified React error"));

interface PaneModeSnapshot {
  apps: number;
  paneOpen: boolean;
  layered: boolean;
  chatWidth: number;
  bodyText: number;
}

const snapshotMode = (page: Page): Promise<PaneModeSnapshot> =>
  page.evaluate(() => {
    const pane = document.querySelector(".rail-workspace");
    const chat = document.querySelector(".app > .workspace");
    return {
      apps: document.querySelectorAll(".app").length,
      paneOpen: pane !== null,
      layered: pane?.classList.contains("rail-fullscreen") ?? false,
      chatWidth: chat ? Math.round(chat.getBoundingClientRect().width) : 0,
      bodyText: (document.body.innerText ?? "").trim().length,
    };
  });

interface HitFailure {
  action: string;
  hit: string;
  reason: string;
}

/** Every VISIBLE composer action must win its own center hit test inside
 *  Chat's clip rectangle (intentional positioned layers excluded, exactly
 *  like the guard). Returns human-readable failures. */
const centerHitFailures = (page: Page): Promise<HitFailure[]> =>
  page.evaluate(() => {
    const describe = (el: Element | null): string =>
      el === null ? "null" : `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
    const chat = document.querySelector(".app > .workspace");
    const composer = chat?.querySelector(".composer, .composer-hero") ?? null;
    if (!chat || !composer) return [{ action: "-", hit: "-", reason: "no chat/composer found" }];
    const chatRect = chat.getBoundingClientRect();
    const failures: { action: string; hit: string; reason: string }[] = [];
    for (const action of composer.querySelectorAll("button, textarea, [role=button]")) {
      const r = action.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.left < chatRect.left - 0.5 || r.right > chatRect.right + 0.5) {
        failures.push({ action: describe(action), hit: "-", reason: "clipped outside chat" });
        continue;
      }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || hit === action || action.contains(hit) || hit.contains(action)) continue;
      let layered = false;
      for (let el: Element | null = hit; el && el !== chat; el = el.parentElement) {
        const pos = getComputedStyle(el).position;
        if (pos === "absolute" || pos === "fixed") { layered = true; break; }
      }
      if (!layered) failures.push({ action: describe(action), hit: describe(hit), reason: "center covered" });
    }
    return failures;
  });

// =============================================================================

test("live: reload of the canonical session URL with Files open renders one app, one Timeline, one Composer, no React error", { timeout: 120_000 }, async () => {
  const h = await openApp(`/p/${projectId}/s/${messageSessionId}`, { width: 1440, height: 900 }, paneSeed("files"));
  try {
    await h.page.waitForSelector(".app", { timeout: 15_000 });
    await h.page.waitForSelector(".timeline-wrap", { timeout: 15_000 });
    await settle(h.page);

    assert.deepEqual(reactLoopErrors(h.errors), [], `React render-loop errors: ${h.errors.join(" | ")}`);
    const counts = await h.page.evaluate(() => ({
      apps: document.querySelectorAll(".app").length,
      timelines: document.querySelectorAll(".timeline-wrap").length,
      composers: document.querySelectorAll(".composer, .composer-hero").length,
      paneOpen: document.querySelector(".rail-workspace") !== null,
      bodyText: (document.body.innerText ?? "").trim().length,
    }));
    assert.equal(counts.apps, 1, "exactly one app");
    assert.equal(counts.timelines, 1, "exactly one Timeline");
    assert.equal(counts.composers, 1, "exactly one Composer");
    assert.equal(counts.paneOpen, true, "Files pane restored open");
    assert.ok(counts.bodyText > 0, "application did not blank");

    // The mode the guard chose must be stable — no promote/release loop.
    const first = await snapshotMode(h.page);
    await settle(h.page, 500);
    const second = await snapshotMode(h.page);
    assert.equal(second.layered, first.layered, "presentation mode oscillated after settling");
    if (!second.layered) assert.ok(second.chatWidth >= 320, `docked Chat below floor: ${second.chatWidth}px`);
  } finally {
    await closeApp(h);
  }
});

test("live: the PANE-VERIFY-02 crash shape — fresh session, typed draft, Files open, reload — renders and keeps the draft", { timeout: 120_000 }, async () => {
  const draft = "Exact draft typed before the reload — must survive byte-for-byte.";
  const h = await openApp(`/p/${projectId}/s/${freshSessionId}`, { width: 1440, height: 900 }, {
    ...paneSeed("files"),
    [`polyth.draft.${freshSessionId}`]: draft,
  });
  try {
    await h.page.waitForSelector(".app", { timeout: 15_000 });
    // Fresh session → the hero stage with the hero composer variant (waiting
    // on `.composer-hero`, not `.stage`, which the project empty state also
    // renders during boot). Before the repair this exact shape entered the
    // guard's promote/clear loop and blanked the app with React #185.
    await h.page.waitForSelector(".composer-hero", { timeout: 15_000 });
    await h.page.waitForSelector(".rail-workspace", { timeout: 15_000 });
    await settle(h.page);

    assert.deepEqual(reactLoopErrors(h.errors), [], `React render-loop errors: ${h.errors.join(" | ")}`);
    const state = await h.page.evaluate((sid: string) => ({
      apps: document.querySelectorAll(".app").length,
      heroComposers: document.querySelectorAll(".composer-hero").length,
      paneOpen: document.querySelector(".rail-workspace") !== null,
      bodyText: (document.body.innerText ?? "").trim().length,
      storedDraft: localStorage.getItem(`polyth.draft.${sid}`),
      editorText: (() => {
        const el = document.querySelector(".composer-editor");
        if (!el) return null;
        return el instanceof HTMLTextAreaElement ? el.value : el.textContent;
      })(),
    }), freshSessionId);
    assert.equal(state.apps, 1, "exactly one app");
    assert.equal(state.heroComposers, 1, "exactly one (hero) Composer");
    assert.equal(state.paneOpen, true, "Files pane restored open");
    assert.ok(state.bodyText > 0, "application blanked (the PANE-VERIFY-02 failure)");
    assert.equal(state.storedDraft, draft, "draft must survive the reload byte-for-byte");
    assert.ok((state.editorText ?? "").includes(draft), "draft restored into the composer editor");
  } finally {
    await closeApp(h);
  }
});

for (const width of [1440, 1200, 1024, 1000, 900]) {
  test(`live: ${width}px gate — full engineer composer, docked actions win their centers or the dock promotes without a loop`, { timeout: 120_000 }, async () => {
    const h = await openApp(`/p/${projectId}/s/${messageSessionId}`, { width, height: 900 });
    try {
      await h.page.waitForSelector(".app", { timeout: 15_000 });
      await h.page.waitForSelector(".timeline-wrap", { timeout: 15_000 });
      // The FULL engineer composer: wait for the Model picker chip so the
      // late-mounting pickers are part of the judged layout.
      await h.page.waitForSelector(".composer .picker-chip", { timeout: 20_000 });

      await h.page.click(`[data-pane-launcher="files"]`);
      await h.page.waitForSelector(".rail-workspace", { timeout: 15_000 });
      await settle(h.page);

      assert.deepEqual(reactLoopErrors(h.errors), [], `React render-loop errors: ${h.errors.join(" | ")}`);
      const first = await snapshotMode(h.page);
      assert.equal(first.apps, 1, "exactly one app");
      assert.equal(first.paneOpen, true, "Files pane is open");
      assert.ok(first.bodyText > 0, "application did not blank");

      // The guard's decision must be stable — an invalid dock promotes ONCE
      // and latches; it never ping-pongs between docked and layered.
      await settle(h.page, 500);
      const second = await snapshotMode(h.page);
      assert.equal(second.layered, first.layered, `mode oscillated at ${width}px`);
      assert.deepEqual(reactLoopErrors(h.errors), [], `late React render-loop errors: ${h.errors.join(" | ")}`);

      if (!second.layered) {
        // Docked: Chat holds the floor and every visible composer action
        // wins its own center hit test.
        assert.ok(second.chatWidth >= 320, `docked Chat below floor at ${width}px: ${second.chatWidth}px`);
        const failures = await centerHitFailures(h.page);
        assert.deepEqual(failures, [], `covered composer actions at ${width}px: ${JSON.stringify(failures)}`);
      } else {
        // Promoted: the full-screen layer is up, Chat is inert underneath,
        // and the app is intact — the safety path, not a crash.
        const layer = await h.page.evaluate(() => ({
          fullscreen: document.querySelector(".rail-workspace.rail-fullscreen") !== null,
          chatInert: document.querySelector(".app > .workspace")?.hasAttribute("inert") ?? false,
        }));
        assert.equal(layer.fullscreen, true, "layer mode uses the full-screen pane");
        assert.equal(layer.chatInert, true, "Chat must be inert under the layer");
      }
    } finally {
      await closeApp(h);
    }
  });
}
