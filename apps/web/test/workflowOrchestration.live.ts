// Workflow-orchestration browser gate. workflowOrchestration.test.ts imports
// this suite so the disposable real-Chrome journey is part of `npm test`.
//
// Run explicitly:
//   node --experimental-strip-types --test --test-concurrency=1 \
//     apps/web/test/workflowOrchestration.live.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCanonicalSecurity, type CanonicalSecurity } from "../../../packages/server/src/canonicalSecurity.ts";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { JsonObject, SessionProjection, WorkflowRunDto } from "@polyth/contracts";
process.env.POLYTH_COMPDISC_FIXTURE_ROOT ??= join(import.meta.dirname, "../../../.scratch/workflow-browser", String(process.pid));
const {
  FIXTURE_BIN,
  FIXTURE_DATA,
  FIXTURE_HOME,
  OC_SEED,
  OC_STATE,
  PROJECT_ID,
  REPO_ROOT,
  SESSIONS,
  buildComposerDiscFixture,
} = await import("./composerDiscFixtureSetup.mjs");

const PORT = process.env.POLYTH_WORKFLOW_TEST_PORT ?? "4467";
const BASE = `http://127.0.0.1:${PORT}`;
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? join(process.env.POLYTH_COMPDISC_FIXTURE_ROOT!, "screenshots");
const PERSONA = JSON.stringify({ persona: "engineer", plugins: [] });
const MANUAL_PARENT = "workflow-manual-parent";
const MANUAL_CHILD = "workflow-manual-child";
const ERROR_PARENT = "workflow-error-parent";
const VISUAL_SESSION = "workflow-visual";
const WORKFLOW_RELEASE = "workflow-release";
const WORKFLOW_APPROVAL = "workflow-approval";
const WORKFLOW_RECOVERY = "workflow-recovery";

const now = Date.now();
const releaseNodes = Array.from({ length: 40 }, (_, index) => ({
  id: `stage-${index + 1}`,
  role: `Stage ${index + 1}`,
  prompt: `Complete release stage ${index + 1}.`,
}));
const releaseEdges = releaseNodes.slice(1).map((node, index) => ({
  id: `edge-${index + 1}`,
  source: releaseNodes[index]!.id,
  target: node.id,
}));
const workflows = [{
  id: WORKFLOW_RELEASE,
  projectId: PROJECT_ID,
  name: "Release pipeline",
  nodes: releaseNodes,
  edges: releaseEdges,
  defaults: { pipe: "ancestors", permissions: "auto", maxParallel: 1, nodeTimeoutMs: 30_000 },
  createdAt: now,
  updatedAt: now + 3,
}, {
  id: WORKFLOW_APPROVAL,
  projectId: PROJECT_ID,
  name: "Approval review",
  nodes: [{ id: "review", role: "Reviewer", prompt: "Review the release." }],
  edges: [],
  defaults: { pipe: "ancestors", permissions: "manual", maxParallel: 1, nodeTimeoutMs: 30_000 },
  createdAt: now,
  updatedAt: now + 2,
}, {
  id: WORKFLOW_RECOVERY,
  projectId: PROJECT_ID,
  name: "Failure recovery",
  nodes: [{ id: "recover", role: "Recovery agent", prompt: "Recover the failed release." }],
  edges: [],
  defaults: { pipe: "ancestors", permissions: "auto", maxParallel: 1, nodeTimeoutMs: 30_000 },
  createdAt: now,
  updatedAt: now + 1,
}];

const manualRun: WorkflowRunDto = {
  id: "run-manual",
  workflowId: WORKFLOW_APPROVAL,
  projectId: PROJECT_ID,
  parentSessionId: MANUAL_PARENT,
  name: "Approval review",
  input: "Approve the production deployment",
  options: { pipe: "ancestors", permissions: "manual", maxParallel: 1, nodeTimeoutMs: 30_000, reviewRounds: 2 },
  status: "running",
  startedAt: now,
  layers: [["review"]],
  nodes: [{
    id: "review",
    role: "Reviewer",
    status: "running",
    sessionId: MANUAL_CHILD,
    activity: "awaiting permission: bash",
    startedAt: now,
  }],
};

// A failed unit keeps its last streamed progress, and older runs recorded the
// empty reasoning parts between notes as runs of blank lines.
const GAPPED_PROGRESS = "Checking the release.\n\n\n\n\n\n\n\nRunning the deploy check.";
const COMPACT_PROGRESS = "Checking the release.\n\nRunning the deploy check.";
const errorRun: WorkflowRunDto = {
  id: "run-error",
  workflowId: WORKFLOW_RECOVERY,
  projectId: PROJECT_ID,
  parentSessionId: ERROR_PARENT,
  name: "Failure recovery",
  input: "Recover the failed release",
  options: { pipe: "ancestors", permissions: "auto", maxParallel: 1, nodeTimeoutMs: 30_000, reviewRounds: 2 },
  status: "error",
  startedAt: now - 2_000,
  finishedAt: now - 1_000,
  layers: [["recover"]],
  result: GAPPED_PROGRESS,
  nodes: [{
    id: "recover",
    role: "Recovery agent",
    status: "error",
    sessionId: "workflow-error-child",
    output: GAPPED_PROGRESS,
    error: "Synthetic deploy check failed with exit code 17",
    startedAt: now - 2_000,
    finishedAt: now - 1_000,
  }],
};

const chromiumCandidates = [
  ...(process.env.POLYTH_BROWSER_EXECUTABLE ? [process.env.POLYTH_BROWSER_EXECUTABLE] : []),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

let browser: Browser;
let server: ChildProcess | undefined;
let serverLog: ReturnType<typeof createWriteStream> | undefined;
let fixtureCookie: { name: string; value: string };
const contexts: BrowserContext[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForAnimations(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate(async (element) => {
    // A cancelled animation (replaced by the next resize step) rejects its
    // `finished` promise with AbortError; it is settled all the same.
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function chromiumPath(): Promise<string> {
  for (const candidate of chromiumCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  throw new Error("Chrome/Chromium executable not found");
}

const jsonData = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;

const eventData = (run: WorkflowRunDto): JsonObject => jsonData({
  runId: run.id,
  workflowId: run.workflowId,
  projectId: run.projectId!,
  parentSessionId: run.parentSessionId!,
  name: run.name,
  input: run.input,
  options: run.options!,
  startedAt: run.startedAt,
  layers: run.layers,
  nodes: run.nodes,
});

before(async () => {
  // A fixture must never adopt or interfere with an existing server.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(Number(PORT), "127.0.0.1", () => probe.close((cause) => cause ? reject(cause) : resolve()));
  });
  await mkdir(ARTIFACTS, { recursive: true });
  let security!: CanonicalSecurity;
  let owner!: { userId: string; organizationId: string; spaceId: string; token: string };
  await buildComposerDiscFixture({ initializeAuthority: async () => {
    security = createCanonicalSecurity({ dataDir: FIXTURE_DATA, origin: BASE, localOnly: true });
    const claim = security.identity.setup.issueClaim();
    const binding = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    security.identity.setup.bindClaim(claim.token, binding);
    const recovery = security.identity.setup.prepareRecovery(claim.token, binding);
    owner = await security.identity.setup.complete({
      claimToken: claim.token, browserBinding: binding, name: "Workflow fixture",
      organizationName: "Synthetic workflow tests", login: "workflow-fixture",
      password: `Fixture-only-${randomUUID()}`, recoverySetId: recovery.setId, recoveryAcknowledged: true,
    });
    fixtureCookie = { name: security.http.cookieName, value: owner.token };
  } });
  await writeFile(join(FIXTURE_DATA, "workflows.json"), `${JSON.stringify({ v: 1, workflows }, null, 2)}\n`);
  // Workflows is in progress and off by default; this gate exercises it enabled.
  await writeFile(join(FIXTURE_DATA, "packages.json"), `${JSON.stringify({ workflow: true }, null, 2)}\n`);

  const { createStore } = await import("../../../packages/session/src/index.ts");
  const store = createStore(join(FIXTURE_DATA, "sessions.db"));
  const projection = (
    id: string,
    title: string,
    status: SessionProjection["status"] = "idle",
  ): SessionProjection => ({
    id,
    projectId: PROJECT_ID,
    title,
    status,
    createdAt: now - 10_000,
    updatedAt: now,
  });

  await store.append(MANUAL_PARENT, "session/created", { title: "Manual approval parent" }, { ignorable: true });
  await store.append(MANUAL_PARENT, "workflow/run-started", eventData(manualRun), { ignorable: true });
  await store.append(MANUAL_PARENT, "workflow/node-progress", jsonData({
    runId: manualRun.id,
    nodeId: "review",
    node: manualRun.nodes[0]!,
  }), { ignorable: true });
  await store.upsertProjection(projection(MANUAL_PARENT, "Manual approval parent"));

  await store.append(MANUAL_CHILD, "session/created", { title: "Reviewer child session" }, { ignorable: true });
  await store.append(MANUAL_CHILD, "user/message", { text: "Review the deployment." });
  await store.append(MANUAL_CHILD, "turn/started", { turnId: "manual-turn" }, { ignorable: true });
  await store.append(MANUAL_CHILD, "permission/requested", {
    requestId: "per_workflow",
    permission: "bash",
    patterns: ["deploy --production"],
    preview: { title: "Run production deploy check", lines: ["deploy --production"], risk: "high" },
  });
  await store.upsertProjection(projection(MANUAL_CHILD, "Reviewer child session", "waiting"));

  await store.append(ERROR_PARENT, "session/created", { title: "Failed workflow parent" }, { ignorable: true });
  await store.append(ERROR_PARENT, "workflow/run-started", eventData(errorRun), { ignorable: true });
  await store.append(ERROR_PARENT, "workflow/node-progress", jsonData({
    runId: errorRun.id,
    nodeId: "recover",
    node: errorRun.nodes[0]!,
  }), { ignorable: true });
  await store.append(ERROR_PARENT, "workflow/run-completed", {
    runId: errorRun.id,
    status: "error",
    finishedAt: errorRun.finishedAt!,
    result: errorRun.result!,
  }, { ignorable: true });
  await store.upsertProjection(projection(ERROR_PARENT, "Failed workflow parent"));

  await store.append(VISUAL_SESSION, "session/created", { title: "Workflow visual baseline" }, { ignorable: true });
  await store.upsertProjection(projection(VISUAL_SESSION, "Workflow visual baseline"));
  // Register synthetic domain records with the real resource authority; browser
  // requests authenticate normally and exercise the actual Space gateway.
  const projectsFile = join(FIXTURE_DATA, "projects.json");
  const projects = JSON.parse(await readFile(projectsFile, "utf8")) as Array<Record<string, unknown>>;
  for (const project of projects) project.spaceId = owner.spaceId;
  await writeFile(projectsFile, JSON.stringify(projects));
  const activate = (id: string, kind: string, receipt: unknown, parentId?: string) => {
    const operationId = `fixture-${id}`;
    const { resource } = security.resources.begin({
      operationId, resourceId: id, kind, orgId: owner.organizationId, spaceId: owner.spaceId,
      ownerPrincipalId: owner.userId, createdBy: owner.userId, visibility: parentId ? "inherit" : "space",
      ...(parentId ? { parentId } : {}),
    });
    security.resources.recordDomainReady(operationId, JSON.stringify(receipt));
    security.resources.activate(operationId, resource.revision);
  };
  activate(PROJECT_ID, "project", projects[0]);
  for (const projection of await store.projections(PROJECT_ID)) {
    const scoped = { ...projection, spaceId: owner.spaceId };
    await store.upsertProjection(scoped);
    activate(scoped.id, "session", scoped, PROJECT_ID);
  }
  await store.close();
  security.close();

  if (process.env.POLYTH_WORKFLOW_SKIP_BUILD !== "1") {
    execFileSync(process.execPath, ["--experimental-strip-types", "apps/web/buildPackages.ts"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["--experimental-strip-types", "apps/web/build.ts"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
  }
  server = spawn(process.execPath, ["--experimental-strip-types", "packages/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: FIXTURE_HOME,
      XDG_CONFIG_HOME: join(FIXTURE_HOME, ".config"),
      XDG_DATA_HOME: join(FIXTURE_HOME, ".local/share"),
      OPENCODE_CONFIG_DIR: join(FIXTURE_HOME, "opencode"),
      POLYTH_DATA_DIR: FIXTURE_DATA,
      PORT,
      PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      MSGACT_OC_SEED: OC_SEED,
      MSGACT_OC_STATE: OC_STATE,
      MSGACT_TURN_DELAY_MS: "1000",
      POLYTH_FAKE_BROWSER: "1",
      // This fixture exercises only the synthetic OpenCode provider. Catalog
      // discovery must not start installed host CLIs alongside Chromium.
      ...Object.fromEntries(["CODEX", "CLAUDE", "CURSOR", "ANTIGRAVITY", "FX", "GROK", "PI", "OMP", "COMMANDCODE"]
        .map((name) => [`POLYTH_${name}_BIN`, join(FIXTURE_BIN, "unavailable-provider")])),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverLog = createWriteStream(join(ARTIFACTS, "server.log"));
  server.stdout?.pipe(serverLog, { end: false });
  server.stderr?.pipe(serverLog, { end: false });

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`workflow fixture server exited (${server.exitCode}); see ${join(ARTIFACTS, "server.log")}`);
    try {
      const health = await fetch(`${BASE}/api/health`).then((response) => response.json()) as { ok?: boolean };
      if (health.ok) break;
    } catch {
      // Wait for the isolated server.
    }
    if (Date.now() > deadline) throw new Error("workflow fixture server did not become healthy");
    await sleep(200);
  }

  const playwright = await import("playwright-core");
  browser = await playwright.chromium.launch({
    executablePath: await chromiumPath(),
    headless: true,
    timeout: 30_000,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check", "--renderer-process-limit=1", "--js-flags=--max-old-space-size=128"],
  });
});

after(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = new Promise<void>((resolve) => server!.once("exit", () => resolve()));
    server.kill("SIGTERM");
    await Promise.race([exited, sleep(5_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  serverLog?.end();
});

interface OpenOptions {
  width: number;
  height: number;
  sessionId: string;
  runs?: WorkflowRunDto[];
  storage?: Record<string, string>;
  reducedMotion?: "reduce" | "no-preference";
  colorScheme?: "dark" | "light";
}

async function openApp(options: OpenOptions): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    reducedMotion: options.reducedMotion ?? "no-preference",
    colorScheme: options.colorScheme ?? "dark",
    serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addCookies([{ ...fixtureCookie, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  // Presentation fixtures are per browser context, so an earlier navigation
  // test cannot overwrite the next context's hidden-widget setup on hydration.
  const presentation: Record<string, unknown> = { workspaceMode: "chat" };
  const presentationKeys: Record<string, string> = {
    [`polyth.widgetLayout.${PROJECT_ID}`]: "widgetLayout",
    [`polyth.workspacePanel.v1.${PROJECT_ID}`]: "workspacePanel",
    [`polyth.capabilityLayout.v1.${PROJECT_ID}`]: "capabilityLayout",
  };
  for (const [key, name] of Object.entries(presentationKeys)) {
    if (options.storage?.[key]) presentation[name] = JSON.parse(options.storage[key]!);
  }
  await context.route(`**/api/projects/${PROJECT_ID}/settings`, async (route) => {
    if (route.request().method() === "PUT") Object.assign(presentation, route.request().postDataJSON()?.settings);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ revision: 0, updatedAt: 1, settings: presentation }) });
  });
  await context.addInitScript(({
    persona,
    projectId,
    storage,
  }: {
    persona: string;
    projectId: string;
    storage: Record<string, string>;
  }) => {
    localStorage.setItem("polyth.prefs", persona);
    // The first-open shell tour covers the shell; these scenarios start from
    // an account that has already seen it (any later tour version too).
    localStorage.setItem("polyth.shellIntro.v1", JSON.stringify({ seenVersion: 1_000_000 }));
    localStorage.setItem("polyth.uiSettings.v1", JSON.stringify({ mobileShortcuts: ["session", "workflow", "goals", "settings"] }));
    localStorage.setItem(`polyth.workspaceMode.v1.${projectId}`, "chat");
    localStorage.setItem(`polyth.capabilityLayout.v1.${projectId}`, JSON.stringify({
      version: 1,
      placements: { workflow: { tier: "primary", rank: 4 } },
    }));
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  }, { persona: PERSONA, projectId: PROJECT_ID, storage: options.storage ?? {} });
  if (options.runs) {
    await context.route("**/api/workflow-runs?projectId=*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(options.runs) }));
    for (const run of options.runs) {
      await context.route(`**/api/workflow-runs/${run.id}`, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) }));
    }
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error("Browser page error:", error.message));
  page.setDefaultTimeout(8_000);
  page.setDefaultNavigationTimeout(8_000);
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${options.sessionId}`, { waitUntil: "load", timeout: 8_000 });
  await page.waitForSelector(".app", { timeout: 8_000 });
  await page.waitForSelector(".composer-card", { state: "visible", timeout: 8_000 });
  await page.waitForSelector(".app.mode-chat.view-session", { state: "visible", timeout: 8_000 });
  await page.waitForFunction(async (sessionId) => {
    const modulePath = "/shell-api/apps/web/src/store__ts.js";
    const { getState } = await import(modulePath);
    return getState().activeSessionId === sessionId;
  }, options.sessionId, { timeout: 8_000 });
  await page.waitForTimeout(150);
  return page;
}

async function assertNoOverflow(page: Page, label: string): Promise<void> {
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    overflowing: [...document.querySelectorAll<HTMLElement>("button, input, textarea, select, [role='dialog']")]
      .filter((element) => {
        if (element.closest('[inert], [aria-hidden="true"]')) return false;
        const box = element.getBoundingClientRect();
        const carousel = element.closest<HTMLElement>(
          ".mobile-shortcut-rail, .composer-mobile-extensions, .workflow-category-tabs, .workflow-canvas",
        );
        if (carousel) {
          const clip = carousel.getBoundingClientRect();
          const intentionallyClipped = clip.left >= -0.5
            && clip.right <= innerWidth + 0.5
            && carousel.scrollWidth > carousel.clientWidth
            && (box.left < clip.left - 0.5 || box.right > clip.right + 0.5);
          if (intentionallyClipped) return false;
        }
        return box.width > 0 && (box.left < -0.5 || box.right > innerWidth + 0.5);
      })
      .map((element) => ({
        label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 50) ?? element.tagName,
        box: element.getBoundingClientRect().toJSON(),
      })),
  }));
  assert.ok(geometry.document <= geometry.viewport + 1, `${label}: document overflows ${geometry.document}/${geometry.viewport}`);
  assert.ok(geometry.body <= geometry.viewport + 1, `${label}: body overflows ${geometry.body}/${geometry.viewport}`);
  assert.deepEqual(geometry.overflowing, [], `${label}: interactive controls leave the viewport`);
}

async function openWorkflowFromSwitcher(page: Page, label = "Workflows"): Promise<void> {
  const beforeSession = await page.evaluate(async () => {
    const modulePath = "/shell-api/apps/web/src/store__ts.js";
    const { getState } = await import(modulePath);
    return getState().activeSessionId;
  });
  const width = await page.evaluate(() => innerWidth);
  if (width > 960) {
    const desktopButton = page.locator(".view-switcher").getByRole("button", { name: label, exact: true });
    await desktopButton.waitFor({ state: "visible" });
    await desktopButton.click();
  } else if (width > 480) {
    const compactShortcut = page.locator(".mobile-shortcut-rail").getByRole("button", { name: label, exact: true });
    await compactShortcut.waitFor({ state: "visible" });
    await compactShortcut.click();
  } else {
    const tools = page.getByRole("button", { name: "Open tools" });
    await tools.waitFor({ state: "visible" });
    await tools.click();
    const workspace = page.getByRole("dialog", { name: "Workspace" });
    // Editing is a mode switched on in the Workspace header.
    await workspace.getByRole("switch", { name: "Edit", exact: true }).click();
    await workspace.getByRole("button", { name: /^Add widgets/ }).click();
    // Large sections fold behind "Show all", so find the item by search. Single
    // items are toggles named by title; others read "Add <title>".
    const gallery = workspace.getByRole("region", { name: "Add widgets" });
    await gallery.getByRole("searchbox", { name: "Search widgets, apps and layout elements" })
      .or(gallery.getByRole("textbox", { name: "Search widgets, apps and layout elements" }))
      .fill(label);
    const libraryItem = gallery.getByRole("button", { name: new RegExp(`^(Add (another )?)?${label}$`) }).first();
    await libraryItem.waitFor({ state: "visible" });
    const pressed = await libraryItem.getAttribute("aria-pressed");
    if (pressed === "false" || (pressed === null && (await libraryItem.getAttribute("aria-label")) === `Add ${label}`)) {
      await libraryItem.click();
    }
    await gallery.getByRole("button", { name: "Done", exact: true }).click();
    await gallery.waitFor({ state: "detached" });
    await workspace.getByRole("switch", { name: "Edit", exact: true }).click();
    await workspace.getByRole("button", { name: label, exact: true }).click();
  }
  await page.waitForSelector(".workflow-page", { state: "visible" });
  await waitForAnimations(page, '.module-view[data-module-id="workflow"]');
  await waitForAnimations(page, '[data-package-window-owner="workflow"]');
  const afterSession = await page.evaluate(async () => {
    const modulePath = "/shell-api/apps/web/src/store__ts.js";
    const { getState } = await import(modulePath);
    return getState().activeSessionId;
  });
  assert.equal(afterSession, beforeSession, "opening Workflows must preserve the active chat session");
}

async function openWorkflowLauncher(page: Page): Promise<void> {
  const launcher = page.getByRole("button", { name: "Run workflow" });
  if (!await launcher.isVisible().catch(() => false)) await page.locator(".composer-editor[data-composer-input]").click();
  await launcher.click();
  await page.getByRole("dialog", { name: "Run a workflow" }).waitFor({ state: "visible" });
  await waitForAnimations(page, ".workflow-launch-overlay");
}

test("enabled workflow package is discoverable from Chat and Goals", async () => {
  const page = await openApp({ width: 1280, height: 900, sessionId: SESSIONS.main });
  try {
    const rail = page.locator(".view-switcher-pill");
    const workflow = rail.getByRole("button", { name: "Workflows" });
    await workflow.waitFor({ state: "visible" });
    const chatGeometry = await Promise.all([rail.boundingBox(), workflow.boundingBox()]);
    assert.ok(
      chatGeometry[0] && chatGeometry[1]
        && chatGeometry[1].x >= chatGeometry[0].x - 1
        && chatGeometry[1].x + chatGeometry[1].width <= chatGeometry[0].x + chatGeometry[0].width + 1,
      "Chat must show the complete Workflows button without requiring horizontal rail scrolling",
    );

    await rail.getByRole("button", { name: /Goals/ }).click();
    await page.waitForSelector('[data-package-window-owner="goals"]', { state: "visible" });
    await workflow.waitFor({ state: "visible" });
    const goalsGeometry = await Promise.all([rail.boundingBox(), workflow.boundingBox()]);
    assert.ok(
      goalsGeometry[0] && goalsGeometry[1]
        && goalsGeometry[1].x >= goalsGeometry[0].x - 1
        && goalsGeometry[1].x + goalsGeometry[1].width <= goalsGeometry[0].x + goalsGeometry[0].width + 1,
      "Goals must retain a fully visible Workflows destination",
    );
  } finally {
    await closePage(page);
  }
});

test("current compact navigation exposes Workflows on phones and tablets", async () => {
  for (const viewport of [
    { width: 320, height: 700 },
    { width: 375, height: 812 },
    { width: 768, height: 900 },
  ]) {
    const page = await openApp({ ...viewport, sessionId: SESSIONS.main });
    try {
      await openWorkflowFromSwitcher(page);
      await page.waitForSelector(".workflow-page", { state: "visible" });
      await page.screenshot({ path: join(ARTIFACTS, `workflow_navigation_${viewport.width}.png`) });
      assert.equal(await page.locator('.module-view[data-module-id="workflow"] .module-view-close').isVisible(), true,
        `shared module close is hidden at ${viewport.width}px`);
      if (viewport.width <= 480) {
        assert.equal(await page.locator(".mobile-session-floats").isVisible(), true,
          `floating phone navigation is hidden at ${viewport.width}px`);
      } else {
        assert.equal(await page.locator(".mobile-shortcut-rail")
          .getByRole("button", { name: "Workflows", exact: true }).getAttribute("aria-current"), "page",
        `tablet shortcut did not activate Workflows at ${viewport.width}px`);
      }
    } finally {
      await closePage(page);
    }
  }
});

test("phone Workspace is a full-width back-navigation destination", async () => {
  const workspaceLayout = JSON.stringify({
    version: 1,
    items: [
      { id: "launcher:files", definitionId: "launcher:files", type: "launcher", size: "compact", config: {} },
      { id: "widget:usage.project", definitionId: "widget:usage.project", type: "widget", size: "large", config: {} },
    ],
  });
  const page = await openApp({
    width: 375,
    height: 812,
    sessionId: SESSIONS.main,
    storage: { [`polyth.workspacePanel.v1.${PROJECT_ID}`]: workspaceLayout },
  });
  try {
    const tools = page.getByRole("button", { name: "Open tools" });
    await tools.click();
    const workspace = page.getByRole("dialog", { name: "Workspace" });
    await workspace.waitFor({ state: "visible" });

  const entrance = await workspace.evaluate((element) => {
    const animation = element.getAnimations().find((candidate) => candidate instanceof CSSAnimation);
    return {
      name: getComputedStyle(element).animationName,
      frames: animation?.effect instanceof KeyframeEffect
        ? animation.effect.getKeyframes().map((frame) => frame.transform)
        : [],
    };
  });
  assert.equal(entrance.name, "stack-in");
  assert.ok(entrance.frames.length === 0 || entrance.frames.some((transform) => String(transform ?? "").includes("100%")),
    `Workspace does not enter from the right edge: ${JSON.stringify(entrance)}`);
  await workspace.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));

  const geometry = await workspace.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const backdrop = element.parentElement!.getBoundingClientRect();
    const back = element.querySelector<HTMLElement>(".sheet-back")!.getBoundingClientRect();
    const editSwitch = element.querySelector<HTMLElement>(".sheet-head-switch")!.getBoundingClientRect();
    const grabber = element.querySelector<HTMLElement>(".sheet-grabber");
    const launcher = element.querySelector<HTMLElement>(".workspace-panel-launcher")!;
    return {
      viewportWidth: document.documentElement.clientWidth,
      rect: rect.toJSON(),
      backdrop: backdrop.toJSON(),
      pseudo: getComputedStyle(element, "::before").content,
      grabber: grabber ? getComputedStyle(grabber).display : null,
      back: back.toJSON(),
      editSwitch: editSwitch.toJSON(),
      launcherBackground: getComputedStyle(launcher).backgroundColor,
    };
  });
  assert.ok(Math.abs(geometry.rect.left) <= 0.5 && Math.abs(geometry.rect.width - geometry.viewportWidth) <= 0.5,
    `Workspace is not edge-to-edge: ${JSON.stringify(geometry.rect)}`);
  assert.ok(Math.abs(geometry.backdrop.width - geometry.viewportWidth) <= 0.5,
    `Workspace backdrop is not viewport-wide: ${JSON.stringify(geometry.backdrop)}`);
  assert.ok(geometry.grabber === null || geometry.grabber === "none", "Workspace still shows bottom-sheet drag chrome");
  assert.ok(geometry.pseudo === "none" || geometry.pseudo === "normal", `Workspace still paints drag chrome: ${geometry.pseudo}`);
  // Back leads and the Edit switch trails one header row (docs/dev/widgets.md).
  assert.ok(geometry.back.right <= geometry.editSwitch.left + 1, "Back and the Edit switch overlap");
  assert.ok(geometry.back.left < geometry.viewportWidth / 2 && geometry.editSwitch.right > geometry.viewportWidth / 2,
    "Back sits on the inline-start side, the switch on the inline-end side");
  assert.equal(await workspace.getByRole("button", { name: "Back" }).isVisible(), true);
  assert.equal(await workspace.getByRole("switch", { name: "Edit" }).isVisible(), true);
  assert.equal(await workspace.getByRole("button", { name: "Close Workspace" }).count(), 0, "Back is the way out");
  assert.ok(geometry.launcherBackground && geometry.launcherBackground !== "rgba(0, 0, 0, 0)",
    "launcher lost its themed block background");

  await page.screenshot({ path: join(ARTIFACTS, "workspace_phone_375.png") });
  await workspace.getByRole("button", { name: "Back" }).click();
  await workspace.waitFor({ state: "detached" });
  assert.equal(await tools.evaluate((element) => element === document.activeElement), true,
    "Closing does not restore focus to the Workspace trigger");
  } finally {
    await closePage(page);
  }
});

test("chat page load preserves a hidden workflow launcher placement", async () => {
  const staleLayout = JSON.stringify({
    version: 1,
    audience: "standard",
    zones: { header: [], left: [], main: [], right: [], bottom: [], floating: [] },
    slotPlacements: { "composer.trailing": ["workflow.composer-action"] },
    widgets: {
      "workflow.composer-action": {
        visible: false,
        size: { w: 4, h: 1 },
        position: { x: 0, y: 0 },
        definitionId: "workflow.composer-action",
        pluginId: "workflow",
        title: "Workflows",
        kind: "mini-widget",
      },
    },
  });
  const page = await openApp({
    width: 1280,
    height: 900,
    sessionId: SESSIONS.main,
    storage: { [`polyth.widgetLayout.${PROJECT_ID}`]: staleLayout },
  });
  try {
    const composer = page.locator(".composer-simple");
    await composer.waitFor({ state: "visible" });
    const launcher = composer.locator(".composer-workflow");
    assert.equal(await launcher.count(), 0, "a disabled workflow launcher stays out of Chat");
    const repaired = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "{}").widgets?.["workflow.composer-action"]?.visible,
      `polyth.widgetLayout.${PROJECT_ID}`,
    );
    assert.equal(repaired, false, "page load preserves the disabled placement");
    await composer.screenshot({ path: join(ARTIFACTS, "workflow_launcher_button_disabled.png") });
  } finally {
    await closePage(page);
  }
});

async function closePage(page: Page): Promise<void> {
  const context = page.context();
  await context.close().catch(() => {});
  const index = contexts.indexOf(context);
  if (index >= 0) contexts.splice(index, 1);
}

async function waitForSaved(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector(".workflow-save-state")?.getAttribute("data-state") === "saved",
    undefined,
    { timeout: 8_000 },
  );
}

async function openTemplate(page: Page, name: string, tab: "Run" | "Edit" = "Edit", openLabel = `Open ${name}`): Promise<void> {
  await page.locator(".workflow-card")
    .locator(`.workflow-card-main[aria-label="${openLabel}"]`).click();
  await page.locator('.workflow-page[data-page="workflow"]').waitFor({ state: "visible" });
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

test("workflow preset library supports first use, customization, autosave, grouped workers, and undo", async () => {
  const page = await openApp({ width: 1280, height: 900, sessionId: SESSIONS.main });
  try {
    await openWorkflowFromSwitcher(page);
    await page.locator('.workflow-page[data-page="library"]').getByRole("heading", { name: "Templates" }).waitFor({ state: "visible" });

    await openTemplate(page, "Build + Review", "Run");
    await page.getByRole("dialog").getByRole("button", { name: "Customize", exact: true }).click();
    await page.locator(".workflow-canvas").waitFor({ state: "visible" });
    await page.getByRole("dialog").getByRole("button", { name: "Customize", exact: true }).waitFor({ state: "detached" });

    await page.getByRole("button", { name: "All workflows", exact: true }).click();
    await openTemplate(page, "Development", "Run");
    await page.getByRole("dialog").getByRole("button", { name: "Customize", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Customize", exact: true }).waitFor({ state: "detached" });
    const groupControls = page.locator('[aria-label="implementation worker count"]');
    await groupControls.waitFor({ state: "visible" });
    assert.equal((await groupControls.locator('[aria-live="polite"]').textContent())?.trim(), "2");

    await groupControls.getByRole("button", { name: "Add worker to implementation" }).click();
    assert.equal((await groupControls.locator('[aria-live="polite"]').textContent())?.trim(), "3");

    const collapsedGroup = page.locator(".workflow-canvas-group").filter({ hasText: "×3" });
    await collapsedGroup.locator(".workflow-canvas-node").click();
    assert.ok(await page.locator(".workflow-canvas-node").count() >= 3, "expanded stage canvas hides worker replicas");

    const workflowName = page.getByRole("textbox", { name: "Workflow name" });
    await workflowName.fill("Development custom");
    await waitForSaved(page);

    const inspector = page.locator(".workflow-desktop-inspector");
    await inspector.getByText("Node inspector", { exact: true }).waitFor({ state: "visible" });
    const prompt = inspector.locator("textarea").first();
    const beforePrompt = await prompt.inputValue();
    await prompt.fill(beforePrompt + " Verify the worker evidence.");
    await waitForSaved(page);
    const undo = page.getByRole("button", { name: /^Undo\b/i });
    await undo.click();
    await page.waitForFunction(
      (expected) => document.querySelector<HTMLTextAreaElement>(".workflow-desktop-inspector textarea")?.value === expected,
      beforePrompt,
      { timeout: 8_000 },
    );
    await waitForSaved(page);
    await page.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
    await page.locator(".workflow-canvas").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(ARTIFACTS, "workflow_preset_editor.png"), fullPage: false });
  } finally {
    await closePage(page);
  }
});

// Packages are auto-placed only in projects whose directions match, so this
// scenario arranges the composer workflow launcher itself (as a person would).
const COMPOSER_LAUNCHER_LAYOUT = JSON.stringify({
  version: 1,
  audience: "standard",
  zones: { header: [], left: [], main: [], right: [], bottom: [], floating: [] },
  slotPlacements: { "composer.trailing": ["workflow.composer-action"] },
  widgets: {
    "workflow.composer-action": {
      visible: true,
      size: { w: 1, h: 1 },
      position: { x: 0, y: 0 },
      definitionId: "workflow.composer-action",
      pluginId: "workflow",
      title: "Workflows",
      kind: "mini-widget",
    },
  },
});

test("workflow human approval opens the child session and exposes its permission", async () => {
  const page = await openApp({ width: 1280, height: 900, sessionId: MANUAL_PARENT, runs: [manualRun] });
  try {
    const timeline = page.locator(".workflow-timeline-card");
    await timeline.waitFor({ state: "visible" });
    await timeline.locator(".needs-human").waitFor({ state: "visible" });
    assert.match((await timeline.locator(".workflow-timeline-summary").textContent()) ?? "", /waiting/i);

    await timeline.getByRole("button", { name: "View workflow", exact: true }).click();
    // The waiting unit leads the run, ahead of the request text and stages.
    const review = page.locator(".workflow-run-results > .workflow-run-requests").getByRole("button", { name: /Review.*respond/i });
    await review.waitFor({ state: "visible" });
    // Measure once the workflow window has finished its entrance.
    await waitForAnimations(page, '[data-package-window-owner="workflow"]');
    const reviewBox = await review.boundingBox();
    // Touch targets grow only on coarse pointers; this desktop run keeps the
    // compact control height.
    assert.ok(reviewBox && reviewBox.width > 0 && reviewBox.height >= 32);
    await review.click();
    await page.waitForSelector(".perm-banner", { state: "visible", timeout: 8_000 });
    assert.match(page.url(), new RegExp("/s/" + MANUAL_CHILD + "$"));
    assert.match((await page.locator(".perm-banner").textContent()) ?? "", /Run production deploy check/);
    await page.screenshot({ path: join(ARTIFACTS, "workflow_manual_approval_handoff.png"), fullPage: false });
  } finally {
    await closePage(page);
  }
});

test("workflow failure stays fenced to the failed run without a full retry", async () => {
  const page = await openApp({ width: 1280, height: 900, sessionId: ERROR_PARENT });
  try {
    const timeline = page.locator(".workflow-timeline-card.status-error");
    await timeline.waitFor({ state: "visible" });
    assert.match((await timeline.textContent()) ?? "", /Synthetic deploy check failed/);
    assert.equal(await timeline.getByRole("button", { name: /Retry full workflow/i }).count(), 0);
    assert.equal(await timeline.locator(".workflow-timeline-result p").textContent(), COMPACT_PROGRESS,
      "recorded blank gaps never become empty screens in chat");

    await timeline.getByRole("button", { name: "View workflow", exact: true }).click();
    const results = page.locator(".workflow-run-results");
    await page.locator(".workflow-page").waitFor({ state: "visible" });
    await results.waitFor({ state: "visible" });
    assert.match((await results.locator(".form-error").textContent()) ?? "", /exit code 17/);
    assert.equal(await results.locator(".workflow-retry-controls").count(), 0);
    assert.equal(await results.locator(".workflow-run-heading > .workflow-status.status-error").count(), 1);
    assert.equal(await results.locator(".workflow-run-result").textContent(), COMPACT_PROGRESS);
    assert.equal(await results.locator(".workflow-node-output").textContent(), COMPACT_PROGRESS);

    // "View workflow" on a run leads with that run, not the preset gallery.
    assert.equal(await page.locator(".workflow-page").getAttribute("data-page"), "workflow");
    await page.waitForFunction(() => {
      const box = document.querySelector(".workflow-run-results")?.getBoundingClientRect();
      return !!box && box.top >= 0 && box.top < innerHeight;
    }, undefined, { timeout: 4_000 });
    // A failed run is never replayed in one click; the next run is an explicit request.
    assert.equal(await page.getByRole("button", { name: "Run again", exact: true }).count(), 0);
    const form = page.locator(".workflow-run-form");
    await form.waitFor({ state: "visible" });
    assert.equal(await form.locator("textarea").inputValue(), errorRun.input);
    await page.waitForTimeout(250);
    assert.equal(await results.locator(".workflow-status.status-running").count(), 0);
    await page.screenshot({ path: join(ARTIFACTS, "workflow_failed_fenced.png"), fullPage: false });
  } finally {
    await closePage(page);
  }
});

test("workflow mobile inspector keeps the selected node reachable", async () => {
  const page = await openApp({ width: 375, height: 812, sessionId: VISUAL_SESSION });
  try {
    await openWorkflowFromSwitcher(page);
    await openTemplate(page, "Development");
    const firstNode = page.locator(".workflow-canvas-node").first();
    await firstNode.waitFor({ state: "visible" });
    const role = (await firstNode.locator("strong").textContent())!.trim();
    await firstNode.click();
    // The phone inspector is a sheet titled "Node inspector" that leads with
    // the selected node's role.
    const inspector = page.getByRole("dialog", { name: "Node inspector", exact: true });
    await inspector.waitFor({ state: "visible" });
    assert.match((await inspector.locator(".workflow-inspector-heading").textContent()) ?? "", new RegExp(role));
    assert.ok(await inspector.locator("textarea").count() >= 1);
    await inspector.evaluate(async (element) => {
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
    });
    const box = await inspector.boundingBox();
    assert.ok(box && box.x >= -1 && box.y >= -1
      && box.x + box.width <= 376 && box.y + box.height <= 813);
    await page.screenshot({ path: join(ARTIFACTS, "workflow_mobile_inspector.png") });
    await page.keyboard.press("Escape");
    await inspector.waitFor({ state: "detached" });
  } finally {
    await closePage(page);
  }
});

for (const viewport of [
  { width: 320, height: 700 },
  { width: 375, height: 812 },
  { width: 667, height: 375 },
  { width: 768, height: 900 },
  { width: 1280, height: 900 },
  { width: 1440, height: 1000 },
]) {
  test("workflow stage canvas geometry @" + viewport.width + "x" + viewport.height, async () => {
    const page = await openApp({ ...viewport, sessionId: VISUAL_SESSION });
    try {
      await openWorkflowFromSwitcher(page);
      const surface = page.locator(".workflow-page");
      await surface.waitFor({ state: "visible" });
      // `.workflow-page` is also the loading placeholder: wait for the library page itself.
      await page.locator('.workflow-page[data-page="library"]').waitFor({ state: "visible" });
      await openTemplate(page, "Development");
      const canvas = page.locator(".workflow-canvas");
      await canvas.scrollIntoViewIfNeeded();
      await canvas.waitFor({ state: "visible" });
      assert.ok(await page.locator(".workflow-canvas-stage").count() >= 1);
      assert.ok(await page.locator(".workflow-canvas-stage-label").count() >= 1);
      const geometry = await page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>(".workflow-page")!.getBoundingClientRect();
        const canvas = document.querySelector<HTMLElement>(".workflow-canvas")!.getBoundingClientRect();
        return {
          surface: surface.toJSON(),
          canvas: canvas.toJSON(),
          viewport: { width: innerWidth, height: innerHeight },
          stages: document.querySelectorAll(".workflow-canvas-stage").length,
          shellMode: document.querySelector(".workflow-page")?.getAttribute("data-shell-mode"),
          canvasLayout: document.querySelector(".workflow-canvas")?.getAttribute("data-layout"),
        };
      });
      assert.ok(geometry.canvas.left >= -1 && geometry.canvas.right <= geometry.viewport.width + 1,
        "stage canvas leaves the viewport at " + viewport.width);
      assert.ok(geometry.canvas.top >= geometry.surface.top - 1 && geometry.canvas.height > 0,
        "stage canvas leaves its owning surface at " + viewport.width);
      for (const node of [canvas.locator(".workflow-canvas-node").first(), canvas.locator(".workflow-canvas-node").last()]) {
        await node.scrollIntoViewIfNeeded();
        const box = await node.boundingBox();
        assert.ok(box && box.y >= -1 && box.y + box.height <= viewport.height + 1,
          "first and last stages must remain reachable by scrolling");
      }
      if (geometry.canvas.height < viewport.height - 130) await canvas.scrollIntoViewIfNeeded();
      assert.equal(geometry.canvasLayout, geometry.shellMode === "phone" ? "phone" : "desktop");
      await assertNoOverflow(page, "workflow canvas@" + viewport.width);
      await page.screenshot({
        path: join(ARTIFACTS, "workflow_canvas_" + viewport.width + "x" + viewport.height + ".png"),
        fullPage: false,
      });
    } finally {
      await closePage(page);
    }
  });
}

test("workflow light theme, reduced motion, RTL, and safe-area geometry remain semantic", async () => {
  const light = await openApp({ width: 1280, height: 900, sessionId: VISUAL_SESSION, colorScheme: "light" });
  try {
    await openWorkflowFromSwitcher(light);
    assert.equal(await light.evaluate(() => document.documentElement.dataset.appearance), "light");
    await assertNoOverflow(light, "workflow light theme");
    // The library leads with its search field and "New workflow"; they stay
    // separate controls in a narrow window.
    const toolbarOverlap = await light.locator(".workflow-library-toolbar").evaluate((element) => {
      const controls = [...element.children].map((child) => child.getBoundingClientRect());
      return controls.some((box, index) => index > 0
        && box.left < controls[index - 1]!.right - 0.5 && box.top < controls[index - 1]!.bottom - 0.5);
    });
    assert.equal(toolbarOverlap, false, "library controls remain separate in a narrow window");
    await light.screenshot({ path: join(ARTIFACTS, "workflow_canvas_light.png"), fullPage: false });
  } finally {
    await closePage(light);
  }

  const reduced = await openApp({
    width: 375,
    height: 812,
    sessionId: VISUAL_SESSION,
    reducedMotion: "reduce",
    storage: { [`polyth.widgetLayout.${PROJECT_ID}`]: COMPOSER_LAUNCHER_LAYOUT },
  });
  try {
    await openWorkflowLauncher(reduced);
    const dialog = reduced.getByRole("dialog", { name: "Run a workflow" });
    await dialog.waitFor({ state: "visible" });
    const motion = await dialog.evaluate((element) => ({
      animations: element.getAnimations().length,
      reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
    }));
    assert.equal(motion.reduced, true);
    assert.equal(motion.animations, 0);
    await assertNoOverflow(reduced, "workflow reduced-motion launcher");
  } finally {
    await closePage(reduced);
  }

  const rtl = await openApp({
    width: 1280,
    height: 900,
    sessionId: VISUAL_SESSION,
    storage: { "polyth.locale": "ar" },
  });
  try {
    await openWorkflowFromSwitcher(rtl, "سير العمل");
    assert.equal(await rtl.evaluate(() => document.documentElement.dir), "rtl");
    await rtl.screenshot({ path: join(ARTIFACTS, "workflow_canvas_rtl.png"), fullPage: false });
    await assertNoOverflow(rtl, "workflow RTL");
    await rtl.locator(".workflow-card")
      .locator('.workflow-card-main[aria-label="فتح التطوير"]').click();
    await rtl.locator('.workflow-page[data-page="workflow"]').waitFor({ state: "visible" });
    await rtl.locator("#workflow-detail-tab-edit").click();
    const arrow = rtl.locator(".workflow-canvas-connector").first();
    const direction = () => arrow.evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: Math.round(matrix.a), y: Math.round(matrix.b) };
    });
    assert.deepEqual(await direction(), { x: 0, y: 1 }, "narrow RTL graph flows downward");
    await rtl.getByRole("button", { name: "Enter fullscreen", exact: true }).click();
    await waitForAnimations(rtl, '[data-package-window-owner="workflow"]');
    await rtl.locator(".workflow-canvas").scrollIntoViewIfNeeded();
    assert.deepEqual(await direction(), { x: -1, y: 0 }, "wide RTL graph flows from right to left");
    await assertNoOverflow(rtl, "workflow RTL graph");
    await rtl.screenshot({ path: join(ARTIFACTS, "workflow_canvas_rtl.png"), fullPage: false });
  } finally {
    await closePage(rtl);
  }

  const safe = await openApp({
    width: 375,
    height: 812,
    sessionId: VISUAL_SESSION,
    storage: { [`polyth.widgetLayout.${PROJECT_ID}`]: COMPOSER_LAUNCHER_LAYOUT },
  });
  try {
    await openWorkflowLauncher(safe);
    const dialog = safe.getByRole("dialog", { name: "Run a workflow" });
    await dialog.waitFor({ state: "visible" });
    // The phone launcher is a popover anchored above its composer trigger. It
    // tracks the real visual viewport (keyboard included) and the safe-area
    // insets, so emulate the insets and require it to stay inside that band.
    await safe.evaluate(() => {
      const root = document.documentElement.style;
      root.setProperty("--safe-top", "24px");
      root.setProperty("--safe-bottom", "34px");
      window.dispatchEvent(new Event("resize"));
    });
    await safe.waitForTimeout(150);
    const geometry = await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const trigger = document.querySelector<HTMLElement>(".composer-workflow")?.getBoundingClientRect();
      const footer = element.querySelector<HTMLElement>(".workflow-launch-footer")?.getBoundingClientRect();
      return { box: box.toJSON(), trigger: trigger?.toJSON(), footer: footer?.toJSON(), height: innerHeight };
    });
    assert.ok(geometry.box.top >= 24 - 1 && geometry.box.bottom <= geometry.height - 34 + 1,
      `launcher leaves the safe-area band: ${JSON.stringify(geometry.box)}`);
    assert.ok(geometry.trigger && geometry.box.bottom <= geometry.trigger.top + 1, "launcher opens above its trigger");
    assert.ok(geometry.footer && geometry.footer.bottom <= geometry.box.bottom + 1);
    await safe.screenshot({ path: join(ARTIFACTS, "workflow_launcher_safe_area.png"), fullPage: false });
  } finally {
    await closePage(safe);
  }
});

test("workflow emulated 200 percent scaling preserves canvas and controls", async () => {
  const page = await openApp({ width: 750, height: 900, sessionId: VISUAL_SESSION });
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 375,
      height: 450,
      screenWidth: 750,
      screenHeight: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await openWorkflowFromSwitcher(page);
    await openTemplate(page, "Development");
    await assertNoOverflow(page, "workflow 200% zoom");
    const geometry = await page.locator(".workflow-canvas").evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      viewport: innerWidth,
      deviceScaleFactor: devicePixelRatio,
      documentWidth: document.documentElement.scrollWidth,
    }));
    assert.equal(geometry.viewport, 375);
    assert.ok(geometry.deviceScaleFactor >= 1.99);
    assert.ok(geometry.documentWidth <= geometry.viewport + 1);
    await page.screenshot({ path: join(ARTIFACTS, "workflow_canvas_zoom_200.png"), fullPage: false });
  } finally {
    await closePage(page);
  }
});

test("package window resizes and preserves dynamic, pinned, and fullscreen behavior", async () => {
  const page = await openApp({ width: 1280, height: 900, sessionId: VISUAL_SESSION });
  try {
    await page.locator(".view-switcher").getByRole("button", { name: "Workflows", exact: true }).click();
    await page.waitForSelector(".workflow-page", { state: "visible", timeout: 8_000 });
    const window = page.locator('[data-package-window-owner="workflow"]');
    const expectMode = async (mode: "dynamic" | "pinned" | "fullscreen") => {
      await page.waitForFunction(
        (expected) => document.querySelector('[data-package-window-owner="workflow"]')?.getAttribute("data-package-window-mode") === expected,
        mode,
        { timeout: 8_000 },
      );
    };
    await expectMode("dynamic");

    const drag = async (selector: string, x: number, y: number) => {
      const handle = window.locator(selector);
      const box = await handle.boundingBox();
      assert.ok(box, selector + " resize handle is missing");
      // Grab horizontal edges near their start: transient notices occupy the
      // bottom corner, and a press on one is an outside press that closes the
      // window by design.
      const grabX = box.width > box.height ? box.x + Math.min(24, box.width / 4) : box.x + box.width / 2;
      await page.mouse.move(grabX, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, y);
      await page.mouse.up();
      await waitForAnimations(page, '[data-package-window-owner="workflow"]');
    };

    // Measure the window at rest: it slides in, and a mid-entrance box puts
    // the east handle under the right rail.
    await waitForAnimations(page, '[data-package-window-owner="workflow"]');
    const initial = await window.boundingBox();
    assert.ok(initial);
    const east = window.locator(".package-window-resize--e");
    const eastBox = await east.boundingBox();
    assert.ok(eastBox);
    const minWidth = Number(await east.getAttribute("aria-valuemin"));
    const delta = initial.width > minWidth + 24 ? -24 : 24;
    await drag(".package-window-resize--e", eastBox.x + eastBox.width / 2 + delta, initial.y + initial.height / 2);
    const resized = await window.boundingBox();
    assert.ok(resized && Math.abs(resized.x + resized.width - (initial.x + initial.width + delta)) <= 3);

    await drag(".package-window-resize--w", 0, initial.y + initial.height / 2);
    const widest = await window.boundingBox();
    assert.ok(widest && widest.width >= initial.width);
    await drag(".package-window-resize--w", 1270, widest.y + widest.height / 2);
    const narrowest = await window.boundingBox();
    assert.ok(narrowest && narrowest.width < widest.width && narrowest.width >= 380);

    const shell = await page.locator(".app-shell").boundingBox();
    assert.ok(shell);
    await drag(".package-window-resize--n", narrowest.x + narrowest.width / 2, narrowest.y + 24);
    const north = await window.boundingBox();
    assert.ok(north && north.height <= narrowest.height && north.y >= narrowest.y);
    await drag(".package-window-resize--s", north.x + north.width / 2, shell.y + shell.height - 8);
    const tallest = await window.boundingBox();
    assert.ok(tallest && tallest.height >= north.height);
    await drag(".package-window-resize--s", tallest.x + tallest.width / 2, 100);
    const shortest = await window.boundingBox();
    assert.ok(shortest && shortest.height <= tallest.height && shortest.height >= 240);

    const keyboardResize = window.locator('.package-window-resize--e[role="separator"]');
    await keyboardResize.focus();
    await page.keyboard.press("End");
    await waitForAnimations(page, '[data-package-window-owner="workflow"]');
    const keyboardWide = await window.boundingBox();
    await page.keyboard.press("Home");
    await waitForAnimations(page, '[data-package-window-owner="workflow"]');
    const keyboardNarrow = await window.boundingBox();
    assert.ok(keyboardWide && keyboardNarrow && keyboardWide.width > keyboardNarrow.width);

    const dockAction = window.getByRole("button", { name: /Dock (beside|below) Chat/ }).first();
    if (await dockAction.count()) {
      await dockAction.click();
      await expectMode("pinned");
      await window.getByRole("button", { name: "Unpin window", exact: true }).click();
      await expectMode("dynamic");
    }
    const fullscreen = window.getByRole("button", { name: "Enter fullscreen", exact: true });
    await fullscreen.click();
    await expectMode("fullscreen");
    assert.equal(await page.locator(".header").isVisible(), true);
    assert.equal(await window.getAttribute("aria-modal"), null);
    await page.keyboard.press("Escape");
    await expectMode("dynamic");
    const systemLabels = await window.locator(".module-view-system-action").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? ""),
    );
    assert.ok(systemLabels.some((label) => /fullscreen|window|chat/i.test(label)), "window controls use no current semantic labels");
    await page.locator(".composer-editor[data-composer-input]").click();
    await window.waitFor({ state: "detached" });
  } finally {
    await closePage(page);
  }
});

// These cases start real OpenCode runs. Runtime reconciliation then marks the
// seeded fixture sessions as unknown, so they run after every seeded case.
test("composer runs the bundled Build + Review through the fake provider and the chat continues below its result", async () => {
  const page = await openApp({
    width: 1280,
    height: 900,
    sessionId: SESSIONS.main,
    storage: { [`polyth.widgetLayout.${PROJECT_ID}`]: COMPOSER_LAUNCHER_LAYOUT },
  });
  try {
    const parentResponse = await page.request.post(`${BASE}/api/sessions`, { data: {
      projectId: PROJECT_ID,
      title: "Workflow role titles",
      harness: { mode: "pinned", harnessId: "opencode" },
      model: { providerID: "synthetic", modelID: "fable-mini" },
    } });
    assert.equal(parentResponse.status(), 200);
    const parent = await parentResponse.json() as { id: string };
    await page.goto(`${BASE}/p/${PROJECT_ID}/s/${parent.id}`, { waitUntil: "load" });
    await page.waitForFunction(async (id) => {
      const modulePath = "/shell-api/apps/web/src/store__ts.js";
      const { getState } = await import(modulePath);
      return getState().activeSessionId === id;
    }, parent.id);
    const editor = page.locator(".composer-editor[data-composer-input]");
    await editor.fill("Check the synthetic workflow provider result");
    await openWorkflowLauncher(page);
    const dialog = page.getByRole("dialog", { name: "Run a workflow" });
    await page.screenshot({ path: join(ARTIFACTS, "workflow_launcher_desktop.png") });
    const buildReviewRun = dialog.getByRole("button", { name: "Run Build + Review workflow", exact: true });
    await buildReviewRun.waitFor({ state: "visible" });
    await buildReviewRun.click();
    await page.waitForFunction(() =>
      (document.querySelector(".composer-editor[data-composer-input]") as HTMLTextAreaElement | null)?.value === "",
      undefined, { timeout: 12_000 });

    await page.waitForSelector(".app.mode-chat.view-session", { state: "visible", timeout: 8_000 });
    const timeline = page.locator(".workflow-timeline-card").first();
    await timeline.waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.querySelector(".workflow-timeline-card")?.classList.contains("status-done") === true,
      undefined,
      { timeout: 16_000 },
    );
    const result = (await timeline.locator(".workflow-timeline-result p").textContent())?.trim() ?? "";
    assert.ok(result.length > 0, "completed Build + Review run did not publish a result");
    assert.match(result, /Synthetic reply|synthetic/i);
    assert.equal(await timeline.locator(".form-error").count(), 0);

    await page.reload({ waitUntil: "load" });
    await page.locator(".workflow-timeline-card.status-done").waitFor({ state: "visible" });
    assert.equal(await page.locator(".workflow-timeline-card").count(), 1,
      "reconnect must replay the admitted run without creating another");
    assert.equal((await timeline.locator(".workflow-timeline-result p").textContent())?.trim(), result);

    const run = await page.evaluate(async (projectId) => {
      const runs = await fetch(`/api/workflow-runs?projectId=${projectId}`).then((response) => response.json());
      return runs.find((item: WorkflowRunDto) => item.input === "Check the synthetic workflow provider result");
    }, PROJECT_ID) as WorkflowRunDto;
    assert.ok(run, "the admitted workflow must survive reload");
    assert.equal(run.nodes.length, 2, "the builder and its reviewer");
    const node = run.nodes[0]!;
    assert.ok(node.sessionId);
    const child = await page.evaluate(async (id) =>
      fetch(`/api/sessions/${id}`).then((response) => response.json()), node.sessionId) as SessionProjection;
    assert.equal(child.title, node.role.trim(), "completed and replayed children keep their execution role");
    assert.equal(child.titleSource, "manual", "runtime title generation must not replace the role");

    // No composer hand-off: the parent agent receives the result with the
    // next prompt, and that prompt reads below the card and its result.
    assert.equal(await timeline.getByRole("button", { name: "Continue in chat", exact: true }).count(), 0);
    await editor.fill("Apply the workflow result");
    await editor.press("Enter");
    const followUp = page.locator(".timeline > .msg.user", { hasText: "Apply the workflow result" });
    await followUp.waitFor({ state: "visible", timeout: 8_000 });
    assert.equal(await page.evaluate(() => {
      const card = document.querySelector(".workflow-timeline-card");
      const prompt = [...document.querySelectorAll(".timeline > .msg.user")].at(-1);
      return !!card && !!prompt && (card.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }), true, "the follow-up prompt renders below the workflow card");
    const prompted = await page.evaluate(async (id) => {
      const events = await fetch(`/api/sessions/${id}/events?afterSeq=0`).then((response) => response.json()) as Array<{ type: string; data: { text?: string; recoveryContext?: string } }>;
      return events.find((event) => event.type === "user/message" && event.data.text === "Apply the workflow result")?.data;
    }, parent.id);
    assert.ok(prompted?.recoveryContext?.includes(result), "the follow-up prompt carried the workflow result to the parent agent");
    await page.screenshot({ path: join(ARTIFACTS, "workflow_build_review_provider_result.png"), fullPage: false });
    await page.getByRole("button", { name: "Expand: Subagents: 2", exact: true }).click();
    await timeline.getByRole("button", { name: `Open ${node.role} child session`, exact: true }).click();
    await page.waitForURL(`**/s/${node.sessionId}`);
    const activeTitle = page.locator('.session-row.active .session-title-text');
    await activeTitle.waitFor({ state: "visible" });
    assert.equal(await activeTitle.textContent(), child.title, "the navigator displays the execution role");
    await page.screenshot({ path: join(ARTIFACTS, "workflow_child_role_title.png"), fullPage: false });
  } finally {
    await closePage(page);
  }
});

test("completed verification unlocks the finalizer and displays its result after reload", async () => {
  let page = await openApp({ width: 1280, height: 900, sessionId: VISUAL_SESSION });
  try {
    const launched = await page.evaluate(async ({ projectId }) => {
      const post = async (path: string, body: unknown) => {
        const response = await fetch(path, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        return response.json();
      };
      // Fresh canonical sessions avoid using an imported fixture's uncertain
      // runtime as execution authority. Both nodes pin the synthetic provider.
      const parent = await post("/api/sessions", { projectId, title: "Verification and finalization" });
      const workflow = await post("/api/workflows", {
        projectId, name: "Verification and finalization",
        nodes: ["verify", "finalize"].map((id) => ({
          id, role: id === "verify" ? "Verifier" : "Finalizer", prompt: `Complete ${id} and report the result.`,
          harness: { mode: "pinned", harnessId: "opencode" },
          model: { providerID: "synthetic", modelID: "fable-mini" },
        })),
        edges: [{ id: "verify-finalize", source: "verify", target: "finalize" }],
      });
      const run = await post(`/api/workflows/${workflow.id}/run`, {
        sessionId: parent.id, input: "Verify the synthetic change, then finalize it.",
        launch: { clientOperationId: "verify-finalize-browser" },
      });
      return { runId: run.id, parentId: parent.id };
    }, { projectId: PROJECT_ID });
    await closePage(page);
    page = await openApp({ width: 1280, height: 900, sessionId: launched.parentId });
    const timeline = page.locator(".workflow-timeline-card.status-done");
    await timeline.waitFor({ state: "visible", timeout: 12_000 });
    const run = await page.evaluate(async (runId) =>
      fetch(`/api/workflow-runs/${runId}`).then((response) => response.json()), launched.runId) as WorkflowRunDto;
    assert.equal(run.status, "done");
    assert.deepEqual(run.nodes.map((node) => node.status), ["done", "done"]);
    assert.match(run.nodes[1]?.prompt ?? "", /## Verifier \(verify\)/);
    assert.ok(run.nodes[1]?.prompt?.includes(run.nodes[0]!.sessionId!));
    assert.equal(run.result, run.nodes[1]?.output);
    assert.match((await timeline.locator(".workflow-timeline-result").textContent()) ?? "", /Synthetic reply/);
    await page.reload({ waitUntil: "domcontentloaded" });
    await timeline.waitFor({ state: "visible", timeout: 12_000 });
    await page.screenshot({ path: join(ARTIFACTS, "workflow_verify_finalize_result.png"), fullPage: false });
  } finally {
    await closePage(page);
  }
});

test("workflow view starts a run, repeats it, and repeats it again after a reload", async () => {
  const page = await openApp({ width: 1280, height: 900, sessionId: VISUAL_SESSION });
  try {
    const setup = await page.evaluate(async ({ projectId }) => {
      const post = async (path: string, body: unknown) => {
        const response = await fetch(path, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        return response.json();
      };
      const parent = await post("/api/sessions", { projectId, title: "Workflow view run parent" });
      const workflow = await post("/api/workflows", {
        projectId, name: "View run check",
        nodes: [{
          id: "agent", role: "Agent", prompt: "Reply briefly.",
          harness: { mode: "pinned", harnessId: "opencode" },
          model: { providerID: "synthetic", modelID: "fable-mini" },
        }],
        edges: [],
      });
      return { parentId: parent.id as string, workflowId: workflow.id as string };
    }, { projectId: PROJECT_ID });
    const runs = () => page.evaluate(async ({ projectId, workflowId }) => {
      const all = await fetch(`/api/workflow-runs?projectId=${projectId}`).then((response) => response.json()) as
        Array<{ workflowId: string; status: string; input: string }>;
      return all.filter((run) => run.workflowId === workflowId).map((run) => ({ status: run.status, input: run.input }));
    }, { projectId: PROJECT_ID, workflowId: setup.workflowId });
    const waitForRuns = (count: number) => page.waitForFunction(async ({ projectId, workflowId, count }) => {
      const all = await fetch(`/api/workflow-runs?projectId=${projectId}`).then((response) => response.json()) as
        Array<{ workflowId: string; status: string }>;
      const mine = all.filter((run) => run.workflowId === workflowId);
      return mine.length === count && mine.every((run) => run.status === "done");
    }, { projectId: PROJECT_ID, workflowId: setup.workflowId, count }, { timeout: 30_000 });
    const openView = async () => {
      await page.goto(`${BASE}/p/${PROJECT_ID}/s/${setup.parentId}`, { waitUntil: "load" });
      await page.waitForSelector(".composer-card", { state: "visible" });
      await openWorkflowFromSwitcher(page);
      await page.locator('.workflow-card-main[aria-label="Open View run check"]').click();
    };

    await openView();
    // Choosing a saved workflow opens its page on the Run tab.
    assert.equal(await page.locator(".workflow-page").getAttribute("data-page"), "workflow");
    await page.locator(".workflow-run-form textarea").fill("Check the view run path");
    await page.locator(".workflow-run-footer").getByRole("button", { name: "Run workflow", exact: true }).click();
    await waitForRuns(1);
    await page.locator(".workflow-run-results .workflow-run-heading .workflow-status.status-done").waitFor({ state: "visible" });

    await page.locator(".workflow-run-results").getByRole("button", { name: "Run again", exact: true }).click();
    await waitForRuns(2);

    // After a reload no hand-off carries the request, yet Run again still repeats it.
    await openView();
    await page.locator(".workflow-run-results").waitFor({ state: "visible" });
    await page.locator(".workflow-run-results").getByRole("button", { name: "Run again", exact: true }).click();
    await waitForRuns(3);
    assert.deepEqual((await runs()).map((run) => run.input), Array(3).fill("Check the view run path"));
  } finally {
    await closePage(page);
  }
});
