// UX-PERSONAS live interaction gates. Bundles the real app, serves it from an
// isolated fixture server (stub REST + silent /ws; every write is recorded),
// and drives a real Chromium through the journeys in the spec:
// first-run sequencing, the optional unselected setup, preview==post-apply,
// the all-capabilities/search invariant per preset, Plan's plain first layer,
// dynamic capability registration, persistence across switch/clear/reload,
// keyboard interaction, the required viewports, and the event-log invariant.
//
// Requires an installed Chromium (POLYTH_CHROMIUM_PATH or a well-known path);
// the whole test skips when none exists. Screenshots are written to
// $POLYTH_LIVE_ARTIFACTS when set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  STARTER_LABELS, WORKSPACE_PRESETS, PRESET_STORE_KEY, PRESENTATION_STORE_KEY,
  type WorkspacePresetId,
} from "../src/workspacePresets.ts";
import { BUILTIN_CAPABILITY_META } from "../src/capabilities.ts";

const CHROMIUM_CANDIDATES = [
  process.env.POLYTH_CHROMIUM_PATH ?? "",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].filter(Boolean);

async function findChromium(): Promise<string | null> {
  for (const p of CHROMIUM_CANDIDATES) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
}

// ---- fixture data ---------------------------------------------------------------

const PROJECT = { id: "p1", path: "/tmp/demo-project", name: "Demo project", createdAt: 1 };
const MODELS = [{ providerID: "test", modelID: "m1", name: "Test Model", context: 128000, connected: true }];
const AGENTS = [{ name: "build", mode: "primary" }];

interface Fixture {
  server: Server;
  url: string;
  state: { projects: object[]; failBoot: boolean };
  /** Every non-GET /api request seen — the event-log invariant checks it. */
  writes: Array<{ method: string; url: string }>;
  close: () => Promise<void>;
}

async function buildBundle(): Promise<string> {
  const { build } = await import("esbuild");
  const out = await mkdtemp(join(tmpdir(), "polyth-live-"));
  const here = new URL(".", import.meta.url).pathname;
  await build({
    entryPoints: [join(here, "../src/main.tsx")],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    minify: false,
    sourcemap: false,
    outfile: join(out, "bundle.js"),
    loader: { ".css": "css" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  return out;
}

async function startFixture(dist: string): Promise<Fixture> {
  const here = new URL(".", import.meta.url).pathname;
  const html = await readFile(join(here, "../src/index.html"), "utf8");
  const js = await readFile(join(dist, "bundle.js"));
  const css = await readFile(join(dist, "bundle.css"));
  const state = { projects: [PROJECT] as object[], failBoot: false };
  const writes: Array<{ method: string; url: string }> = [];

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (code: number, body: string, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(body);
    };
    if (url.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writes.push({ method: req.method ?? "?", url });
        return send(404, "{}");
      }
      if (url.startsWith("/api/auth/status")) return send(200, JSON.stringify({ required: false, authorized: true }));
      if (url.startsWith("/api/projects")) {
        return state.failBoot ? send(500, "{}") : send(200, JSON.stringify(state.projects));
      }
      if (url.startsWith("/api/models")) return send(200, JSON.stringify(MODELS));
      if (url.startsWith("/api/agents")) return send(200, JSON.stringify(AGENTS));
      if (url.startsWith("/api/sessions")) return send(200, "[]");
      if (url.startsWith("/api/git/status")) {
        return send(200, JSON.stringify({ branch: "main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [] }));
      }
      if (url.startsWith("/api/search/workspaces")) return send(200, JSON.stringify({ items: [] }));
      return send(404, "{}");
    }
    // Relative asset paths must resolve from history-routed URLs (/p/:id/…) too.
    if (/\/bundle\.js(\?|$)/.test(url)) return send(200, js.toString(), "text/javascript");
    if (/\/bundle\.css(\?|$)/.test(url)) return send(200, css.toString(), "text/css");
    // History-routed app URLs (/p/:id …) fall through to the shell page.
    return send(200, html, "text/html");
  });
  // Accept /ws so the sync client settles; never push an event.
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", () => { /* silent */ });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    state,
    writes,
    close: () => new Promise((resolve) => { wss.close(); server.close(() => resolve()); }),
  };
}

// ---- expectations from the schema (the same single source the app uses) -----------

const META = new Map(BUILTIN_CAPABILITY_META.map((m) => [m.id, m]));
const labelOf = (id: string): string => META.get(id)?.label ?? id;

function expectedPrimary(presetId: WorkspacePresetId | null): string[] {
  const preset = WORKSPACE_PRESETS.find((p) => p.id === presetId);
  if (!preset) {
    return BUILTIN_CAPABILITY_META
      .filter((m) => m.standardTier === "primary")
      .sort((a, b) => a.standardRank - b.standardRank)
      .map((m) => m.label);
  }
  return preset.placements
    .filter((p) => p.tier === "primary")
    .sort((a, b) => a.rank - b.rank)
    .map((p) => labelOf(p.capabilityId));
}

function expectedStarters(presetId: WorkspacePresetId | null): string[] {
  const preset = WORKSPACE_PRESETS.find((p) => p.id === presetId);
  const ids = preset?.starterIds ?? ["explore-project", "explain-here", "plan-next-step", "review-recent-work", "help-get-started"];
  return ids.map((id) => STARTER_LABELS[id] ?? id);
}

// ---- the gates --------------------------------------------------------------------

const chromiumPath = await findChromium();

test("UX-PERSONAS live gates", { skip: chromiumPath === null ? "no Chromium executable available" : false }, async (t) => {
  const [{ chromium }, dist] = await Promise.all([import("playwright-core"), buildBundle()]);
  const fixture = await startFixture(dist);
  const browser = await chromium.launch({
    executablePath: chromiumPath!,
    headless: true,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
  });
  const artifactsDir = process.env.POLYTH_LIVE_ARTIFACTS ?? null;
  if (artifactsDir) await mkdir(artifactsDir, { recursive: true });

  interface OpenOpts {
    width?: number;
    height?: number;
    deviceScaleFactor?: number;
    reducedMotion?: "reduce" | "no-preference";
    /** Seed localStorage before any script runs (empty = true first run). */
    seed?: Record<string, string>;
  }
  type Page = import("playwright-core").Page;
  const withPage = async (opts: OpenOpts, fn: (page: Page) => Promise<void>): Promise<void> => {
    const context = await browser.newContext({
      viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 },
      deviceScaleFactor: opts.deviceScaleFactor ?? 1,
      reducedMotion: opts.reducedMotion ?? "no-preference",
      serviceWorkers: "block",
    });
    try {
      if (opts.seed) {
        await context.addInitScript((entries: Array<[string, string]>) => {
          for (const [k, v] of entries) localStorage.setItem(k, v);
        }, Object.entries(opts.seed));
      }
      const page = await context.newPage();
      await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".app", { timeout: 15_000 });
      await fn(page);
    } finally {
      await context.close();
    }
  };

  const seedCompleted = (presetId: WorkspacePresetId | null): Record<string, string> => ({
    [PRESET_STORE_KEY]: JSON.stringify({ version: 1, setup: "completed", presetId, composerDetail: null, moreToolsOpen: false }),
    [PRESENTATION_STORE_KEY]: JSON.stringify({ version: 1, placements: {}, starterOrder: null }),
  });

  const shot = async (page: import("playwright-core").Page, name: string) => {
    if (!artifactsDir) return;
    await page.screenshot({ path: join(artifactsDir, name), type: "jpeg", quality: 70 });
  };

  const assertNoReactCrash = async (page: import("playwright-core").Page) => {
    const errs = await page.evaluate(() => (window as unknown as { __errs: string[] }).__errs);
    const crashes = errs.filter((e) => /minified react error|uncaught|is not a function|cannot read/i.test(e));
    assert.deepEqual(crashes, [], "no runtime crashes during the journey");
  };

  /** Header primary order (aria-labels of icon buttons, before More tools). */
  const headerPrimary = (page: import("playwright-core").Page) =>
    page.$$eval(".view-switcher .view-icon", (els) => els.map((e) => e.getAttribute("aria-label") ?? ""));

  const starterChips = async (page: import("playwright-core").Page) =>
    (await page.$$eval(".starter-chips .chip", (els) => els.map((e) => e.textContent?.trim() ?? "")))
      .map((s) => s.replace(/^[^\p{L}\p{N}]+/u, "")); // decorative ✦ glyph is not copy

  /** Open the header More tools popup (idempotent) with Technical expanded. */
  const openMoreTools = async (page: import("playwright-core").Page) => {
    const trigger = page.locator(".view-switcher .more-tools-trigger");
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
    await page.waitForSelector(".view-switcher .more-tools-popup", { timeout: 5_000 });
    const tech = page.locator(".view-switcher .more-tools-group-head");
    if (await tech.count() > 0 && await tech.getAttribute("aria-expanded") !== "true") await tech.click();
  };

  const moreToolsLabels = async (page: import("playwright-core").Page): Promise<string[]> =>
    (await page.$$eval(
      ".view-switcher .more-tools-popup .more-tools-item > span:first-child",
      (els) => els.map((e) => e.textContent ?? ""),
    )).map((s) => s.replace(/\s*\(.*\)\s*$/, "").trim());

  const paletteFind = async (page: import("playwright-core").Page, query: string): Promise<string[]> => {
    await page.keyboard.press("Control+KeyK");
    await page.waitForSelector(".palette-input", { timeout: 5_000 });
    await page.fill(".palette-input", query);
    const labels = await page.$$eval(".palette-item .palette-label", (els) => els.map((e) => e.textContent?.trim() ?? ""));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".palette-input", { state: "detached", timeout: 5_000 });
    return labels;
  };

  // ---- gate 1: shell / recovery before any preset choice -----------------------

  await t.test("first run reaches project setup and runtime recovery without a preset", async () => {
    fixture.state.projects = [];
    await withPage({}, async (page) => {
      // The shell is mounted; the project picker is offered; preset setup never covers it.
      await page.waitForSelector(".modal, [role=dialog]", { timeout: 10_000 });
      assert.equal(await page.locator(".preset-setup").count(), 0, "no preset setup before a usable project");
      assert.ok(await page.locator(".app").isVisible(), "shell renders with no project");
    });
    fixture.state.projects = [PROJECT];
    fixture.state.failBoot = true;
    await withPage({}, async (page) => {
      await page.waitForSelector(".error-banner", { timeout: 10_000 });
      assert.equal(await page.locator(".preset-setup").count(), 0, "no preset setup over a runtime error");
      // Recovery: the backend comes back; a reload reaches the ready workspace
      // and only then offers the optional setup.
      fixture.state.failBoot = false;
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".preset-setup", { timeout: 10_000 });
    });
  });

  // ---- gate 2: optional unselected setup, Skip a11y ------------------------------

  await t.test("setup opens with no selection; Skip is named, big enough, and keyboard reachable", () => withPage({}, async (page) => {
    await page.waitForSelector(".preset-setup", { timeout: 10_000 });
    assert.equal(await page.locator(".preset-card").count(), 4, "three presets + No preset");
    assert.equal(await page.locator(".preset-card[aria-pressed='true']").count(), 0, "no default selection");
    assert.equal(
      await page.locator("#preset-setup-heading").textContent(),
      "What should Polyth put within easy reach?",
    );
    const skip = page.locator(".preset-skip");
    assert.equal(await skip.textContent(), "Skip for now");
    const box = await skip.boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 44, `Skip is ≥44×44 (got ${box?.width}×${box?.height})`);
    // Keyboard reachable from the dialog itself.
    let reached = false;
    for (let i = 0; i < 30 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.classList.contains("preset-skip") ?? false);
    }
    assert.ok(reached, "Tab reaches Skip");
    await shot(page, "setup_unselected_skip_1280.jpeg");
  }));

  // ---- gate 3: preview matches post-apply for every card -------------------------

  await t.test("each card's preview equals the post-apply arrangement", async () => {
    const cases: Array<{ card: string; presetId: WorkspacePresetId | null; confirm: string }> = [
      { card: "Build & debug", presetId: "build-debug", confirm: "Use Build & debug preset" },
      { card: "Plan & coordinate", presetId: "plan-coordinate", confirm: "Use Plan & coordinate preset" },
      { card: "Design & explore", presetId: "design-explore", confirm: "Use Design & explore preset" },
      { card: "No preset", presetId: null, confirm: "Continue without a preset" },
    ];
    for (const c of cases) {
      await withPage({}, async (page) => {
      await page.waitForSelector(".preset-setup", { timeout: 10_000 });
      await page.locator(".preset-card", { hasText: c.card }).first().click();
      assert.equal(
        await page.locator(".preset-card", { hasText: c.card }).first().getAttribute("aria-pressed"),
        "true", `${c.card} becomes the draft selection`,
      );
      const preview = await page.locator(".preset-preview-text").textContent() ?? "";
      const promisedStarters = expectedStarters(c.presetId);
      const promisedPrimary = expectedPrimary(c.presetId).filter((l) => l !== "Chat");
      if (c.presetId !== null) {
        for (const label of promisedPrimary) assert.ok(preview.includes(label), `${c.card} preview names ${label}`);
        assert.ok(preview.includes(promisedStarters.join(", ")), `${c.card} preview lists the starter order`);
      } else {
        assert.ok(preview.includes("matches your current arrangement"), "No preset promises no changes on first run");
      }
      assert.ok(preview.includes("It will not remove tools, change access, or change how Polyth responds."));
      await page.locator(".preset-confirm", { hasText: c.confirm }).click();
      await page.waitForSelector(".preset-setup", { state: "detached", timeout: 5_000 });

      // Post-apply: primary order, starter order, and composer detail match.
      assert.deepEqual(await headerPrimary(page), expectedPrimary(c.presetId), `${c.card} primary order`);
      assert.deepEqual(await starterChips(page), promisedStarters, `${c.card} starter order`);
      const wantTech = c.presetId === "build-debug" ? "true" : "false";
      assert.equal(
        await page.locator(".composer-tech-toggle").getAttribute("aria-expanded"),
        wantTech, `${c.card} composer detail`,
      );
      const record = JSON.parse(await page.evaluate(
        (k: string) => localStorage.getItem(k) ?? "{}", PRESET_STORE_KEY,
      ) as string);
      assert.equal(record.presetId, c.presetId, `${c.card} persisted exactly`);
      assert.equal(record.setup, "completed");
      if (c.presetId !== null) {
        const live = await page.locator("[role='status']").textContent();
        assert.ok(live?.includes("applied"), "apply is announced to the live region");
      }
      await assertNoReactCrash(page);
      });
    }
  });

  // ---- gate 4: every capability reachable + searchable per preset -----------------

  await t.test("every built-in capability is in primary nav or More tools, and in command search, for every preset", async () => {
    const presets: Array<WorkspacePresetId | null> = [null, "build-debug", "plan-coordinate", "design-explore"];
    for (const presetId of presets) {
      await withPage({ seed: seedCompleted(presetId) }, async (page) => {
      await page.waitForSelector(".view-switcher", { timeout: 10_000 });
      const header = await headerPrimary(page);
      await openMoreTools(page);
      const more = await moreToolsLabels(page);
      for (const meta of BUILTIN_CAPABILITY_META) {
        assert.ok(
          header.includes(meta.label) || more.includes(meta.label),
          `${meta.label} reachable under ${presetId ?? "no preset"} (header: ${header.join("|")}; more: ${more.join("|")})`,
        );
      }
      if (presetId === null) await shot(page, "all_capabilities_more_tools.jpeg");
      await page.keyboard.press("Escape");

      for (const meta of BUILTIN_CAPABILITY_META) {
        const found = await paletteFind(page, meta.label);
        assert.ok(found.includes(meta.label), `"${meta.label}" found in command search under ${presetId ?? "no preset"}`);
      }
      // Old technical names still find the same tools.
      assert.ok((await paletteFind(page, "Multi-Run")).includes("Compare responses"));
      assert.ok((await paletteFind(page, "git")).includes("Source control"));
      await assertNoReactCrash(page);
      });
    }

    // Under the standard arrangement, actually open every capability.
    await withPage({ seed: seedCompleted(null) }, async (page) => {
    await page.waitForSelector(".view-switcher", { timeout: 10_000 });
    for (const meta of BUILTIN_CAPABILITY_META) {
      const inHeader = (await headerPrimary(page)).includes(meta.label);
      if (inHeader) {
        await page.locator(`.view-switcher .view-icon[aria-label='${meta.label}']`).click();
      } else {
        await openMoreTools(page);
        const item = page.locator(".view-switcher .more-tools-item", { hasText: meta.label }).first();
        if (await item.isDisabled()) continue; // unavailable: present with a reason, not clickable
        await item.click();
      }
      // Settings-page capabilities open the settings modal; close it again.
      if (await page.locator(".settings-shell").count() > 0) await page.keyboard.press("Escape");
      assert.equal(await page.locator(".preset-setup").count(), 0);
    }
    const shotPage = await paletteFind(page, "terminal");
    assert.ok(shotPage.includes("Terminal"));
    await page.keyboard.press("Control+KeyK");
    await page.fill(".palette-input", "terminal");
    await shot(page, "capability_search_invariant.jpeg");
    await page.keyboard.press("Escape");
    await assertNoReactCrash(page);
    });
  });

  // ---- gate 5: Plan's plain first layer + Technical options reach everything ------

  await t.test("Plan & coordinate: plain first layer; Technical options reach the technical tools", () => withPage({ seed: seedCompleted("plan-coordinate") }, async (page) => {
    await page.waitForSelector(".view-switcher", { timeout: 10_000 });
    // First layer: no syntax help, technical pickers closed, plain starters.
    assert.equal(await page.locator(".composer-tech-help").count(), 0, "no !/#/@ syntax in the plain layer");
    assert.equal(await page.locator(".composer-tech-toggle").getAttribute("aria-expanded"), "false");
    assert.deepEqual(await starterChips(page), expectedStarters("plan-coordinate"));
    assert.deepEqual(await headerPrimary(page), expectedPrimary("plan-coordinate"));
    await shot(page, "plan_plain_first_layer.jpeg");

    // The named disclosure reveals model/agent pickers and command syntax.
    await page.locator(".composer-tech-toggle").click();
    assert.equal(await page.locator(".composer-tech-toggle").getAttribute("aria-expanded"), "true");
    await page.waitForSelector(".composer-tech-help", { timeout: 5_000 });
    const help = await page.locator(".composer-tech-help").textContent() ?? "";
    for (const glyph of ["!", "/", "#", "@"]) assert.ok(help.includes(glyph), `syntax help mentions ${glyph}`);
    await shot(page, "plan_technical_options_open.jpeg");

    // More tools → Technical options group: source control, terminal,
    // models & agents, event log, diagnostics all reachable.
    await openMoreTools(page);
    const more = await moreToolsLabels(page);
    for (const label of ["Source control", "Terminal", "Models & agents", "Event log", "Extension diagnostics"]) {
      assert.ok(more.includes(label), `${label} reachable from Plan via Technical options`);
    }
    await page.locator(".view-switcher .more-tools-item", { hasText: "Source control" }).click();
    await page.waitForSelector(".view-title", { timeout: 5_000 });
    assert.match(await page.locator(".view-title").textContent() ?? "", /Git/, "source control view opens");
    await assertNoReactCrash(page);
  }));

  // ---- gate 6: dynamic capability registration ------------------------------------

  await t.test("a dynamically registered capability appears in More tools and search without touching preset state", () => withPage({ seed: seedCompleted(null) }, async (page) => {
    await page.waitForSelector(".view-switcher", { timeout: 10_000 });
    const before = await page.evaluate((k: string) => localStorage.getItem(k), PRESET_STORE_KEY);

    await page.evaluate(() => {
      const api = (window as unknown as { __polythCapabilities: { registerCapability: (d: object) => () => void } }).__polythCapabilities;
      (window as unknown as { __disposeFake: () => void }).__disposeFake = api.registerCapability({
        id: "fake-tool", label: "Fake tool", plainDescription: "A test extension.",
        keywords: ["fake"], standardTier: "more", standardRank: 99,
        open: () => {}, available: () => true,
      });
    });
    await openMoreTools(page);
    assert.ok((await moreToolsLabels(page)).includes("Fake tool"), "registered capability appears in More tools");
    await page.keyboard.press("Escape");
    assert.ok((await paletteFind(page, "Fake tool")).includes("Fake tool"), "registered capability is searchable");

    await page.evaluate(() => (window as unknown as { __disposeFake: () => void }).__disposeFake());
    await openMoreTools(page);
    assert.ok(!(await moreToolsLabels(page)).includes("Fake tool"), "disposed capability vanishes");
    await page.keyboard.press("Escape");

    await page.evaluate(() => {
      const api = (window as unknown as { __polythCapabilities: { registerCapability: (d: object) => () => void } }).__polythCapabilities;
      api.registerCapability({
        id: "fake-tool", label: "Fake tool", plainDescription: "A test extension.",
        keywords: ["fake"], standardTier: "more", standardRank: 99,
        open: () => {}, available: () => true,
      });
    });
    await openMoreTools(page);
    assert.ok((await moreToolsLabels(page)).includes("Fake tool"), "re-registered capability reappears");
    await page.keyboard.press("Escape");

    const after = await page.evaluate((k: string) => localStorage.getItem(k), PRESET_STORE_KEY);
    assert.equal(after, before, "dynamic registration never changes preset state");
  }));

  // ---- gate 7: explicit choices survive switch/clear/reload; draft preserved ------

  await t.test("explicit disclosure survives preset switching, clearing, and reload; the draft is never lost", () => withPage({}, async (page) => {
    await page.waitForSelector(".preset-setup", { timeout: 10_000 });
    await page.locator(".preset-card", { hasText: "Build & debug" }).click();
    await page.locator(".preset-confirm").click();
    await page.waitForSelector(".preset-setup", { state: "detached", timeout: 5_000 });
    assert.equal(await page.locator(".composer-tech-toggle").getAttribute("aria-expanded"), "true");

    // Type a draft, then make an explicit plain choice.
    await page.fill(".composer-card textarea", "draft that must survive");
    await page.locator(".composer-tech-toggle").click();
    assert.equal(await page.locator(".composer-tech-toggle").getAttribute("aria-expanded"), "false");

    // Switch presets through the palette command.
    await page.keyboard.press("Control+KeyK");
    await page.fill(".palette-input", "Change workspace preset");
    await page.locator(".palette-item", { hasText: "Change workspace preset" }).click();
    await page.waitForSelector(".preset-setup", { timeout: 5_000 });
    await page.locator(".preset-card", { hasText: "Plan & coordinate" }).click();
    await page.locator(".preset-confirm").click();
    await page.waitForSelector(".preset-setup", { state: "detached", timeout: 5_000 });

    assert.equal(await page.inputValue(".composer-card textarea"), "draft that must survive", "draft intact across switch");
    assert.equal(await page.locator(".composer-tech-toggle").getAttribute("aria-expanded"), "false", "explicit plain wins over any preset");
    assert.deepEqual(await starterChips(page), expectedStarters("plan-coordinate"));

    // Reload: everything persisted exactly.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".view-switcher", { timeout: 10_000 });
    const record = JSON.parse(await page.evaluate((k: string) => localStorage.getItem(k) ?? "{}", PRESET_STORE_KEY) as string);
    assert.equal(record.presetId, "plan-coordinate");
    assert.equal(record.composerDetail, "plain");
    assert.equal(await page.locator(".composer-tech-toggle").getAttribute("aria-expanded"), "false");
    assert.deepEqual(await headerPrimary(page), expectedPrimary("plan-coordinate"));

    // Clear: back to the standard arrangement, explicit choices untouched.
    await page.keyboard.press("Control+KeyK");
    await page.fill(".palette-input", "Change workspace preset");
    await page.locator(".palette-item", { hasText: "Change workspace preset" }).click();
    await page.waitForSelector(".preset-setup", { timeout: 5_000 });
    await page.locator(".preset-card", { hasText: "No preset" }).click();
    await page.locator(".preset-confirm").click();
    await page.waitForSelector(".preset-setup", { state: "detached", timeout: 5_000 });
    assert.deepEqual(await headerPrimary(page), expectedPrimary(null));
    assert.equal(await page.locator(".composer-tech-toggle").getAttribute("aria-expanded"), "false", "explicit plain still wins");
    const cleared = JSON.parse(await page.evaluate((k: string) => localStorage.getItem(k) ?? "{}", PRESET_STORE_KEY) as string);
    assert.equal(cleared.presetId, null);
    assert.equal(cleared.composerDetail, "plain");
    await assertNoReactCrash(page);
  }));

  // ---- gate 8: keyboard interaction and focus -------------------------------------

  await t.test("keyboard: Space selects a draft card, Escape dismisses without writing a preset", () => withPage({}, async (page) => {
    await page.waitForSelector(".preset-setup", { timeout: 10_000 });
    // Tab to the first card (Skip, Close, then cards) and select with Space.
    let onCard = false;
    for (let i = 0; i < 30 && !onCard; i++) {
      await page.keyboard.press("Tab");
      onCard = await page.evaluate(() => document.activeElement?.classList.contains("preset-card") ?? false);
    }
    assert.ok(onCard, "Tab reaches the preset cards");
    await page.keyboard.press("Space");
    assert.equal(await page.locator(".preset-card[aria-pressed='true']").count(), 1, "Space makes a draft selection");
    assert.ok(await page.locator(".preset-preview").isVisible(), "preview appears for the draft");

    // Escape: dismissed, no preset written, focus lands back in the workspace.
    await page.keyboard.press("Escape");
    await page.waitForSelector(".preset-setup", { state: "detached", timeout: 5_000 });
    const record = JSON.parse(await page.evaluate((k: string) => localStorage.getItem(k) ?? "{}", PRESET_STORE_KEY) as string);
    assert.equal(record.setup, "completed");
    assert.equal(record.presetId, null, "Escape never writes a disguised default");
    const focusInDialog = await page.evaluate(() => !!document.activeElement?.closest(".preset-setup"));
    assert.equal(focusInDialog, false, "focus is not lost in a removed dialog");
    await assertNoReactCrash(page);
  }));

  // ---- gate 9: viewports ------------------------------------------------------------

  await t.test("every required viewport keeps the setup usable with no horizontal page scroll", async () => {
    const viewports: Array<{ w: number; h: number; dsf?: number; reduced?: boolean; shotName?: string }> = [
      { w: 1280, h: 900 },
      { w: 768, h: 900 },
      { w: 390, h: 844, shotName: "setup_unselected_skip_390.jpeg" },
      { w: 320, h: 844 },
      { w: 720, h: 450, dsf: 2 },
      { w: 1280, h: 900, reduced: true },
    ];
    for (const v of viewports) {
      await withPage({
        width: v.w, height: v.h, deviceScaleFactor: v.dsf ?? 1,
        reducedMotion: v.reduced ? "reduce" : "no-preference",
      }, async (page) => {
      await page.waitForSelector(".preset-setup", { timeout: 10_000 });
      const skip = page.locator(".preset-skip");
      assert.ok(await skip.isVisible(), `Skip visible at ${v.w}×${v.h}`);
      const box = await skip.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `Skip ≥44×44 at ${v.w}×${v.h}`);
      const noHScroll = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      );
      assert.ok(noHScroll, `no horizontal page scroll at ${v.w}×${v.h}`);
      assert.equal(await page.locator(".preset-card").count(), 4, `all cards present at ${v.w}×${v.h}`);
      if (v.shotName) await shot(page, v.shotName);
      if (v.w === 320) {
        await page.locator(".preset-card", { hasText: "Design & explore" }).click();
        await page.waitForSelector(".preset-preview", { timeout: 5_000 });
        await shot(page, "design_selected_320.jpeg");
      }
      });
    }
  });

  // ---- gate 10: the event-log invariant ----------------------------------------------

  await t.test("the whole journey never writes to the session event log", () => {
    const sessionWrites = fixture.writes.filter((w) => w.url.startsWith("/api/sessions"));
    assert.deepEqual(sessionWrites, [], "preset actions are presentation-local: no session API writes");
  });

  await browser.close();
  await fixture.close();
});
