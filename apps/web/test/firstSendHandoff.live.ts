// First-send handoff live gate. Creating a session from a new message must
// read as one continuous motion: the hero body fades before the transcript
// arrives, the transcript is never painted transparent, the reveal does not
// replay for the spawned id, the submitted prompt flies out of the composer,
// and the startup dock hands over to the live activity dock without a blank
// frame or a blink back to "Spawning agent…".
//
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --experimental-strip-types --test apps/web/test/firstSendHandoff.live.ts
//
// Self-booting: builds apps/web/dist when missing, creates a disposable Polyth
// data dir, claims it, and launches a synthetic `opencode` stand-in so no paid
// provider turn is ever made. Override with POLYTH_LIVE_URL to reuse a running
// fixture.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { createCanonicalSecurity } from "../../../packages/server/src/canonicalSecurity.ts";

const SELF_BOOT = !process.env.POLYTH_LIVE_URL;
const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? "/tmp/polyth-first-send-artifacts";
const PORT = Number(process.env.POLYTH_LIVE_PORT ?? 4471);
const BASE = (process.env.POLYTH_LIVE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const CHROMIUM_CANDIDATES = [
  process.env.POLYTH_CHROMIUM_PATH,
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
].filter((value): value is string => Boolean(value));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chromiumPath = async (): Promise<string> => {
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  throw new Error("No Chromium executable found; set POLYTH_CHROMIUM_PATH.");
};

let root = "";
let dataDir = "";
let homeDir = "";
let binDir = "";
let projectDir = "";
let projectId = "";
let serverProc: ChildProcess | undefined;
let browser: Browser | undefined;
const contexts: BrowserContext[] = [];

const startServer = (): void => {
  // The ambient shell may point at a real deployment; the isolated fixture must
  // not inherit its public origin, trusted proxies or operator debug access.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.POLYTH_PUBLIC_ORIGIN;
  delete env.POLYTH_DEBUG_AGENT_ACCESS;
  delete env.POLYTH_UI_PASSWORD;
  delete env.POLYTH_UI_PASSWORD_LOCALHOST;
  delete env.POLYTH_TRUSTED_PROXIES;
  Object.assign(env, {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_DATA_HOME: join(homeDir, ".local/share"),
    POLYTH_DATA_DIR: dataDir,
    POLYTH_DEPLOYMENT_PROFILE: "local-trusted",
    POLYTH_AGENT_BETA: "1",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    MSGACT_OC_SEED: join(dataDir, "oc-seed.json"),
    MSGACT_OC_STATE: join(dataDir, "oc-state.json"),
    MSGACT_TURN_DELAY_MS: "600",
    MSGACT_STREAM_STEP_MS: "250",
  });
  serverProc = spawn(process.execPath, ["packages/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (process.env.POLYTH_LIVE_SERVER_LOG) {
    serverProc.stdout?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
    serverProc.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  } else {
    serverProc.stdout?.resume();
    serverProc.stderr?.resume();
  }
};

const stopServer = async (): Promise<void> => {
  if (serverProc && serverProc.exitCode === null) {
    const exited = new Promise<void>((resolve) => serverProc!.once("exit", () => resolve()));
    serverProc.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
    if (serverProc.exitCode === null) serverProc.kill("SIGKILL");
  }
};

const waitHealthy = async (): Promise<void> => {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const health = await fetch(`${BASE}/api/health`).then((r) => r.json()) as { ok?: boolean };
      if (health.ok === true) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`${BASE} did not become healthy`);
    await sleep(250);
  }
};

const waitModels = async (): Promise<void> => {
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/models`);
      if (res.ok) {
        const catalog = await res.json() as unknown;
        if (Array.isArray(catalog) && catalog.length > 0) return;
      }
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error("model catalog never became ready");
    await sleep(250);
  }
};

async function claimInstallation(origin: string): Promise<void> {
  const security = createCanonicalSecurity({ dataDir, origin, localOnly: true });
  try {
    const claim = security.identity.setup.issueClaim();
    const binding = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    security.identity.setup.bindClaim(claim.token, binding);
    const recovery = security.identity.setup.prepareRecovery(claim.token, binding);
    await security.identity.setup.complete({
      claimToken: claim.token,
      browserBinding: binding,
      name: "First Send Gate",
      organizationName: "First Send Gate",
      login: `first-send-${randomUUID().slice(0, 8)}`,
      password: `FirstSend-${randomUUID()}-${randomUUID()}`,
      recoverySetId: recovery.setId,
      recoveryAcknowledged: true,
    });
  } finally {
    security.close();
  }
}

async function buildFixture(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "polyth-first-send-"));
  dataDir = join(root, "data");
  homeDir = join(root, "home");
  binDir = join(root, "bin");
  projectDir = join(root, "project");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "pipe" });
  await writeFile(join(projectDir, "README.md"), "# first-send gate fixture\n");
  execFileSync("git", ["-C", projectDir, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", projectDir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "seed"], { stdio: "pipe" });
  const fake = join(REPO_ROOT, "apps/web/test/msgActionsFakeBackend.mjs");
  const wrapper = join(binDir, "opencode");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  await chmod(wrapper, 0o755);
  // The control plane only bootstraps into an otherwise empty data root, so
  // claim it before writing the fake runtime's seed file.
  await claimInstallation(BASE);
  await writeFile(join(dataDir, "oc-seed.json"), JSON.stringify({ sessions: [], createdTurnBehaviors: {} }, null, 2));
}

/** Register the disposable project through the running server's own route. */
async function registerProject(): Promise<void> {
  const response = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectDir, name: basename(projectDir) || "First Send Gate" }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `project registration failed: ${body.slice(0, 240)}`);
  const parsed = JSON.parse(body) as { id?: unknown };
  assert.equal(typeof parsed.id, "string", "project registration returned no id");
  projectId = parsed.id as string;
}

interface Sample {
  t: number;
  stage: { o: string; leaving: string | null } | null;
  heroBody: { o: string } | null;
  conv: { o: string; firstSend: string | null } | null;
  tl: { o: string } | null;
  reveal: string | null;
  dock: { o: string } | null;
  dockText: string | null;
  prompt: { o: string; y: number } | null;
}

const SAMPLER = (): void => {
  const samples: Sample[] = [];
  (window as unknown as { __samples: Sample[] }).__samples = samples;
  const info = (el: Element | null) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { o: Number(cs.opacity).toFixed(2) };
  };
  const start = performance.now();
  const tick = () => {
    const q = (selector: string) => document.querySelector(selector);
    const stage = q(".stage-new");
    const conv = q(".focus-conversation");
    const dock = q(".agent-status-dock");
    samples.push({
      t: Math.round(performance.now()),
      stage: stage ? { o: getComputedStyle(stage).opacity, leaving: stage.getAttribute("data-leaving") } : null,
      heroBody: info(q(".hero-body")),
      conv: conv ? { o: getComputedStyle(conv).opacity, firstSend: conv.getAttribute("data-first-send") } : null,
      tl: info(q(".timeline-wrap")),
      reveal: document.documentElement.dataset.sessionReveal ?? null,
      dock: info(dock),
      dockText: dock?.textContent?.trim() ?? null,
      prompt: (() => {
        const el = q(".msg.user");
        if (!el) return null;
        return {
          o: Number(getComputedStyle(el).opacity).toFixed(2),
          y: Math.round(el.getBoundingClientRect().top),
        };
      })(),
    });
    if (performance.now() - start < 15_000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function openHero(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 } });
  contexts.push(context);
  await context.addInitScript(() => {
    localStorage.setItem("polyth.prefs", JSON.stringify({ persona: "engineer", plugins: [] }));
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/p/${projectId}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 20_000 });
  await page.waitForSelector(".composer-chat", { state: "visible", timeout: 20_000 });
  return page;
}

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  if (SELF_BOOT) {
    await buildFixture();
    if (!existsSync(join(REPO_ROOT, "apps/web/dist/index.html"))) {
      execFileSync(process.execPath, ["apps/web/buildPackages.ts"], { cwd: REPO_ROOT, stdio: "pipe" });
      execFileSync(process.execPath, ["apps/web/build.ts"], { cwd: REPO_ROOT, stdio: "pipe" });
    }
    startServer();
    await waitHealthy();
    await registerProject();
  } else {
    await waitHealthy();
    const projects = await fetch(`${BASE}/api/projects`).then((r) => r.json()) as
      | Array<{ id?: unknown }>
      | { projects?: Array<{ id?: unknown }> };
    const first = Array.isArray(projects) ? projects[0] : projects.projects?.[0];
    projectId = typeof first?.id === "string" ? first.id : "";
    assert.ok(projectId, "POLYTH_LIVE_URL must expose a project");
  }
  await waitModels();
  const pw = await import("playwright-core");
  browser = await pw.chromium.launch({ executablePath: await chromiumPath(), headless: true });
});

after(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopServer();
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

test("a first send never blanks the transcript, replays the reveal, or blinks the dock", async () => {
  assert.ok(browser, "browser launched");
  const page = await openHero(browser);
  // The runtime stand-in takes a moment to be ready; wait for a sendable draft.
  await page.waitForFunction(() => document.querySelectorAll(".rail-icon.strip-btn").length > 0, null, { timeout: 45_000 }).catch(() => undefined);
  await page.fill("textarea[data-composer-input]", "First-send handoff live gate prompt.");
  await page.waitForSelector(".composer-chat button.send:not([disabled])", { state: "visible", timeout: 60_000 });
  await page.waitForTimeout(150);
  await page.evaluate(SAMPLER);
  await page.waitForTimeout(80);
  // This gate asserts the startup-to-live handoff. A fast local fixture can
  // finish admission inside the hero hold and legitimately skip painting
  // startup altogether, so give that phase a controlled network delay.
  if (SELF_BOOT) await page.route("**/api/sessions", async (route) => {
    if (route.request().method() === "POST") await page.waitForTimeout(700);
    await route.continue();
  });
  await page.click(".composer-chat button.send");
  await page.waitForTimeout(6000);

  const samples = await page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples);
  const file = join(ARTIFACTS, "first-send-samples.json");
  await writeFile(file, JSON.stringify(samples, null, 1));

  assert.ok(samples.length > 5, `expected sampled frames, got ${samples.length}`);
  // The surface swapped from the hero to the transcript.
  assert.ok(samples.some((sample) => sample.stage && !sample.conv), "the hero was painted");
  assert.ok(samples.some((sample) => sample.conv && !sample.stage), "the transcript arrived");

  // The hero was held for a motion beat before the swap instead of cutting
  // away. The fade itself is the CSS transition pinned by the source test; the
  // painted value may fall between sampled frames on a busy send.
  const firstLeaving = samples.findIndex((sample) => sample.stage?.leaving === "true");
  const firstTranscript = samples.findIndex((sample) => sample.conv && !sample.stage);
  assert.ok(firstLeaving >= 0, "the hero was held with data-leaving across the handoff");
  assert.ok(firstTranscript > firstLeaving, "the transcript mounted only after the hero hold");

  // The transcript and its dock are never painted transparent on arrival.
  const transcriptOpacity = samples.filter((sample) => sample.conv).map((sample) => Number(sample.tl?.o ?? "1"));
  assert.ok(Math.min(...transcriptOpacity) >= 0.99, `transcript faded through blank: ${Math.min(...transcriptOpacity)}`);

  // The reveal for the spawned id never replays.
  assert.deepEqual([...new Set(samples.map((sample) => sample.reveal))].filter(Boolean), []);

  // The suppression attribute was present at the handoff.
  assert.ok(samples.some((sample) => sample.conv?.firstSend !== null && sample.conv?.firstSend !== undefined));

  // The prompt flew out of the composer: it appears low and rises to its
  // reading position, so the smallest painted top is above its first frame.
  const promptTops = samples.flatMap((sample) => sample.prompt ? [sample.prompt.y] : []);
  assert.ok(promptTops.length > 0, "the submitted prompt is on screen");
  assert.ok(
    Math.min(...promptTops) < promptTops[0]!,
    `the prompt never flew up out of the composer: ${promptTops.slice(0, 6).join(", ")}`,
  );

  // The dock never disappears during the startup→live swap, and the startup
  // copy never returns after the live activity dock has owned the zone.
  const dockFrames = samples.filter((sample) => sample.conv);
  assert.ok(dockFrames.some((sample) => sample.dockText?.includes("Spawning")), "the startup dock showed");
  const liveIndex = dockFrames.findIndex((sample) => sample.dockText && !sample.dockText.includes("Spawning"));
  assert.ok(liveIndex >= 0, "the live activity dock took over");
  assert.ok(
    !dockFrames.slice(liveIndex).some((sample) => sample.dockText?.includes("Spawning")),
    "the startup dock did not resurrect after the live dock",
  );
  assert.ok(
    dockFrames.slice(liveIndex).every((sample) => sample.dock === null || Number(sample.dock.o) >= 0.99),
    "the dock never blinked through transparent during the handover",
  );
});
