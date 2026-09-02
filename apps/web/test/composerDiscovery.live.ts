// UX-COMPOSER-DISC live novice/expert gate. Drives a real Chromium against
// the isolated synthetic runtime (composerDiscFixtureSetup.mjs + the fake
// model backend + a deterministic `gh` shim) and asserts the spec's live
// acceptance items: truthful Add-menu rows with four-state catalog details,
// menu insertion equal to typed sigils, honest combobox states (instruction /
// results / successful-empty / forced-failure), shell-entry honesty, GitHub
// link-only pills with exact mismatch errors, visible named voice states with
// draft-only transcripts, truthful selector names and contract-bounded model
// detail, per-session configuration persistence across reload, active-turn
// delivery copy with a separate Stop, and phone/coarse ≥44px geometry with
// bounded popups.
//
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --experimental-strip-types --test apps/web/test/composerDiscovery.live.ts
//
// Self-booting: builds the disposable fixture, rebuilds apps/web/dist, and
// starts an isolated Polyth server on port 4464 whose PATH resolves both
// `opencode` and `gh` to synthetic stand-ins. Override with POLYTH_LIVE_URL
// to point at an externally started fixture runtime instead.
//   POLYTH_CHROMIUM_PATH   Chromium executable (well-known paths otherwise)
//   POLYTH_LIVE_ARTIFACTS  directory for screenshots
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  FIXTURE_BIN, FIXTURE_DATA, FIXTURE_HOME, GH_NAME, GH_OWNER, OC_SEED, OC_STATE,
  PROJECT_ID, REPO_ROOT, SESSIONS, buildComposerDiscFixture,
} from "./composerDiscFixtureSetup.mjs";

// ---- environment -----------------------------------------------------------

const SELF_BOOT = !process.env.POLYTH_LIVE_URL;
const BASE = (process.env.POLYTH_LIVE_URL ?? "http://127.0.0.1:4464").replace(/\/$/, "");
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? "/tmp/polyth-compdisc-artifacts";

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

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (SELF_BOOT) {
    await buildComposerDiscFixture();
    // Always rebuild: the gate must exercise the current sources, never a
    // stale bundle.
    execFileSync(process.execPath, ["--experimental-strip-types", "apps/web/buildPackages.ts"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["--experimental-strip-types", "apps/web/build.ts"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    serverProc = spawn(process.execPath, ["--experimental-strip-types", "packages/server/src/index.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: FIXTURE_HOME,
        XDG_CONFIG_HOME: join(FIXTURE_HOME, ".config"),
        XDG_DATA_HOME: join(FIXTURE_HOME, ".local/share"),
        OPENCODE_CONFIG_DIR: join(FIXTURE_HOME, "opencode"),
        POLYTH_DATA_DIR: FIXTURE_DATA,
        PORT: "4464",
        PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
        MSGACT_OC_SEED: OC_SEED,
        MSGACT_OC_STATE: OC_STATE,
        POLYTH_FAKE_BROWSER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    serverProc.stdout?.resume();
    serverProc.stderr?.resume();
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
// plugins:[] fills from the engineer defaults (includes dictation + goals).
const ENGINEER_SEED = JSON.stringify({ persona: "engineer", plugins: [] });

interface OpenOpts {
  width?: number;
  height?: number;
  session?: string;
  /** Extra localStorage entries seeded before the app boots. */
  storage?: Record<string, string>;
  /** Web Speech control: `none` removes the ctors, `fake` installs a
   *  test-controllable engine at window.__speech. Default: untouched. */
  speech?: "none" | "fake";
  /** Force every /api/commands response to HTTP 500 (transport failure). */
  commandsFail?: boolean;
  /** Coarse-pointer emulation (touch). */
  coarse?: boolean;
}

async function openApp(opts: OpenOpts = {}): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    ...(opts.coarse ? { hasTouch: true } : {}),
  });
  contexts.push(context);
  if (opts.commandsFail) {
    await context.route("**/api/commands*", (route) =>
      route.fulfill({ status: 500, contentType: "text/plain", body: "synthetic catalog failure" }));
  }
  const storage = {
    "polyth.prefs": ENGINEER_SEED,
    [`polyth.projectSetup.v1.${PROJECT_ID}`]: "completed",
    ...(opts.storage ?? {}),
  };
  await context.addInitScript((entries: Record<string, string>) => {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  }, storage);
  if (opts.speech === "none") {
    await context.addInitScript(() => {
      Object.defineProperty(window, "SpeechRecognition", { value: undefined, configurable: true });
      Object.defineProperty(window, "webkitSpeechRecognition", { value: undefined, configurable: true });
    });
  }
  if (opts.speech === "fake") {
    await context.addInitScript(() => {
      const registry = {
        instances: [] as Array<Record<string, unknown>>,
        emitResult(text: string) {
          const rec = registry.instances[registry.instances.length - 1] as {
            onresult?: (e: unknown) => void;
          };
          const result = Object.assign([{ transcript: text }], { isFinal: true });
          rec.onresult?.({ resultIndex: 0, results: [result] });
        },
        emitError(code: string) {
          const rec = registry.instances[registry.instances.length - 1] as {
            onerror?: (e: unknown) => void;
          };
          rec.onerror?.({ error: code });
        },
      };
      (window as unknown as { __speech: typeof registry }).__speech = registry;
      class FakeRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        constructor() { registry.instances.push(this as unknown as Record<string, unknown>); }
        start() { /* the test drives events explicitly */ }
        stop() { (this as unknown as { onend?: () => void }).onend?.(); }
        abort() { (this as unknown as { onend?: () => void }).onend?.(); }
      }
      // Both names: headless Chromium may expose a native unprefixed
      // SpeechRecognition, which the app prefers over the webkit alias.
      Object.defineProperty(window, "SpeechRecognition", { value: FakeRecognition, configurable: true });
      Object.defineProperty(window, "webkitSpeechRecognition", { value: FakeRecognition, configurable: true });
    });
  }
  const page = await context.newPage();
  const session = opts.session ?? SESSIONS.main;
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${session}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(".composer-card", { state: "visible", timeout: 15_000 });
  // Models resolved: pickers render only when the runtime reported models.
  await page.waitForSelector(".picker-model .model-picker-trigger", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(120);
  return page;
}

async function closePage(page: Page): Promise<void> {
  await page.context().close();
  const i = contexts.indexOf(page.context());
  if (i >= 0) contexts.splice(i, 1);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(ARTIFACTS, name), fullPage: false });

/** Durable-event honesty: browser-local interactions must not append. */
async function eventCount(sessionId: string): Promise<number> {
  const evs = await fetch(`${BASE}/api/sessions/${sessionId}/events`).then((r) => r.json()) as unknown[];
  return evs.length;
}

const editor = (page: Page) => page.locator(".composer-editor");
const addTrigger = (page: Page) => page.locator(".composer-add-trigger");
const addMenu = (page: Page) => page.locator("#composer-add-menu");

async function openAddMenu(page: Page): Promise<void> {
  await addTrigger(page).click();
  await page.waitForSelector("#composer-add-menu", { state: "visible" });
}

const menuItem = (page: Page, label: string) =>
  addMenu(page).locator("button[role='menuitem']", { hasText: label });

// =============================================================================

test("add menu: truthful rows, four-state details, ARIA, and no invented capability", async () => {
  const page = await openApp();
  const before = await eventCount(SESSIONS.main);

  const trigger = addTrigger(page);
  await trigger.waitFor({ state: "visible" });
  assert.equal(await trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(
    await trigger.getAttribute("aria-label"),
    "Add files, context, and tools",
  );

  await openAddMenu(page);
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await addMenu(page).getAttribute("role"), "menu");

  // Catalog details resolve to the authoritative endpoint's count (project
  // commands plus built-ins) — never a guess.
  const commandCount = (await fetch(
    `${BASE}/api/commands?projectId=${PROJECT_ID}`,
  ).then((r) => r.json()) as unknown[]).length;
  assert.ok(commandCount >= 2, "fixture project commands are served");
  await page.waitForFunction((n) =>
    document.querySelector("#composer-add-menu")?.textContent?.includes(`${n} available`), commandCount);

  // textContent: group headers are CSS-uppercased, which innerText reflects.
  const labels = await addMenu(page)
    .locator(".add-menu-group, .add-menu-label")
    .allTextContents();
  assert.deepEqual(labels, [
    "Add context", "Upload files…", "Mention project file…",
    "Link GitHub issue or pull request…", "Attach goal…",
    "Compose", "Commands", "Snippets", "Shell command",
  ]);

  const menuText = (await addMenu(page).innerText()).toLowerCase();
  assert.ok(menuText.includes(`${commandCount} available`), "command catalog count");
  assert.ok(menuText.includes("no snippets yet"), "successful-empty snippet catalog");
  assert.ok(menuText.includes("copies files into this project’s _inbox"), "upload outcome copy");
  assert.ok(menuText.includes("adds a link only"), "github link-only copy");
  assert.ok(!menuText.includes("skill"), "no Skills capability is invented");
  assert.ok(!menuText.includes("variant"), "no model Variant is invented");

  // Sigil hints are secondary expert columns on the right rows.
  for (const [label, hint] of [
    ["Mention project file…", "@"], ["Commands", "/"], ["Snippets", "#"], ["Shell command", "!"],
  ] as const) {
    assert.equal(await menuItem(page, label).locator(".add-menu-hint").innerText(), hint, label);
  }

  await shot(page, "add_menu_open.png");

  // Escape closes and restores focus to the trigger; nothing was appended.
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-add-menu", { state: "detached" });
  assert.equal(
    await page.evaluate(() => document.activeElement?.className ?? ""),
    await trigger.evaluate((el) => el.className),
  );
  assert.equal(await eventCount(SESSIONS.main), before, "menu open/close appends no session event");
  await closePage(page);
});

test("menu insertion equals typed sigils; the popup is an honest combobox", async () => {
  const page = await openApp();
  const before = await eventCount(SESSIONS.main);
  const input = editor(page);
  await input.click();

  // Mention → "@" at the caret with the instruction state (not a fake list).
  await openAddMenu(page);
  await menuItem(page, "Mention project file…").click();
  await page.waitForSelector(".ac-popup", { state: "visible" });
  assert.equal(await input.inputValue(), "@");
  assert.equal(await input.getAttribute("role"), "combobox");
  assert.equal(await input.getAttribute("aria-expanded"), "true");
  assert.equal(await input.getAttribute("aria-controls"), "composer-autocomplete-list");
  assert.equal((await page.locator(".ac-status").innerText()).trim(), "Type a file or folder name.");

  // Real project file search; the active option owns aria-activedescendant.
  await page.keyboard.type("alpha");
  await page.waitForSelector(".ac-item", { state: "visible" });
  const first = page.locator(".ac-item").first();
  assert.equal(await first.locator(".ac-label").innerText(), "@src/alpha.ts");
  const optionId = await first.getAttribute("id");
  assert.ok(optionId?.startsWith("composer-ac-file-"), "stable kind+identity option id");
  assert.equal(await input.getAttribute("aria-activedescendant"), optionId);
  await shot(page, "ac_file_results.png");
  await page.keyboard.press("Enter");
  assert.equal(await input.inputValue(), "@src/alpha.ts ");
  await page.waitForSelector(".ac-popup", { state: "detached" });

  // Commands → "/" on its own valid line; the list is exactly what the
  // authoritative endpoint serves (project commands plus built-ins).
  const served = (await fetch(
    `${BASE}/api/commands?projectId=${PROJECT_ID}`,
  ).then((r) => r.json()) as Array<{ name: string }>).map((c) => `/${c.name}`);
  await openAddMenu(page);
  await menuItem(page, "Commands").click();
  await page.waitForSelector(".ac-item", { state: "visible" });
  assert.equal(await input.inputValue(), "@src/alpha.ts \n/");
  assert.deepEqual(await page.locator(".ac-item .ac-label").allInnerTexts(), served);
  assert.ok(served.includes("/plan") && served.includes("/review"), "fixture commands listed");
  await shot(page, "ac_command_results.png");
  // Filtering + Enter completes the fixture command with its trailing space.
  await page.keyboard.type("pla");
  await page.waitForFunction(() =>
    document.querySelectorAll(".ac-item").length === 1);
  await page.keyboard.press("Enter");
  assert.equal(await input.inputValue(), "@src/alpha.ts \n/plan ");

  // Snippets: a successful zero-item catalog says so and offers creation.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type("#");
  await page.waitForSelector(".ac-status", { state: "visible" });
  assert.equal((await page.locator(".ac-status span").first().innerText()).trim(), "No snippets yet.");
  await page.waitForSelector(".ac-create-snippet", { state: "visible" });
  await shot(page, "ac_snippets_empty.png");

  // Escape closes the popup only; the token text stays in the draft.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".ac-popup", { state: "detached" });
  assert.equal(await input.inputValue(), "#");

  // The creation offer reaches the real Commands & Snippets settings.
  await page.keyboard.type("x");
  await page.keyboard.press("Backspace");
  await page.waitForSelector(".ac-create-snippet", { state: "visible" });
  await page.locator(".ac-create-snippet").click();
  await page.waitForSelector("text=Commands & Snippets", { timeout: 10_000 });

  assert.equal(await eventCount(SESSIONS.main), before, "draft-local editing appends no session event");
  await closePage(page);
});

test("a failed catalog request is unavailable — never a successful empty list", async () => {
  const page = await openApp({ commandsFail: true });
  const input = editor(page);

  // Add menu: commands truthfully unavailable while snippets stay empty —
  // independent outcomes, never collapsed.
  await openAddMenu(page);
  await page.waitForFunction(() =>
    document.querySelector("#composer-add-menu")?.textContent?.includes("Currently unavailable"));
  const menuText = await addMenu(page).innerText();
  assert.ok(menuText.includes("Currently unavailable"), "failed commands catalog");
  assert.ok(menuText.includes("No snippets yet"), "independent snippet outcome");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#composer-add-menu", { state: "detached" });

  await input.click();
  await page.keyboard.type("/");
  await page.waitForSelector(".ac-status", { state: "visible" });
  assert.equal(
    (await page.locator(".ac-status").innerText()).trim(),
    "Commands are currently unavailable.",
  );
  await shot(page, "ac_commands_unavailable.png");
  await closePage(page);
});

test("shell entry: labeled mode and Run from an empty draft; a drafted prompt is never reinterpreted", async () => {
  const page = await openApp();
  const input = editor(page);
  await input.click();

  await openAddMenu(page);
  await menuItem(page, "Shell command").click();
  await page.waitForSelector(".composer-mode-label", { state: "visible" });
  assert.equal(await input.inputValue(), "!");
  assert.equal(
    (await page.locator(".composer-mode-label").innerText()).trim(),
    "Shell command · permission checked · output added to context",
  );
  assert.equal(await page.locator(".composer-primary .send").getAttribute("aria-label"), "Run shell command");
  await shot(page, "shell_mode.png");

  // Nonempty draft: the row is disabled with a visible reason and never
  // rewrites the prompt.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("deploy the app");
  await openAddMenu(page);
  const shellRow = menuItem(page, "Shell command");
  assert.equal(await shellRow.getAttribute("aria-disabled"), "true");
  assert.equal(
    await shellRow.locator(".add-menu-reason").innerText(),
    "Clear the draft before entering shell mode.",
  );
  // force: Playwright's actionability treats aria-disabled as not enabled;
  // the raw click still reaches the app's own guard.
  await shellRow.click({ force: true });
  assert.equal(await input.inputValue(), "deploy the app", "draft is never reinterpreted");
  await page.keyboard.press("Escape");
  await closePage(page);
});

test("github link: mismatch reports the exact error with no pill; a match creates a link-only pill", async () => {
  const page = await openApp();
  const before = await eventCount(SESSIONS.main);

  await openAddMenu(page);
  await menuItem(page, "Link GitHub issue or pull request…").click();
  await page.waitForSelector(".github-link-dialog", { state: "visible" });
  const url = page.locator(".github-link-dialog input[type='url']");

  // Mismatched repository: no pill, exact bounded error, input preserved.
  await url.fill("https://github.com/other/lib/issues/3");
  await page.locator(".github-link-dialog button", { hasText: "Add link" }).click();
  await page.waitForSelector(".github-link-error", { state: "visible" });
  const err = await page.locator(".github-link-error").innerText();
  assert.ok(err.includes("other/lib"), "names the mismatched repository");
  assert.ok(err.includes(`${GH_OWNER}/${GH_NAME}`), "names this project's repository");
  assert.equal(await page.locator(".attachment-pill").count(), 0, "failure creates no pill");
  assert.equal(await url.inputValue(), "https://github.com/other/lib/issues/3");
  await shot(page, "github_mismatch_error.png");

  // Matching issue: dialog closes, one link-only pill, honest attachment note.
  const match = `https://github.com/${GH_OWNER}/${GH_NAME}/issues/12`;
  await url.fill(match);
  await page.locator(".github-link-dialog button", { hasText: "Add link" }).click();
  await page.waitForSelector(".github-link-dialog", { state: "detached" });
  await page.waitForSelector(".attachment-pill.att-url", { state: "visible" });
  const pill = page.locator(".attachment-pill.att-url");
  assert.equal(await pill.count(), 1, "exactly one link pill");
  const name = pill.locator(".att-name");
  assert.equal((await name.innerText()).trim(), "Issue #12", "pill is the reference only — no issue body");
  assert.equal(await name.getAttribute("title"), match, "pill detail is the sanitized URL");
  await pill.locator(".att-remove").waitFor({ state: "visible" });
  assert.equal(
    (await page.locator(".composer-attach-note").innerText()).trim(),
    "Attachment compatibility is not reported by this provider",
  );
  await shot(page, "github_pill_and_note.png");

  assert.equal(await eventCount(SESSIONS.main), before, "unsent pills append no session event");
  await closePage(page);
});

test("voice: availability is truthful and named for preference-off and unsupported states", async () => {
  // Preference off (voice prefs record).
  const prefOff = await openApp({ storage: { "polyth.voice": JSON.stringify({ dictation: false }) } });
  await prefOff.waitForSelector(".mic-control", { state: "visible" });
  assert.equal((await prefOff.locator(".mic-status").innerText()).trim(), "Dictation is off");
  assert.equal(await prefOff.locator(".mic-btn").isDisabled(), true);
  await closePage(prefOff);

  // Browser without the Web Speech API.
  const unsupported = await openApp({ speech: "none" });
  await unsupported.waitForSelector(".mic-control", { state: "visible" });
  assert.equal(
    (await unsupported.locator(".mic-status").innerText()).trim(),
    "Dictation is not supported in this browser",
  );
  assert.equal(await unsupported.locator(".mic-btn").isDisabled(), true);
  await shot(unsupported, "voice_unsupported.png");
  await closePage(unsupported);
});

test("voice lifecycle: listening and failure are visible; transcripts stay drafts and never auto-send", async () => {
  const page = await openApp({ speech: "fake" });
  const before = await eventCount(SESSIONS.main);
  await page.waitForSelector(".mic-btn:not([disabled])", { state: "visible" });
  assert.equal(await page.locator(".mic-control").count(), 1, "exactly one mic slot");

  // Start: the icon button exposes its state through its accessible name and status.
  await page.locator(".mic-btn").click();
  await page.waitForSelector(".mic-control.mic-listening", { state: "visible" });
  assert.equal((await page.locator(".mic-status").innerText()).trim(), "Listening…");
  assert.equal(await page.locator(".mic-btn").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".mic-btn .mic-label").count(), 0, "dictation control stays icon-only");
  // One polite announcement carries the transition (textContent: the region
  // is visually hidden, so innerText reports empty).
  await page.waitForFunction(() =>
    [...document.querySelectorAll("[aria-live='polite']")]
      .some((region) => region.textContent?.includes("Listening…")));
  await shot(page, "voice_listening.png");

  // A final result becomes draft text only — no send, no session event.
  await page.evaluate(() => {
    (window as unknown as { __speech: { emitResult: (t: string) => void } })
      .__speech.emitResult("synthetic dictated draft");
  });
  await page.waitForFunction(() =>
    (document.querySelector(".composer-editor") as HTMLTextAreaElement | null)?.value
      .includes("synthetic dictated draft"));

  // Stop returns to idle with the draft intact; nothing was sent.
  await page.locator(".mic-btn").click();
  await page.waitForSelector(".mic-control.mic-idle", { state: "visible" });
  assert.ok((await editor(page).inputValue()).includes("synthetic dictated draft"));
  assert.equal(await eventCount(SESSIONS.main), before, "dictation never sends or appends");

  // Forced failure: visible bounded reason plus recovery routes.
  await page.locator(".mic-btn").click();
  await page.waitForSelector(".mic-control.mic-listening", { state: "visible" });
  await page.evaluate(() => {
    (window as unknown as { __speech: { emitError: (c: string) => void } })
      .__speech.emitError("synthetic-error");
  });
  await page.waitForSelector(".mic-control.mic-failed", { state: "visible" });
  assert.equal((await page.locator(".mic-status").innerText()).trim(), "Dictation failed: synthetic-error");
  await page.waitForSelector(".mic-retry", { state: "visible" });
  await page.waitForSelector(".mic-settings", { state: "visible" });
  await shot(page, "voice_failed.png");

  // Idempotent registration: a full reload still yields exactly one slot.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".mic-control", { state: "visible" });
  assert.equal(await page.locator(".mic-control").count(), 1, "remount never duplicates the slot");
  await closePage(page);
});

test("selectors: truthful model and agent names with per-session model persistence", async () => {
  const page = await openApp();

  // Model picker: current value in the accessible name; quiet rows, details on hover.
  const modelChip = page.locator(".picker-model .model-picker-trigger");
  assert.ok((await modelChip.getAttribute("aria-label"))?.startsWith("Select model, current "));
  await modelChip.click();
  await page.waitForSelector(".model-pop", { state: "visible" });
  const row = page.locator(".model-picker-row", { hasText: "Fable Mini" });
  assert.equal(await row.locator(".model-picker-copy small").innerText(), "Text · 128K");
  await row.hover();
  await page.waitForSelector(".model-hover-card .model-details", { state: "visible" });
  assert.ok((await page.locator(".model-hover-card").innerText()).includes("Context window"));
  await shot(page, "model_picker_truth.png");

  // Selecting the model persists the per-session pending configuration.
  await row.click();
  await page.waitForSelector(".model-pop", { state: "detached" });
  const stored = await page.evaluate((key) => localStorage.getItem(key),
    `polyth.composer.config.v1.${SESSIONS.main}`);
  assert.ok(stored, "explicit selection stored per session");
  assert.deepEqual(JSON.parse(stored!).model, { providerID: "synthetic", modelID: "fable-mini" });

  // Reload restores the exact same pending selection.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".picker-model .model-picker-trigger", { state: "visible" });
  assert.equal(
    await page.locator(".picker-model .model-picker-trigger").getAttribute("aria-label"),
    "Select model, current Fable Mini",
  );

  // The current agent mode is named and opens the canonical listbox.
  const agentChip = page.locator(".composer-agent-chip .picker-chip");
  assert.equal(await agentChip.getAttribute("aria-label"), "Select agent mode, current Build");
  await agentChip.click();
  await page.waitForSelector(".picker-pop", { state: "visible" });
  assert.equal(await page.locator(".picker-pop [role='listbox']").getAttribute("aria-label"), "Agent");
  await page.keyboard.press("Escape");
  await closePage(page);
});

test("active turn: empty draft exposes Stop; a draft exposes queue delivery and stop menu", async () => {
  const page = await openApp({ session: SESSIONS.active });
  const stop = page.locator(".composer-actions .stop");
  await stop.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await stop.getAttribute("aria-label"), "Stop the current response");

  await editor(page).fill("Queued follow-up probe");
  await page.waitForSelector(".composer-delivery", { state: "visible", timeout: 15_000 });
  const delivery = page.locator(".composer-delivery");
  assert.equal((await delivery.textContent())?.trim(), "Queue");
  assert.equal(await delivery.getAttribute("aria-label"), "Queue message until the current response finishes");
  await page.locator(".composer-send-options").click();
  await page.waitForSelector("[role='menu']", { state: "visible" });
  assert.ok((await page.locator("[role='menu']").innerText()).includes("Stop without sending this draft"));
  await shot(page, "active_turn_delivery.png");
  await closePage(page);
});

test("phone geometry: ≥44px targets, in-bounds, nonoverlapping, center-hit; bounded Add menu", async () => {
  for (const width of [320, 390]) {
    const page = await openApp({ width, height: 900, session: SESSIONS.active });
    await page.waitForSelector(".composer-actions .stop", { state: "visible" });

    const targets: Array<[string, string]> = [
      ["Add", ".composer-add-trigger"],
      ["model", ".model-picker-trigger"],
      ["voice", ".mic-btn"],
      ["stop", ".composer-actions .stop"],
    ];
    const boxes: Array<{ name: string; x: number; y: number; w: number; h: number }> = [];
    for (const [name, sel] of targets) {
      const box = await page.locator(sel).boundingBox();
      assert.ok(box, `${name} @${width} has a box`);
      assert.ok(box!.width >= 44 && box!.height >= 44,
        `${name} @${width} is ≥44px (${Math.round(box!.width)}×${Math.round(box!.height)})`);
      assert.ok(box!.x >= 0 && box!.x + box!.width <= width, `${name} @${width} in horizontal bounds`);
      assert.ok(box!.y >= 0 && box!.y + box!.height <= 900, `${name} @${width} in vertical bounds`);
      // Center hit-test resolves to the control or a descendant — never a
      // covering layer.
      const hitsSelf = await page.evaluate(([s, cx, cy]) => {
        const el = document.querySelector(s as string);
        const hit = document.elementFromPoint(cx as number, cy as number);
        return !!el && !!hit && (el === hit || el.contains(hit));
      }, [sel, box!.x + box!.width / 2, box!.y + box!.height / 2] as const);
      assert.ok(hitsSelf, `${name} @${width} center hit-tests to itself`);
      boxes.push({ name, x: box!.x, y: box!.y, w: box!.width, h: box!.height });
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!overlap, `${a.name} and ${b.name} do not overlap @${width}`);
      }
    }

    const configOverflow = await page.locator(".composer-config").evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    assert.ok(configOverflow.clientWidth > 0, `config controls retain a visible lane @${width}`);
    if (width === 320) {
      assert.ok(
        configOverflow.scrollWidth > configOverflow.clientWidth,
        "the narrowest config lane scrolls instead of painting under actions",
      );
    }

    // The Add menu is viewport-bounded (≤ width − 16), contains focus, and
    // keeps its first operable row inside the visible area.
    await openAddMenu(page);
    await page.waitForFunction(() => document.activeElement?.closest(".sheet") !== null);
    const menuBox = await addMenu(page).boundingBox();
    assert.ok(menuBox, `menu box @${width}`);
    assert.ok(menuBox!.width <= width - 16, `menu ≤ viewport−16 @${width} (${Math.round(menuBox!.width)})`);
    assert.ok(menuBox!.x >= 0 && menuBox!.x + menuBox!.width <= width, `menu in bounds @${width}`);
    const sheetState = await page.evaluate(() => {
      const first = document.querySelector<HTMLElement>("#composer-add-menu [role='menuitem']");
      const r = first?.getBoundingClientRect();
      return {
        focusInside: document.activeElement?.closest(".sheet") !== null,
        firstRow: r ? { top: r.top, bottom: r.bottom } : null,
      };
    });
    assert.equal(sheetState.focusInside, true, `the phone sheet contains initial focus @${width}`);
    assert.ok(sheetState.firstRow, `the first menu row is mounted @${width}`);
    assert.ok(
      sheetState.firstRow!.top >= 0 && sheetState.firstRow!.bottom <= 900,
      `the first menu row is visible @${width}`,
    );
    if (width === 320) await shot(page, "phone_320_add_menu.png");
    await page.keyboard.press("Escape");
    await closePage(page);
  }
});

test("coarse pointer: the 44px target contract holds at desktop width", async () => {
  const page = await openApp({ coarse: true, session: SESSIONS.active });
  const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  assert.equal(coarse, true, "touch emulation reports a coarse pointer");
  await page.waitForSelector(".composer-actions .stop", { state: "visible" });
  for (const [name, sel] of [
    ["Add", ".composer-add-trigger"],
    ["voice", ".mic-btn"],
  ] as const) {
    const box = await page.locator(sel).boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44,
      `${name} is ≥44px at coarse pointer (${Math.round(box?.width ?? 0)}×${Math.round(box?.height ?? 0)})`);
  }
  await closePage(page);
});

test("sequential focus order: editor → Add → selectors → voice → primary action", async () => {
  const page = await openApp();
  // A nonempty draft makes the primary action operable (a disabled Send is
  // rightly skipped by sequential focus).
  await editor(page).click();
  await page.keyboard.type("focus order probe");
  const visited: string[] = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    // Signature carries the wrapping .picker classes: the trigger button
    // itself is a plain chip.
    const cls = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "";
      return `${el.className} ${(el.closest(".picker") as HTMLElement | null)?.className ?? ""}`;
    });
    visited.push(cls);
  }
  const order = [
    "composer-add-trigger", "picker-model", "composer-agent-chip", "mic-btn", "send",
  ];
  let at = -1;
  for (const marker of order) {
    const found = visited.findIndex((c, i) => i > at && c.includes(marker));
    assert.ok(found > at, `${marker} is reached in order (visited: ${visited.join(" | ")})`);
    at = found;
  }
  await closePage(page);
});
