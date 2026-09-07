// Workflow-orchestration browser gate. workflowOrchestration.test.ts imports
// this suite so the disposable real-Chrome journey is part of `npm test`.
//
// Run explicitly:
//   POLYTH_LIVE_ARTIFACTS=/opt/cursor/artifacts \
//     node --test apps/web/test/workflowOrchestration.live.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { JsonObject, SessionProjection, WorkflowRunDto } from "@polyth/contracts";
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
const BASELINES = join(REPO_ROOT, "apps/web/test/baselines");
/** Playwright records with its own ffmpeg, not the system binary. */
const CAN_RECORD_VIDEO = (() => {
  const root = join(homedir(), ".cache/ms-playwright");
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith("ffmpeg-")) continue;
      const dir = join(root, name);
      if (["ffmpeg-linux", "ffmpeg-mac", "ffmpeg-win64.exe"].some((file) => existsSync(join(dir, file)))) {
        return true;
      }
    }
  } catch {
    // Playwright cache missing; geometry assertions do not need video.
  }
  return false;
})();
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

interface PngPixels {
  width: number;
  height: number;
  data: Uint8Array;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left
    : upDistance <= upperLeftDistance
      ? up
      : upperLeft;
}

function decodePng(buffer: Buffer): PngPixels {
  const signature = buffer.subarray(0, 8).toString("hex");
  assert.equal(signature, "89504e470d0a1a0a", "visual baseline is not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const compressed: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "visual baseline must use 8-bit PNG channels");
      colorType = data[9]!;
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels > 0, `unsupported PNG color type ${colorType}`);
  const rowSize = width * channels;
  const inflated = inflateSync(Buffer.concat(compressed));
  const raw = new Uint8Array(height * rowSize);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++]!;
    const rowOffset = y * rowSize;
    for (let x = 0; x < rowSize; x++) {
      const value = inflated[sourceOffset++]!;
      const left = x >= channels ? raw[rowOffset + x - channels]! : 0;
      const up = y > 0 ? raw[rowOffset - rowSize + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? raw[rowOffset - rowSize + x - channels]! : 0;
      const reconstructed = filter === 0
        ? value
        : filter === 1
          ? value + left
          : filter === 2
            ? value + up
            : filter === 3
              ? value + Math.floor((left + up) / 2)
              : filter === 4
                ? value + paeth(left, up, upperLeft)
                : Number.NaN;
      assert.ok(Number.isFinite(reconstructed), `unsupported PNG filter ${filter}`);
      raw[rowOffset + x] = reconstructed & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: raw };
  const rgba = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < raw.length; source += 3, target += 4) {
    rgba[target] = raw[source]!;
    rgba[target + 1] = raw[source + 1]!;
    rgba[target + 2] = raw[source + 2]!;
    rgba[target + 3] = 255;
  }
  return { width, height, data: rgba };
}

async function assertVisualBaseline(page: Page, name: string, selector = ".workflow-page"): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.visualBaseline = "true";
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  const actual = await page.locator(selector).screenshot({
    animations: "disabled",
    caret: "hide",
  });
  const path = join(BASELINES, `${name}.png`);
  if (process.env.UPDATE_WORKFLOW_BASELINES === "1") {
    await mkdir(BASELINES, { recursive: true });
    await writeFile(path, actual);
    return;
  }
  const expected = await readFile(path);
  const actualPixels = decodePng(actual);
  const expectedPixels = decodePng(expected);
  assert.deepEqual(
    { width: actualPixels.width, height: actualPixels.height },
    { width: expectedPixels.width, height: expectedPixels.height },
    `${name}: visual baseline dimensions changed`,
  );
  let changed = 0;
  for (let index = 0; index < actualPixels.data.length; index += 4) {
    const difference = Math.max(
      Math.abs(actualPixels.data[index]! - expectedPixels.data[index]!),
      Math.abs(actualPixels.data[index + 1]! - expectedPixels.data[index + 1]!),
      Math.abs(actualPixels.data[index + 2]! - expectedPixels.data[index + 2]!),
      Math.abs(actualPixels.data[index + 3]! - expectedPixels.data[index + 3]!),
    );
    if (difference > 24) changed++;
  }
  const ratio = changed / (actualPixels.width * actualPixels.height);
  assert.ok(ratio <= 0.012, `${name}: ${(ratio * 100).toFixed(2)}% of pixels changed (limit 1.20%)`);
}

async function waitForAnimations(page: Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
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
  await mkdir(ARTIFACTS, { recursive: true });
  await buildComposerDiscFixture();
  await writeFile(join(FIXTURE_DATA, "workflows.json"), `${JSON.stringify({ v: 1, workflows }, null, 2)}\n`);

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
  }, { ignorable: true });
  await store.upsertProjection(projection(ERROR_PARENT, "Failed workflow parent"));

  await store.append(VISUAL_SESSION, "session/created", { title: "Workflow visual baseline" }, { ignorable: true });
  await store.upsertProjection(projection(VISUAL_SESSION, "Workflow visual baseline"));
  await store.close();

  execFileSync(process.execPath, ["--experimental-strip-types", "apps/web/buildPackages.ts"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  execFileSync(process.execPath, ["--experimental-strip-types", "apps/web/build.ts"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  server = spawn(process.execPath, ["--experimental-strip-types", "packages/server/src/index.ts"], {
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
      MSGACT_TURN_DELAY_MS: "1000",
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
    ...(options.record && CAN_RECORD_VIDEO ? { recordVideo: { dir: ARTIFACTS, size: { width: options.width, height: options.height } } } : {}),
  });
  contexts.push(context);
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
  await page.goto(`${BASE}/p/${PROJECT_ID}/s/${options.sessionId}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 15_000 });
  await page.waitForSelector(".composer-card", { state: "visible", timeout: 15_000 });
  await page.waitForSelector(".app.mode-chat.view-session", { state: "visible", timeout: 15_000 });
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
          ".workflow-definition-list, .mobile-shortcut-rail, .composer-mobile-extensions",
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

async function assertTouchTargets(page: Page, selector: string, label: string): Promise<void> {
  const targets = await page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return {
          label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
          width: box.width,
          height: box.height,
        };
      }));
  assert.ok(targets.length > 0, `${label}: no visible targets found`);
  for (const target of targets) {
    assert.ok(
      target.width >= 44 && target.height >= 44,
      `${label}: ${target.label} is only ${target.width}×${target.height}px`,
    );
  }
}

async function assertCarouselGeometry(page: Page, label: string): Promise<void> {
  const list = page.locator(".workflow-definition-list");
  const items = list.locator(".workflow-definition");
  const count = await items.count();
  if (count < 2) return;
  const initial = await list.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const first = element.querySelector<HTMLElement>(".workflow-definition")!.getBoundingClientRect();
    return {
      clipLeft: box.left,
      clipRight: box.right,
      cardWidth: first.width,
      peek: box.width - first.width,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  assert.ok(initial.scrollWidth > initial.clientWidth, `${label}: carousel does not scroll`);
  assert.ok(initial.peek >= 20 && initial.peek <= 36, `${label}: carousel peek ${initial.peek}px is not deliberate`);

  for (const index of [0, Math.floor(count / 2), count - 1]) {
    await items.nth(index).evaluate((element) => element.scrollIntoView({ block: "nearest", inline: "nearest" }));
    await page.waitForFunction((itemIndex) => {
      const list = document.querySelector<HTMLElement>(".workflow-definition-list");
      const item = list?.querySelectorAll<HTMLElement>(".workflow-definition")[itemIndex];
      if (!list || !item) return false;
      const clip = list.getBoundingClientRect();
      const box = item.getBoundingClientRect();
      return box.left >= clip.left - 1 && box.right <= clip.right + 1;
    }, index);
    const [clip, item] = await Promise.all([list.boundingBox(), items.nth(index).boundingBox()]);
    assert.ok(
      clip && item && item.x >= clip.x - 1 && item.x + item.width <= clip.x + clip.width + 1,
      `${label}: item ${index + 1}/${count} cannot be fully revealed`,
    );
  }
  await list.evaluate((element, scrollLeft) => element.scrollTo({ left: scrollLeft }), initial.scrollLeft);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function openWorkflowFromSwitcher(page: Page, label = "Workflows"): Promise<void> {
  const width = await page.evaluate(() => innerWidth);
  if (width > 820) {
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
    await workspace.getByRole("button", { name: "Edit", exact: true }).click();
    const libraryItem = workspace.getByRole("button", { name: new RegExp(`^(Add ${label}|${label} already added)$`) });
    await libraryItem.waitFor({ state: "visible" });
    if ((await libraryItem.getAttribute("aria-label")) === `Add ${label}`) await libraryItem.click();
    await workspace.getByRole("button", { name: "Done", exact: true }).click();
    await workspace.getByRole("button", { name: label, exact: true }).click();
  }
  await page.waitForSelector(".workflow-page", { state: "visible" });
  await waitForAnimations(page, '.module-view[data-module-id="workflow"]');
  await waitForAnimations(page, '[data-package-window-owner="workflow"]');
}

async function closeWorkflowModule(page: Page): Promise<void> {
  await page.locator('.module-view[data-module-id="workflow"] .module-view-close').click();
  await page.waitForSelector(".app.mode-chat.view-session", { state: "visible" });
}

async function openWorkflowLauncher(page: Page): Promise<void> {
  const launcher = page.getByRole("button", { name: "Run workflow" });
  if (!await launcher.isVisible().catch(() => false)) await page.locator(".composer-editor").click();
  await launcher.click();
  await page.getByRole("dialog", { name: "Run a workflow" }).waitFor({ state: "visible" });
  await waitForAnimations(page, ".workflow-launch-dialog");
}

test("enabled workflow package is discoverable from Chat and Goals", async () => {
  const page = await openApp({ width: 1280, height: 900, sessionId: SESSIONS.main });
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
  await page.context().close();
});

test("current compact navigation exposes Workflows on phones and tablets", async () => {
  for (const viewport of [
    { width: 320, height: 700 },
    { width: 375, height: 812 },
    { width: 768, height: 900 },
  ]) {
    const page = await openApp({ ...viewport, sessionId: SESSIONS.main });
    await openWorkflowFromSwitcher(page);
    await page.waitForSelector(".workflow-page", { state: "visible" });
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
    await page.context().close();
  }
});

test("chat page load repairs a hidden workflow launcher placement", async () => {
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
      },
    },
  });
  const page = await openApp({
    width: 1280,
    height: 900,
    sessionId: SESSIONS.main,
    storage: { [`polyth.widgetLayout.${PROJECT_ID}`]: staleLayout },
  });

  const composer = page.locator(".composer-simple");
  await composer.waitFor({ state: "visible" });
  const launcher = composer.locator(".composer-workflow");
  assert.equal(await launcher.count(), 1, "chat must mount exactly one workflow launcher");
  assert.equal(await launcher.getAttribute("aria-label"), "Run workflow");
  assert.equal(await launcher.getAttribute("aria-haspopup"), "dialog");
  const repaired = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "{}").widgets?.["workflow.composer-action"]?.visible,
    `polyth.widgetLayout.${PROJECT_ID}`,
  );
  assert.equal(repaired, true, "page load repairs the stale hidden placement");

  await composer.screenshot({ path: join(ARTIFACTS, "workflow_launcher_button_repaired.png") });
  await launcher.click();
  await page.getByRole("dialog", { name: "Run a workflow" }).waitFor({ state: "visible" });
  await waitForAnimations(page, ".workflow-launch-dialog");
  await page.screenshot({ path: join(ARTIFACTS, "workflow_launcher_hidden_layout_repaired.png") });
  await page.context().close();
});

test("complete workflow journey remains synchronized, accessible, and responsive", async () => {
  const page = await openApp({
    width: 1280,
    height: 900,
    sessionId: SESSIONS.main,
    record: true,
  });
  const context = page.context();
  const video = page.video();

  // The header capability is builder-only. Running a saved workflow belongs
  // to the Chat composer launcher, not to the header navigation control.
  const headerWorkflow = page.locator(".view-switcher").getByRole("button", { name: "Workflows" });
  await headerWorkflow.click();
  await page.waitForSelector(".workflow-page", { state: "visible" });
  assert.equal(await page.getByRole("dialog", { name: "Run a workflow" }).count(), 0);

  // Builder controls: create, edit nodes, connect dependencies, save, switch,
  // and delete through the themed confirmation surface.
  await page.getByRole("button", { name: "New", exact: true }).click();
  const workflowName = page.locator(".workflow-name-field input");
  await workflowName.waitFor({ state: "visible" });
  await workflowName.fill("Button QA workflow");
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  assert.equal(await page.locator(".workflow-node-card").count(), 2);
  const secondNode = page.locator(".workflow-node-card").nth(1);
  await secondNode.getByRole("button", { name: "Edit dependencies for Agent 2" }).click();
  const workerDependency = secondNode.locator(".workflow-dependency")
    .filter({ hasText: "Worker" });
  await workerDependency.click();
  assert.equal(await workerDependency.locator("input").isChecked(), true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector(".workflow-save-state")?.textContent?.trim() === "Saved");
  await page.locator(".workflow-definition").filter({ hasText: "Approval review" }).click();
  await page.waitForFunction(() =>
    (document.querySelector(".workflow-name-field input") as HTMLInputElement | null)?.value === "Approval review");
  await workflowName.fill("Approval review draft");
  await page.waitForFunction(() =>
    document.querySelector(".workflow-save-state")?.textContent?.trim() === "Unsaved changes");
  await page.locator(".workflow-definition").filter({ hasText: "Release pipeline" }).click();
  const discardDialog = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  await discardDialog.waitFor({ state: "visible" });
  await discardDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await workflowName.inputValue(), "Approval review draft");
  await page.locator(".workflow-definition").filter({ hasText: "Release pipeline" }).click();
  await discardDialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await page.waitForFunction(() =>
    (document.querySelector(".workflow-name-field input") as HTMLInputElement | null)?.value === "Release pipeline");
  await page.locator(".workflow-definition").filter({ hasText: "Button QA workflow" }).click();
  await page.waitForFunction(() =>
    (document.querySelector(".workflow-name-field input") as HTMLInputElement | null)?.value === "Button QA workflow");
  await page.getByRole("button", { name: "Workflow options" }).click();
  await page.getByRole("menuitem", { name: "Delete workflow" }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete workflow" });
  await deleteDialog.waitFor({ state: "visible" });
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  await page.waitForFunction(() =>
    ![...document.querySelectorAll(".workflow-definition")].some(
      (element) => element.textContent?.includes("Button QA workflow"),
    ));

  await closeWorkflowModule(page);

  const editor = page.locator(".composer-editor");
  await editor.fill("Audit release candidate 42");
  const launcherButton = page.getByRole("button", { name: "Run workflow" });
  await launcherButton.focus();
  await launcherButton.click();
  const dialog = page.getByRole("dialog", { name: "Run a workflow" });
  await dialog.waitFor({ state: "visible" });
  await waitForAnimations(page, ".workflow-launch-dialog");
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

  await dialog.getByRole("button", { name: "Edit Approval review workflow" }).click();
  await page.waitForSelector(".workflow-page", { state: "visible" });
  assert.equal(await page.locator(".workflow-name-field input").inputValue(), "Approval review");
  assert.equal(await page.locator(".workflow-run-form textarea").inputValue(), "Audit release candidate 42");
  await closeWorkflowModule(page);
  await page.getByRole("button", { name: "Run workflow" }).click();

  await dialog.getByRole("button", { name: "Run Release pipeline workflow" }).click();
  await page.waitForSelector(".app.mode-chat.view-session", { state: "visible" });
  assert.equal(await page.locator(".workflow-page").count(), 0, "composer launch must remain in Chat");
  const timeline = page.locator(".workflow-timeline-card");
  await timeline.waitFor({ state: "visible" });
  assert.match(await timeline.getAttribute("aria-label") ?? "", /Workflow Release pipeline, Running/);
  assert.equal(await timeline.locator("li").count(), 6, "long runs start with a focused node window");

  const stopState = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".workflow-timeline-card footer button")];
    const button = buttons.find((candidate) => candidate.getAttribute("aria-label")?.startsWith("Stop "));
    button?.click();
    return { clicked: !!button, buttons: buttons.map((candidate) => ({ text: candidate.textContent, label: candidate.getAttribute("aria-label") })) };
  });
  assert.equal(stopState.clicked, true, `running timeline exposes its stop action: ${JSON.stringify(stopState.buttons)}`);
  await page.waitForSelector(".workflow-timeline-card.status-stopped", { state: "visible" });
  assert.match(await timeline.getAttribute("aria-label") ?? "", /Stopped/);
  await page.waitForSelector(".sb-workflow", { state: "detached" });

  await timeline.getByRole("button", { name: "Show all 40 nodes" }).click();
  assert.equal(await timeline.locator("li").count(), 40);
  await timeline.getByRole("button", { name: "Show focused nodes" }).click();
  assert.equal(await timeline.locator("li").count(), 6);
  const consumedDraft = await page.evaluate((sessionId) => ({
    dom: (document.querySelector(".composer-editor") as HTMLTextAreaElement | null)?.value,
    stored: localStorage.getItem(`polyth.draft.${sessionId}`),
    url: location.pathname,
  }), SESSIONS.main);
  assert.equal(consumedDraft.dom, "", `the workflow launch consumes the submitted draft: ${JSON.stringify(consumedDraft)}`);
  assert.equal(consumedDraft.stored, null, `the consumed workflow draft is not persisted: ${JSON.stringify(consumedDraft)}`);
  assert.equal(consumedDraft.url, `/p/${PROJECT_ID}/s/${SESSIONS.main}`);
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
  await manual.waitForSelector(".app.mode-chat.view-session", { state: "visible" });
  await manual.waitForSelector(".workflow-timeline-card .needs-human", { state: "visible" });
  await manual.waitForSelector(".sb-workflow", { state: "visible" });
  assert.match(await manual.locator(".workflow-timeline-summary").textContent() ?? "", /1 waiting for you/);
  await manual.getByRole("button", { name: "View workflow", exact: true }).click();
  const childAction = manual.locator('[data-package-window-owner="workflow"]')
    .getByRole("button", { name: "Review and respond in Reviewer child session" });
  await childAction.waitFor({ state: "visible" });
  const childActionWidths = await childAction.evaluate((element) => {
    const states = [...element.querySelectorAll<HTMLElement>(".workflow-button-content > span")];
    const idle = element.getBoundingClientRect().width;
    states[0]?.classList.add("is-measuring");
    states[1]?.classList.remove("is-measuring");
    const busy = element.getBoundingClientRect().width;
    states[0]?.classList.remove("is-measuring");
    states[1]?.classList.add("is-measuring");
    return { idle, busy };
  });
  assert.ok(Math.abs(childActionWidths.idle - childActionWidths.busy) <= 0.1,
    `builder child-session action shifts ${childActionWidths.idle}px → ${childActionWidths.busy}px`);
  await childAction.click();
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
    await phone.waitForSelector(".app.mode-chat.view-session", { state: "visible" });
    await phone.waitForSelector(".workflow-timeline-card", { state: "visible" });
    await assertNoOverflow(phone, `timeline@${width}`);
    await assertTouchTargets(phone, ".workflow-timeline-card button", `timeline@${width}`);

    await phone.locator(".composer-editor").click();
    await phone.getByRole("button", { name: "Run workflow" }).click();
    await phone.waitForSelector(".workflow-launch-dialog", { state: "visible" });
    await waitForAnimations(phone, ".workflow-launch-dialog");
    await assertNoOverflow(phone, `launcher@${width}`);
    await assertTouchTargets(phone, ".workflow-launch-dialog button, .workflow-launch-dialog textarea", `launcher@${width}`);
    const dialogBox = await phone.locator(".workflow-launch-dialog").boundingBox();
    assert.ok(dialogBox && dialogBox.width <= width + 1, `launcher@${width}: dialog is too wide`);
    assert.ok(dialogBox.y >= -0.5, `launcher@${width}: dialog starts above the viewport`);
    assert.ok(dialogBox.y + dialogBox.height <= await phone.evaluate(() => innerHeight) + 0.5,
      `launcher@${width}: dialog extends below the viewport`);
    const launcherFooterBox = await phone.locator(".workflow-launch-footer").boundingBox();
    assert.ok(launcherFooterBox && launcherFooterBox.y + launcherFooterBox.height <= await phone.evaluate(() => innerHeight) + 0.5,
      `launcher@${width}: footer actions are not immediately reachable`);
    await phone.screenshot({ path: join(ARTIFACTS, `workflow_mobile_launcher_${width}.png`), fullPage: false });
    await phone.keyboard.press("Escape");
    await phone.locator(".workflow-launch-dialog").waitFor({ state: "detached" });
    const viewWorkflow = phone.getByRole("button", { name: "View workflow", exact: true });
    // The expanded phone composer is intentionally docked over the timeline.
    // Reveal the timeline action in its scrollport before driving a real click.
    await viewWorkflow.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await viewWorkflow.click();
    await phone.waitForSelector(".workflow-page", { state: "visible" });
    await waitForAnimations(phone, ".rail-fullscreen");
    await phone.waitForSelector(".workflow-editor-toolbar", { state: "visible" });
    await assertNoOverflow(phone, `workflow view@${width}`);
    await assertTouchTargets(
      phone,
      ".workflow-page button, .workflow-page input:not([type='checkbox']), .workflow-page select, .workflow-page textarea, .workflow-page .workflow-dependency",
      `workflow view@${width}`,
    );
    const compactGeometry = await phone.evaluate(() => {
      const toolbar = document.querySelector<HTMLElement>(".workflow-editor-toolbar")!.getBoundingClientRect();
      const field = document.querySelector<HTMLElement>(".workflow-name-field")!.getBoundingClientRect();
      const actions = document.querySelector<HTMLElement>(".workflow-editor-actions")!.getBoundingClientRect();
      const header = document.querySelector<HTMLElement>('.module-view[data-module-id="workflow"] .module-view-head')!.getBoundingClientRect();
      return {
        toolbarHeight: toolbar.height,
        visibleChildrenHeight: Math.max(field.bottom, actions.bottom) - Math.min(field.top, actions.top),
        childGap: actions.top - field.bottom,
        headerHeight: header.height,
      };
    });
    assert.ok(
      compactGeometry.toolbarHeight <= compactGeometry.visibleChildrenHeight + 2,
      `workflow view@${width}: toolbar has ${compactGeometry.toolbarHeight - compactGeometry.visibleChildrenHeight}px unexplained height`,
    );
    assert.ok(compactGeometry.childGap >= 0 && compactGeometry.childGap <= 12,
      `workflow view@${width}: name/actions gap is ${compactGeometry.childGap}px`);
    assert.equal(compactGeometry.headerHeight, 42,
      `workflow view@${width}: shared compact module header is ${compactGeometry.headerHeight}px`);
    await assertCarouselGeometry(phone, `workflow carousel@${width}`);
    const [definitionListBox, selectedDefinitionBox] = await Promise.all([
      phone.locator(".workflow-definition-list").boundingBox(),
      phone.locator(".workflow-definition.active").boundingBox(),
    ]);
    assert.ok(
      definitionListBox && selectedDefinitionBox
        && selectedDefinitionBox.x >= definitionListBox.x - 0.5
        && selectedDefinitionBox.x + selectedDefinitionBox.width <= definitionListBox.x + definitionListBox.width + 0.5,
      `workflow view@${width}: selected workflow is not fully revealed`,
    );
    await phone.screenshot({ path: join(ARTIFACTS, `workflow_mobile_${width}.png`), fullPage: false });
    await phone.context().close();
  }

  const landscape = await openApp({ width: 667, height: 375, sessionId: SESSIONS.main });
  await landscape.locator(".composer-editor").fill("Check the compact launcher");
  await landscape.getByRole("button", { name: "Run workflow" }).click();
  await landscape.waitForSelector(".workflow-launch-dialog", { state: "visible" });
  await waitForAnimations(landscape, ".workflow-launch-dialog");
  await assertNoOverflow(landscape, "launcher@667x375");
  await landscape.getByRole("button", { name: "Open workflow builder" }).waitFor({ state: "visible" });
  await landscape.getByRole("button", { name: "Run Release pipeline workflow" }).waitFor({ state: "visible" });
  const landscapeDialogBox = await landscape.locator(".workflow-launch-dialog").boundingBox();
  const landscapeFooterBox = await landscape.locator(".workflow-launch-footer").boundingBox();
  assert.ok(landscapeDialogBox && landscapeDialogBox.y >= -0.5
    && landscapeDialogBox.y + landscapeDialogBox.height <= 375.5,
  "landscape launcher must remain inside the viewport");
  assert.ok(landscapeFooterBox && landscapeFooterBox.y + landscapeFooterBox.height <= 375.5,
    `landscape launcher footer must remain immediately reachable: ${JSON.stringify({ landscapeDialogBox, landscapeFooterBox })}`);
  await landscape.screenshot({ path: join(ARTIFACTS, "workflow_mobile_landscape_launcher.png") });
  await landscape.context().close();
});

test("package window resizes and preserves dynamic, pinned, and fullscreen behavior", async () => {
  const page = await openApp({ width: 1280, height: 900, sessionId: VISUAL_SESSION });
  await page.locator(".view-switcher").getByRole("button", { name: "Workflows", exact: true })
    .evaluate((element) => (element as HTMLElement).click());
  await page.waitForSelector(".workflow-page", { state: "visible" });
  const window = page.locator('[data-package-window-owner="workflow"]');
  await expectMode("dynamic");

  const drag = async (selector: string, x: number, y: number) => {
    const handle = window.locator(selector);
    const box = await handle.boundingBox();
    assert.ok(box, `${selector} resize handle is missing`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y);
    await page.mouse.up();
    await waitForAnimations(page, '[data-package-window-owner="workflow"]');
  };
  async function expectMode(mode: "dynamic" | "pinned" | "fullscreen") {
    await page.waitForFunction((expected) =>
      document.querySelector('[data-package-window-owner="workflow"]')?.getAttribute("data-package-window-mode") === expected,
    mode);
  }

  const initial = await window.boundingBox();
  assert.ok(initial);
  const eastSeparator = window.locator(".package-window-resize--e");
  const eastHandle = await eastSeparator.boundingBox();
  assert.ok(eastHandle);
  const minWidth = Number(await eastSeparator.getAttribute("aria-valuemin"));
  const delta = initial.width > minWidth + 24 ? -24 : 24;
  const eastTarget = eastHandle.x + eastHandle.width / 2 + delta;
  const expectedRight = initial.x + initial.width + delta;
  await drag(".package-window-resize--e", eastTarget, initial.y + initial.height / 2);
  const eastResized = await window.boundingBox();
  assert.ok(eastResized && Math.abs(eastResized.x + eastResized.width - expectedRight) <= 2,
    `east resize handle does not track the pointer: ${JSON.stringify({ initial, eastHandle, minWidth, delta, expectedRight, eastResized })}`);
  await drag(".package-window-resize--w", 0, initial.y + initial.height / 2);
  const widest = await window.boundingBox();
  assert.ok(widest && widest.width > initial.width && widest.x >= -0.5);
  await drag(".package-window-resize--w", 1270, widest.y + widest.height / 2);
  const narrowest = await window.boundingBox();
  assert.ok(narrowest && narrowest.width < widest.width && narrowest.width >= 380);

  const shell = await page.locator(".app-shell").boundingBox();
  assert.ok(shell);
  await drag(".package-window-resize--n", narrowest.x + narrowest.width / 2, narrowest.y + 24);
  const northResized = await window.boundingBox();
  assert.ok(northResized && northResized.height < narrowest.height && northResized.y > narrowest.y,
    `north resize failed: ${JSON.stringify({ shell, narrowest, northResized })}`);
  await drag(".package-window-resize--s", northResized.x + northResized.width / 2, shell.y + shell.height - 8);
  const tallest = await window.boundingBox();
  assert.ok(tallest && tallest.height > northResized.height);
  await drag(".package-window-resize--s", tallest.x + tallest.width / 2, 100);
  const shortest = await window.boundingBox();
  assert.ok(shortest && shortest.height < tallest.height && shortest.height >= 240);

  const keyboardResize = window.locator('.package-window-resize--e[role="separator"]');
  await keyboardResize.focus();
  await page.keyboard.press("End");
  await waitForAnimations(page, '[data-package-window-owner="workflow"]');
  const keyboardWide = await window.boundingBox();
  await page.keyboard.press("Home");
  await waitForAnimations(page, '[data-package-window-owner="workflow"]');
  const keyboardNarrow = await window.boundingBox();
  assert.ok(keyboardWide && keyboardNarrow && keyboardWide.width > keyboardNarrow.width);

  await window.getByRole("button", { name: "Pin window" }).click();
  await expectMode("pinned");
  await window.getByRole("button", { name: "Enter fullscreen" }).click();
  await expectMode("fullscreen");
  assert.equal(await page.locator(".header").isVisible(), true, "fullscreen hides global navigation");
  assert.equal(await window.getAttribute("aria-modal"), null, "non-modal fullscreen claims modal semantics");
  await page.keyboard.press("Escape");
  await expectMode("pinned");
  await window.getByRole("button", { name: "Unpin window" }).click();
  await expectMode("dynamic");

  await window.getByRole("button", { name: "Workflow options" }).click();
  const menu = page.getByRole("menu");
  await menu.dispatchEvent("pointerdown");
  await expectMode("dynamic");
  await page.keyboard.press("Escape");
  await page.locator(".composer-editor").click();
  await window.waitFor({ state: "detached" });
  await page.context().close();
});

test("workflow visual quality matrix uses computed geometry across themes, motion, zoom, and safe areas", async () => {
  const viewports = [
    { width: 320, height: 700 },
    { width: 375, height: 812 },
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
    { width: 1440, height: 1000 },
  ];
  for (const viewport of viewports) {
    const page = await openApp({ ...viewport, sessionId: VISUAL_SESSION, colorScheme: "dark" });
    await openWorkflowFromSwitcher(page);
    await page.locator(".workflow-definition").filter({ hasText: "Release pipeline" }).click();
    await page.waitForFunction(() =>
      (document.querySelector(".workflow-name-field input") as HTMLInputElement | null)?.value === "Release pipeline");
    assert.equal(await page.locator(".workflow-page").count(), 1, `workflow switcher failed at ${viewport.width}px`);
    if (viewport.width <= 480) {
      assert.equal(await page.locator(".mobile-session-floats").isVisible(), true,
        `floating workflow navigation is hidden at ${viewport.width}px`);
      assert.equal(await page.locator('.module-view[data-module-id="workflow"] .module-view-close').isVisible(), true,
        `workflow module close is hidden at ${viewport.width}px`);
    } else if (viewport.width <= 820) {
      assert.equal(
        await page.locator(".mobile-shortcut-rail")
          .getByRole("button", { name: "Workflows", exact: true }).isVisible(),
        true,
        `compact workflow shortcut is hidden at ${viewport.width}px`,
      );
    } else {
      assert.equal(await page.locator(".view-switcher").getByRole("button", { name: "Workflows" }).isVisible(), true,
        `desktop workflow view button is hidden at ${viewport.width}px`);
    }

    const layers = page.locator(".workflow-layer-chip");
    const expectedLayerPreview = viewport.width <= 480 ? 2 : 6;
    assert.equal(await layers.count(), expectedLayerPreview, `large plan is not responsively collapsed at ${viewport.width}px`);
    assert.equal(await page.getByRole("button", { name: "Show all 40 layers" }).isVisible(), true);
    assert.ok(await page.locator(".workflow-dependency").count() <= 40,
      `dependency controls scale beyond a focused editor at ${viewport.width}px`);
    assert.equal(await page.locator(".workflow-dependency-edit").count(), 40,
      `every node must expose one progressive dependency editor at ${viewport.width}px`);
    const deleteRadius = await page.locator(".workflow-node-delete").first().evaluate((element) => {
      const style = getComputedStyle(element);
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;border-radius:var(--radius-control)";
      document.body.append(probe);
      const canonical = getComputedStyle(probe).borderRadius;
      probe.remove();
      return { actual: style.borderRadius, canonical };
    });
    assert.equal(deleteRadius.actual, deleteRadius.canonical,
      `node delete radius does not use the canonical control token at ${viewport.width}px`);
    await assertNoOverflow(page, `workflow matrix@${viewport.width}`);
    if (viewport.width <= 620) {
      await assertCarouselGeometry(page, `workflow matrix carousel@${viewport.width}`);
      const geometry = await page.evaluate(() => {
        const toolbar = document.querySelector<HTMLElement>(".workflow-editor-toolbar")!.getBoundingClientRect();
        const field = document.querySelector<HTMLElement>(".workflow-name-field")!.getBoundingClientRect();
        const actions = document.querySelector<HTMLElement>(".workflow-editor-actions")!.getBoundingClientRect();
        const scrollport = document.querySelector<HTMLElement>(".workflow-layout")!.getBoundingClientRect();
        const moduleHead = document.querySelector<HTMLElement>('.module-view[data-module-id="workflow"] .module-view-head')!.getBoundingClientRect();
        return {
          toolbarHeight: toolbar.height,
          childrenHeight: Math.max(field.bottom, actions.bottom) - Math.min(field.top, actions.top),
          nameBasis: getComputedStyle(document.querySelector<HTMLElement>(".workflow-name-field")!).flexBasis,
          scrollportTop: scrollport.top,
          scrollportBottom: scrollport.bottom,
          moduleHeadBottom: moduleHead.bottom,
        };
      });
      assert.ok(geometry.toolbarHeight <= geometry.childrenHeight + 2,
        `toolbar@${viewport.width} has unexplained vertical space`);
      assert.equal(geometry.nameBasis, "auto", `name field still has a vertical flex basis at ${viewport.width}px`);
      assert.ok(geometry.scrollportTop >= geometry.moduleHeadBottom - 0.5,
        `workflow editor overlaps the shared module header at ${viewport.width}px`);
      assert.equal(await page.locator('.module-view[data-module-id="workflow"] .module-view-close').isVisible(), true,
        `shared module close is hidden at ${viewport.width}px`);
      const lastRole = page.locator(".workflow-node-card input").last();
      await lastRole.scrollIntoViewIfNeeded();
      await lastRole.focus();
      const deepScroll = await page.evaluate(() => {
        const focused = (document.activeElement as HTMLElement).getBoundingClientRect();
        const scrollport = document.querySelector<HTMLElement>(".workflow-layout")!.getBoundingClientRect();
        return {
          focused: focused.toJSON(),
          scrollport: scrollport.toJSON(),
        };
      });
      assert.ok(deepScroll.focused.top >= deepScroll.scrollport.top - 0.5
        && deepScroll.focused.bottom <= deepScroll.scrollport.bottom + 0.5,
      `focused last-node field is obscured at ${viewport.width}px`);
      await lastRole.evaluate((element) => element.blur());
      await page.locator(".workflow-layout").evaluate((element) => element.scrollTo({ top: 0 }));
    }
    await page.screenshot({
      path: join(ARTIFACTS, `workflow_view_${viewport.width}.png`),
      fullPage: false,
    });
    if (viewport.width === 320 || viewport.width === 375 || viewport.width === 1280) {
      await assertVisualBaseline(page, `workflow_view_${viewport.width}`);
    }
    await page.context().close();
  }

  for (const viewport of [
    { width: 320, height: 700 },
    { width: 375, height: 812 },
    { width: 667, height: 375 },
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
    { width: 1440, height: 1000 },
  ]) {
    const page = await openApp({ ...viewport, sessionId: VISUAL_SESSION });
    await openWorkflowLauncher(page);
    const dialog = page.locator(".workflow-launch-dialog");
    await dialog.getByRole("button", { name: "Run Release pipeline workflow" }).waitFor({ state: "visible" });
    const box = await dialog.boundingBox();
    const expectedWidth = viewport.width <= 700
      ? viewport.width
      : Math.min(560, viewport.width * 0.92);
    assert.ok(box && Math.abs(box.width - expectedWidth) <= 1,
      `launcher@${viewport.width} computed width ${box?.width}px, expected ${expectedWidth}px`);
    const styles = await dialog.evaluate((element) => {
      const dialogStyle = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      const disabled = element.querySelector<HTMLButtonElement>(".ui-btn--primary:disabled");
      const disabledStyle = disabled ? getComputedStyle(disabled) : null;
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;border-radius:var(--radius-sheet)";
      document.body.append(probe);
      const sheetRadius = getComputedStyle(probe).borderRadius;
      probe.style.borderRadius = "var(--radius-surface)";
      const surfaceRadius = getComputedStyle(probe).borderRadius;
      probe.remove();
      return {
        radius: dialogStyle.borderRadius,
        sheetRadius,
        surfaceRadius,
        animation: dialogStyle.animationName,
        disabledOpacity: disabledStyle?.opacity,
        disabledBackground: disabledStyle?.backgroundColor,
        accent: rootStyle.getPropertyValue("--accent").trim(),
      };
    });
    assert.equal(
      styles.radius,
      viewport.width <= 700 ? `${styles.sheetRadius} ${styles.sheetRadius} 0px 0px` : styles.surfaceRadius,
      `launcher@${viewport.width} radius ${styles.radius} does not match sheet radius ${styles.sheetRadius}`,
    );
    assert.equal(styles.disabledOpacity, "0.55", `launcher@${viewport.width} disabled primary is opacity-demoted`);
    assert.notEqual(styles.disabledBackground, styles.accent,
      `launcher@${viewport.width} disabled primary still uses the accent fill`);
    assert.equal(styles.animation, "none", `launcher@${viewport.width} must not restore package-owned dialog motion`);
    if (viewport.width === 667) {
      await assertVisualBaseline(page, "workflow_launcher_667x375", ".workflow-launch-dialog");
    }
    if (viewport.width === 1280) {
      const darkFocus = await page.locator(".workflow-launch-task textarea").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          borderColor: style.borderColor,
          boxShadow: style.boxShadow,
        };
      });
      assert.equal(darkFocus.outlineWidth, "2px", "dark-theme keyboard focus ring is not 2px");
      assert.notEqual(darkFocus.boxShadow, "none", "dark-theme focus is missing the shared halo");
      assert.notEqual(darkFocus.borderColor, darkFocus.outlineColor,
        "dark-theme focus duplicates the accent stroke on both border and outline");
      await page.getByRole("button", { name: "Close workflow launcher" }).click();
      await page.locator(".workflow-launch-backdrop").waitFor({ state: "detached" });
    }
    await page.context().close();
  }

  const safeArea = await openApp({ width: 375, height: 812, sessionId: VISUAL_SESSION });
  await openWorkflowLauncher(safeArea);
  await safeArea.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty("--visual-vh", "420px");
    root.setProperty("--keyboard-inset", "392px");
    root.setProperty("--visual-offset", "16px");
    root.setProperty("--safe-top", "24px");
    root.setProperty("--safe-bottom", "34px");
    document.body.dataset.keyboard = "open";
  });
  await safeArea.locator(".workflow-launch-dialog").evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  const safeGeometry = await safeArea.evaluate(() => {
    const backdrop = document.querySelector<HTMLElement>(".workflow-launch-backdrop")!.getBoundingClientRect();
    const dialogElement = document.querySelector<HTMLElement>(".workflow-launch-dialog")!;
    const dialog = dialogElement.getBoundingClientRect();
    const footer = document.querySelector<HTMLElement>(".workflow-launch-footer")!.getBoundingClientRect();
    const children = [...dialogElement.children].map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        className: element.className,
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        flex: style.flex,
        minHeight: style.minHeight,
      };
    });
    return { backdrop: backdrop.toJSON(), dialog: dialog.toJSON(), footer: footer.toJSON(), children };
  });
  assert.ok(safeGeometry.backdrop.top >= 15.5 && safeGeometry.backdrop.bottom <= 436.5,
    "launcher backdrop does not follow the shrunken visual viewport");
  assert.ok(safeGeometry.dialog.top >= safeGeometry.backdrop.top + 23
    && safeGeometry.dialog.bottom <= safeGeometry.backdrop.bottom - 33,
  `launcher dialog violates simulated safe areas: ${JSON.stringify(safeGeometry)}`);
  assert.ok(safeGeometry.footer.bottom <= safeGeometry.dialog.bottom + 0.5,
    `launcher footer is hidden by the simulated keyboard: ${JSON.stringify(safeGeometry)}`);
  await safeArea.screenshot({ path: join(ARTIFACTS, "workflow_launcher_keyboard_safe_area.png") });
  await safeArea.context().close();

  const reduced = await openApp({
    width: 375,
    height: 812,
    sessionId: VISUAL_SESSION,
    reducedMotion: "reduce",
  });
  await openWorkflowLauncher(reduced);
  assert.equal(
    await reduced.locator(".workflow-launch-dialog").evaluate((element) => getComputedStyle(element).animationName),
    "none",
    "reduced-motion launcher still animates",
  );
  await reduced.context().close();

  const light = await openApp({
    width: 1280,
    height: 900,
    sessionId: VISUAL_SESSION,
    colorScheme: "light",
  });
  await openWorkflowFromSwitcher(light);
  await light.screenshot({ path: join(ARTIFACTS, "workflow_view_1280_light.png") });
  const focus = light.locator(".workflow-name-field input");
  await focus.click();
  const pointerFocus = await focus.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
  });
  assert.notEqual(pointerFocus.boxShadow, "none", "focused workflow fields retain the Quiet Glass focus wash");
  await light.keyboard.press("Tab");
  await light.keyboard.press("Shift+Tab");
  const keyboardFocus = await focus.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
    };
  });
  assert.equal(keyboardFocus.outlineWidth, "2px", "keyboard focus does not expose one 2px ring");
  assert.equal(keyboardFocus.boxShadow, pointerFocus.boxShadow,
    "keyboard focus uses the same bounded focus wash as pointer focus");
  assert.notEqual(keyboardFocus.borderColor, keyboardFocus.outlineColor,
    "keyboard focus duplicates the accent stroke on both border and outline");
  await light.context().close();

  for (const locale of [
    {
      id: "en",
      label: "Workflows",
      width: 390,
      height: 844,
      direction: "ltr",
      taskPlaceholder: "Describe the task for this workflow…",
      rolePlaceholder: "Worker",
      defaultModel: "Default model",
      nameLabel: "Workflow name",
    },
    {
      id: "de",
      label: "Arbeitsabläufe",
      width: 375,
      height: 812,
      direction: "ltr",
      taskPlaceholder: "Beschreiben Sie die Aufgabe für diesen Workflow…",
      rolePlaceholder: "Ausführender",
      defaultModel: "Standardmodell",
      nameLabel: "Name des Workflows",
    },
    {
      id: "es",
      label: "Flujos de trabajo",
      width: 390,
      height: 844,
      direction: "ltr",
      taskPlaceholder: "Describe la tarea para este flujo de trabajo…",
      rolePlaceholder: "Ejecutor",
      defaultModel: "Modelo predeterminado",
      nameLabel: "Nombre del flujo de trabajo",
    },
    {
      id: "zh-CN",
      label: "工作流程",
      width: 390,
      height: 844,
      direction: "ltr",
      taskPlaceholder: "请描述此工作流的任务…",
      rolePlaceholder: "执行器",
      defaultModel: "默认模型",
      nameLabel: "工作流名称",
    },
    {
      id: "ar",
      label: "سير العمل",
      width: 320,
      height: 700,
      direction: "rtl",
      taskPlaceholder: "صِف المهمة الخاصة بسير العمل هذا…",
      rolePlaceholder: "منفّذ",
      defaultModel: "النموذج الافتراضي",
      nameLabel: "اسم سير العمل",
    },
  ] as const) {
    const localized = await openApp({
      width: locale.width,
      height: locale.height,
      sessionId: VISUAL_SESSION,
      storage: { "polyth.locale": locale.id },
    });
    await openWorkflowFromSwitcher(localized, locale.label);
    await localized.locator(".workflow-definition").filter({ hasText: "Release pipeline" }).click();
    await localized.waitForFunction(() =>
      (document.querySelector(".workflow-name-field input") as HTMLInputElement | null)?.value === "Release pipeline");
    await localized.mouse.move(0, 0);
    const localizedState = await localized.evaluate(() => ({
      lang: document.documentElement.lang,
      direction: document.documentElement.dir,
      taskPlaceholder: document.querySelector<HTMLTextAreaElement>(".workflow-run-form textarea")?.placeholder,
      rolePlaceholder: document.querySelector<HTMLInputElement>(".workflow-node-card input")?.placeholder,
      defaultModel: document.querySelector<HTMLElement>(".workflow-node-card .workflow-node-selects .picker-chip-text")?.textContent,
      nameLabel: document.querySelector<HTMLElement>(".workflow-name-field > span")?.textContent,
    }));
    assert.equal(localizedState.lang, locale.id);
    assert.equal(localizedState.direction, locale.direction);
    assert.equal(localizedState.taskPlaceholder, locale.taskPlaceholder);
    assert.equal(localizedState.rolePlaceholder, locale.rolePlaceholder);
    assert.equal(localizedState.defaultModel, locale.defaultModel);
    assert.equal(localizedState.nameLabel, locale.nameLabel);
    await assertNoOverflow(localized, `workflow ${locale.id} locale@${locale.width}`);
    assert.equal(await localized.locator('.module-view[data-module-id="workflow"] .module-view-close').isVisible(), true,
      `workflow ${locale.id}: shared module close is hidden`);
    if (locale.direction === "rtl") {
      const rtlGeometry = await localized.evaluate(() => {
        const counter = document.querySelector<HTMLElement>(".workflow-definition-position")!;
        const glyphLefts = [...counter.childNodes].flatMap((counterText) =>
          counterText instanceof Text
            ? [...counterText.data].flatMap((character, index) => {
                if (!character.trim()) return [];
                const range = document.createRange();
                range.setStart(counterText, index);
                range.setEnd(counterText, index + 1);
                return [range.getBoundingClientRect().left];
              })
            : []);
        const definitions = [...document.querySelectorAll<HTMLElement>(".workflow-definition")];
        const selected = definitions.findIndex((definition) => definition.getAttribute("aria-pressed") === "true");
        return {
          counter: counter.textContent?.replace(/\s/g, ""),
          expectedCounter: `${selected + 1}/${definitions.length}`,
          glyphLefts,
          counterDirection: getComputedStyle(counter).direction,
          counterBidi: getComputedStyle(counter).unicodeBidi,
        };
      });
      assert.equal(rtlGeometry.counter, rtlGeometry.expectedCounter, "RTL carousel counter reports the wrong position");
      assert.ok(
        rtlGeometry.glyphLefts.length >= 3
          && rtlGeometry.glyphLefts.every((left, index, glyphs) => index === 0 || left >= glyphs[index - 1]!),
        `RTL carousel counter reverses visual glyph order: ${rtlGeometry.glyphLefts.join(", ")}`,
      );
      assert.equal(rtlGeometry.counterDirection, "ltr", "RTL carousel counter is not LTR-isolated");
      assert.equal(rtlGeometry.counterBidi, "isolate", "RTL carousel counter lacks bidi isolation");
    }
    await localized.screenshot({ path: join(ARTIFACTS, `workflow_view_${locale.width}_${locale.id}.png`) });
    if (locale.id === "ar") {
      await assertVisualBaseline(localized, "workflow_view_320_ar");
    }
    await localized.context().close();
  }

  // Browser zoom halves the CSS layout viewport while rendering each CSS
  // pixel at twice the device-pixel density. Do not add a second pinch zoom:
  // that would leave only 187.5 visible CSS pixels and test a different mode.
  const zoomed = await openApp({ width: 750, height: 900, sessionId: VISUAL_SESSION });
  const cdp = await zoomed.context().newCDPSession(zoomed);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 450,
    screenWidth: 750,
    screenHeight: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await openWorkflowFromSwitcher(zoomed);
  await assertNoOverflow(zoomed, "workflow 200% text zoom");
  const zoomGeometry = await zoomed.locator(".workflow-page").evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    viewport: innerWidth,
    deviceScaleFactor: devicePixelRatio,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(zoomGeometry.viewport, 375, "200% zoom did not expose the reduced layout viewport");
  assert.ok(zoomGeometry.deviceScaleFactor >= 1.99,
    `200% zoom did not render at 2x device pixels (${zoomGeometry.deviceScaleFactor})`);
  assert.ok(zoomGeometry.scrollWidth <= zoomGeometry.viewport + 1,
    `workflow 200% zoom overflows ${zoomGeometry.scrollWidth}/${zoomGeometry.viewport}`);
  await zoomed.screenshot({ path: join(ARTIFACTS, "workflow_view_200_percent_zoom.png") });
  await zoomed.context().close();
});
