// Workflow-orchestration browser gate. This is intentionally outside the
// default *.test.ts glob because it builds a disposable runtime and drives
// real Chrome through the complete launch/monitor/HITL/stop/retry journey.
//
// Run explicitly:
//   POLYTH_LIVE_ARTIFACTS=/opt/cursor/artifacts \
//     node --test apps/web/test/workflowOrchestration.live.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { JsonObject, WorkflowRunDto } from "@polyth/contracts";
import {
  FIXTURE_BIN,
  FIXTURE_DATA,
  FIXTURE_HOME,
  OC_SEED,
  OC_STATE,
  PROJECT_ID,
  REPO_ROOT,
  SESSIONS,
  buildComposerDiscFixture,
} from "./composerDiscFixtureSetup.mjs";

const BASE = "http://127.0.0.1:4467";
const ARTIFACTS = process.env.POLYTH_LIVE_ARTIFACTS ?? "/tmp/polyth-workflow-artifacts";
const PERSONA = JSON.stringify({ persona: "engineer", plugins: [] });
const MANUAL_PARENT = "workflow-manual-parent";
const MANUAL_CHILD = "workflow-manual-child";
const ERROR_PARENT = "workflow-error-parent";
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
  options: { pipe: "ancestors", permissions: "manual", maxParallel: 1, nodeTimeoutMs: 30_000 },
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

const errorRun: WorkflowRunDto = {
  id: "run-error",
  workflowId: WORKFLOW_RECOVERY,
  projectId: PROJECT_ID,
  parentSessionId: ERROR_PARENT,
  name: "Failure recovery",
  input: "Recover the failed release",
  options: { pipe: "ancestors", permissions: "auto", maxParallel: 1, nodeTimeoutMs: 30_000 },
  status: "error",
  startedAt: now - 2_000,
  finishedAt: now - 1_000,
  layers: [["recover"]],
  nodes: [{
    id: "recover",
    role: "Recovery agent",
    status: "error",
    sessionId: "workflow-error-child",
    error: "Synthetic deploy check failed with exit code 17",
    startedAt: now - 2_000,
    finishedAt: now - 1_000,
  }],
};

const chromiumCandidates = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/local/bin/google-chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
];

let browser: Browser;
let server: ChildProcess | undefined;
const contexts: BrowserContext[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const eventData = (run: WorkflowRunDto): JsonObject => ({
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
  await mkdir(ARTIFACTS, { recursive: true });
  await buildComposerDiscFixture();
  await writeFile(join(FIXTURE_DATA, "workflows.json"), `${JSON.stringify({ v: 1, workflows }, null, 2)}\n`);

  const { createStore } = await import("../../../packages/session/src/index.ts");
  const store = createStore(join(FIXTURE_DATA, "sessions.db"));
  const projection = (id: string, title: string, status = "idle") => ({
    id,
    projectId: PROJECT_ID,
    title,
    status,
    createdAt: now - 10_000,
    updatedAt: now,
  });

  await store.append(MANUAL_PARENT, "session/created", { title: "Manual approval parent" }, { ignorable: true });
  await store.append(MANUAL_PARENT, "workflow/run-started", eventData(manualRun), { ignorable: true });
  await store.append(MANUAL_PARENT, "workflow/node-progress", {
    runId: manualRun.id,
    nodeId: "review",
    node: manualRun.nodes[0]!,
  }, { ignorable: true });
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
  await store.append(ERROR_PARENT, "workflow/node-progress", {
    runId: errorRun.id,
    nodeId: "recover",
    node: errorRun.nodes[0]!,
  }, { ignorable: true });
  await store.append(ERROR_PARENT, "workflow/run-completed", {
    runId: errorRun.id,
    status: "error",
    finishedAt: errorRun.finishedAt!,
  }, { ignorable: true });
  await store.upsertProjection(projection(ERROR_PARENT, "Failed workflow parent"));
  await store.close();

  execFileSync(process.execPath, ["apps/web/build.ts"], { cwd: REPO_ROOT, stdio: "pipe" });
  server = spawn(process.execPath, ["packages/server/src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: FIXTURE_HOME,
      XDG_CONFIG_HOME: join(FIXTURE_HOME, ".config"),
      XDG_DATA_HOME: join(FIXTURE_HOME, ".local/share"),
      OPENCODE_CONFIG_DIR: join(FIXTURE_HOME, "opencode"),
      POLYTH_DATA_DIR: FIXTURE_DATA,
      PORT: "4467",
      PATH: `${FIXTURE_BIN}:${process.env.PATH ?? ""}`,
      MSGACT_OC_SEED: OC_SEED,
      MSGACT_OC_STATE: OC_STATE,
      POLYTH_FAKE_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.resume();
  server.stderr?.resume();

  const deadline = Date.now() + 30_000;
  for (;;) {
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
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
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
});

interface OpenOptions {
  width: number;
  height: number;
  sessionId: string;
  runs?: WorkflowRunDto[];
  record?: boolean;
}

async function openApp(options: OpenOptions): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    reducedMotion: "reduce",
    serviceWorkers: "block",
    ...(options.record ? { recordVideo: { dir: ARTIFACTS, size: { width: options.width, height: options.height } } } : {}),
  });
  contexts.push(context);
  await context.addInitScript(({ persona, projectId }: { persona: string; projectId: string }) => {
    localStorage.setItem("polyth.prefs", persona);
    localStorage.setItem(`polyth.projectSetup.v1.${projectId}`, "completed");
  }, { persona: PERSONA, projectId: PROJECT_ID });
  if (options.runs) {
    await context.route("**/api/workflow-runs?projectId=*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(options.runs) }));
    for (const run of options.runs) {
      await context.route(`**/api/workflow-runs/${run.id}`, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) }));
    }
  }
  const page = await context.newPage();
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${options.sessionId}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(".composer-card", { state: "visible", timeout: 15_000 });
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
        const box = element.getBoundingClientRect();
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

test("complete workflow journey remains synchronized, accessible, and responsive", async () => {
  const page = await openApp({
    width: 1280,
    height: 900,
    sessionId: SESSIONS.main,
    record: true,
  });
  const context = page.context();
  const video = page.video();

  const editor = page.locator(".composer-editor");
  await editor.fill("Audit release candidate 42");
  const launcherButton = page.getByRole("button", { name: "Run draft with a workflow" });
  await launcherButton.focus();
  await launcherButton.click();
  const dialog = page.getByRole("dialog", { name: "Run a workflow" });
  await dialog.waitFor({ state: "visible" });
  assert.equal(await page.locator(".workflow-launch-task textarea").inputValue(), "Audit release candidate 42");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA");
  assert.equal(await dialog.getAttribute("aria-modal"), "true");
  assert.equal(await dialog.getAttribute("aria-describedby"), "workflow-launch-description");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Close workflow launcher");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Open workflow builder");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Close workflow launcher");

  await dialog.getByRole("button", { name: "Run Release pipeline workflow" }).click();
  await page.waitForSelector(".workflow-page", { state: "visible" });
  await page.waitForSelector(".workflow-run-results .workflow-status.status-running", { state: "visible" });
  await page.waitForSelector(".workflow-run-indicator", { state: "visible" });
  await page.waitForSelector(".sb-workflow", { state: "visible" });
  assert.match(await page.locator(".workflow-run-form textarea").inputValue(), /Audit release candidate 42/);

  await page.getByRole("button", { name: "Back to chat" }).click();
  const timeline = page.locator(".workflow-timeline-card");
  await timeline.waitFor({ state: "visible" });
  assert.match(await timeline.getAttribute("aria-label") ?? "", /Workflow Release pipeline, Running/);
  assert.equal(await editor.inputValue(), "", "the workflow launch consumes the submitted draft");
  await page.screenshot({ path: join(ARTIFACTS, "workflow_running_timeline.png") });

  const stop = timeline.getByRole("button", { name: "Stop Release pipeline workflow run" });
  await stop.click();
  await page.waitForSelector(".workflow-timeline-card.status-stopped", { state: "visible" });
  assert.match(await timeline.getAttribute("aria-label") ?? "", /Stopped/);
  await page.waitForSelector(".workflow-run-indicator", { state: "detached" });
  await page.waitForSelector(".sb-workflow", { state: "detached" });
  await timeline.getByRole("button", { name: "View workflow" }).click();
  await page.waitForSelector(".workflow-run-notice:not(.waiting):not(.error)", { state: "visible" });
  assert.match(await page.locator(".workflow-run-notice").textContent() ?? "", /run was stopped/i);
  await page.screenshot({ path: join(ARTIFACTS, "workflow_stopped_everywhere.png") });
  await assertNoOverflow(page, "desktop stopped workflow");

  await context.close();
  const contextIndex = contexts.indexOf(context);
  if (contextIndex >= 0) contexts.splice(contextIndex, 1);
  if (video) await video.saveAs(join(ARTIFACTS, "workflow_complete_journey.webm"));

  const manual = await openApp({ width: 1280, height: 900, sessionId: MANUAL_PARENT, runs: [manualRun] });
  await manual.waitForSelector(".workflow-timeline-card .needs-human", { state: "visible" });
  assert.match(await manual.locator(".workflow-timeline-summary").textContent() ?? "", /1 waiting for you/);
  await manual.getByRole("button", { name: "Review and respond in Reviewer child session" }).click();
  await manual.waitForSelector(".perm-banner", { state: "visible" });
  assert.match(manual.url(), new RegExp(`/s/${MANUAL_CHILD}$`));
  assert.match(await manual.locator(".perm-banner").textContent() ?? "", /Run production deploy check/);
  await manual.screenshot({ path: join(ARTIFACTS, "workflow_manual_approval_handoff.png") });
  await manual.context().close();

  const failed = await openApp({ width: 1280, height: 900, sessionId: ERROR_PARENT });
  await failed.waitForSelector(".workflow-timeline-card.status-error", { state: "visible" });
  assert.match(await failed.locator(".workflow-timeline-card").textContent() ?? "", /Synthetic deploy check failed/);
  await failed.getByRole("button", { name: "View workflow" }).click();
  await failed.waitForSelector(".workflow-run-notice.error", { state: "visible" });
  assert.match(await failed.locator(".workflow-run-card .form-error").textContent() ?? "", /exit code 17/);
  await failed.getByRole("button", { name: "Retry full workflow" }).click();
  await failed.waitForSelector(".workflow-run-results .workflow-status.status-running", { state: "visible" });
  await failed.screenshot({ path: join(ARTIFACTS, "workflow_failed_retry.png") });
  await failed.context().close();

  for (const width of [375, 320]) {
    const phone = await openApp({ width, height: width === 375 ? 812 : 700, sessionId: MANUAL_PARENT, runs: [manualRun] });
    await phone.waitForSelector(".workflow-timeline-card", { state: "visible" });
    await assertNoOverflow(phone, `timeline@${width}`);
    const touchTargets = await phone.locator(".workflow-timeline-card button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return { label: button.textContent?.trim(), width: box.width, height: box.height };
      }));
    for (const target of touchTargets) {
      assert.ok(target.height >= 44, `timeline@${width}: ${target.label} is only ${target.height}px tall`);
    }

    await phone.getByRole("button", { name: "Browse workflows" }).click();
    await phone.waitForSelector(".workflow-launch-dialog", { state: "visible" });
    await assertNoOverflow(phone, `launcher@${width}`);
    const dialogBox = await phone.locator(".workflow-launch-dialog").boundingBox();
    assert.ok(dialogBox && dialogBox.width <= width - 20 + 1, `launcher@${width}: dialog is too wide`);
    await phone.keyboard.press("Escape");
    await phone.getByRole("button", { name: "View workflow" }).click();
    await phone.waitForSelector(".workflow-page", { state: "visible" });
    await assertNoOverflow(phone, `workflow view@${width}`);
    await phone.screenshot({ path: join(ARTIFACTS, `workflow_mobile_${width}.png`), fullPage: false });
    await phone.context().close();
  }
});
