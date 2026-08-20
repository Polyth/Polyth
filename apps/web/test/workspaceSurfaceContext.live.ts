// EXT-SEAMS-S2-V1 live regression: workspace surfaces must receive the
// canonical { projectId, sessionId } context from WorkspaceHost in a real
// browser — for null ids (nothing active), non-null ids (a real project and
// session), and a late same-id replacement. This is the exact probe shape the
// verification used: register an active replacement through
// window.__polythWorkspaceSurfaces and capture the component's props.
//
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --test apps/web/test/workspaceSurfaceContext.live.ts
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
// Type-only: brings WorkspaceSurfaceContext and the Window augmentation for
// __polythWorkspaceSurfaces into scope. No runtime import — the page owns it.
import type { WorkspaceSurfaceContext } from "../src/workspace/surfaceRegistry.ts";

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

before(async () => {
  // Always rebuild so the bundle under test is the working tree, not a stale dist.
  await run(process.execPath, ["apps/web/build.ts"], REPO_ROOT);

  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const dataDir = await mkdtemp(join(tmpdir(), "polyth-ctx-live-data-"));
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

  const pw = await import("playwright-core");
  browser = await pw.chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
  });
}, { timeout: 120_000 });

after(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
  }
});

// Persona seed skips first-run onboarding deterministically (prefs contract).
const PERSONA_SEED = JSON.stringify({ persona: "engineer", plugins: [] });

async function openApp(path: string, ready: string): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addInitScript((seed: string) => {
    localStorage.setItem("polyth.prefs", seed);
  }, PERSONA_SEED);
  const page = await context.newPage();
  await page.goto(BASE + path, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(ready, { state: "visible", timeout: 15_000 });
  return page;
}

async function closePage(page: Page): Promise<void> {
  await page.context().close();
  const i = contexts.indexOf(page.context());
  if (i >= 0) contexts.splice(i, 1);
}

type CapturedCtx = Record<string, unknown>;

/** The verification probe: register an active replacement for the `session`
 *  surface (the default view) through the public plugin seam and capture the
 *  exact props object the host hands the component on every render. */
async function registerProbe(page: Page, key: string, marker: string): Promise<void> {
  await page.evaluate(([k, m]) => {
    const captured: CapturedCtx[] = [];
    (window as unknown as Record<string, CapturedCtx[]>)[k] = captured;
    window.__polythWorkspaceSurfaces?.registerWorkspaceSurface({
      id: "session",
      title: m,
      order: 0,
      component: (ctx: WorkspaceSurfaceContext) => {
        captured.push({ ...ctx });
        return `${m}:${String(ctx.projectId)}:${String(ctx.sessionId)}`;
      },
    });
  }, [key, marker] as const);
  await page.waitForSelector(`text=${marker}:`, { timeout: 10_000 });
}

const capturedCtx = (page: Page, key: string): Promise<CapturedCtx[]> =>
  page.evaluate((k) => (window as unknown as Record<string, CapturedCtx[]>)[k] ?? [], key);

// =============================================================================

test("live: a surface replacement receives explicit null canonical ids when nothing is active", { timeout: 60_000 }, async () => {
  // No project exists yet → the project empty state is showing.
  const page = await openApp("/", ".hero-open-project");
  try {
    await registerProbe(page, "__ctxProbeNull", "null-ctx-probe");
    const captured = await capturedCtx(page, "__ctxProbeNull");
    assert.ok(captured.length > 0, "probe component never rendered");
    // Before the repair this observed {} — the exact prop set is the contract.
    assert.deepEqual(captured.at(-1), { projectId: null, sessionId: null });
    assert.match(await page.locator(".app").innerText(), /null-ctx-probe:null:null/);
  } finally {
    await closePage(page);
  }
});

test("live: a surface receives real canonical ids, and a late replacement inherits them", { timeout: 180_000 }, async () => {
  // Real project + session through the public REST API (spawns the
  // per-project opencode runtime, hence the generous timeout).
  const projectDir = await mkdtemp(join(tmpdir(), "polyth-ctx-live-project-"));
  await writeFile(join(projectDir, "README.md"), "# ctx probe fixture\n");
  const project = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectDir, name: "ctx-probe" }),
  }).then((r) => r.json()) as { id: string };
  assert.ok(project.id, "project creation failed");
  const session = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id, title: "ctx probe" }),
  }).then((r) => r.json()) as { id: string };
  assert.ok(session.id, "session creation failed (is opencode on PATH?)");

  // Deep link restores exactly that session; the zero-message hero renders.
  const page = await openApp(`/p/${project.id}/s/${session.id}`, ".hero");
  try {
    await registerProbe(page, "__ctxProbeIds", "ids-ctx-probe");
    const captured = await capturedCtx(page, "__ctxProbeIds");
    assert.ok(captured.length > 0, "probe component never rendered");
    assert.deepEqual(captured.at(-1), { projectId: project.id, sessionId: session.id });

    // Late same-id replacement: the second registration must receive the same
    // canonical context on its very first render.
    await registerProbe(page, "__ctxProbeLate", "late-ctx-probe");
    const late = await capturedCtx(page, "__ctxProbeLate");
    assert.ok(late.length > 0, "replacement probe never rendered");
    assert.deepEqual(late[0], { projectId: project.id, sessionId: session.id });
  } finally {
    await closePage(page);
  }
});
