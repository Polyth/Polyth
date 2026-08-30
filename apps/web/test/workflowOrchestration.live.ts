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
import { constants } from "node:fs";
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
    ...(options.record ? { recordVideo: { dir: ARTIFACTS, size: { width: options.width, height: options.height } } } : {}),
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
    localStorage.setItem(`polyth.projectSetup.v1.${projectId}`, "completed");
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
          ".workflow-definition-list, .mobile-shortcut-rail",
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
    const [clip, item] = await Promise.all([list.boundingBox(), items.nth(index).boundingBox()]);
    assert.ok(
      clip && item && item.x >= clip.x - 1 && item.x + item.width <= clip.x + clip.width + 1,
      `${label}: item ${index + 1}/${count} cannot be fully revealed`,
    );
  }
  await list.evaluate((element, scrollLeft) => element.scrollTo({ left: scrollLeft }), initial.scrollLeft);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function openWorkflowFromSwitcher(page: Page): Promise<void> {
  const desktopButton = page.locator(".view-switcher").getByRole("button", { name: "Workflows" });
  if (await desktopButton.isVisible().catch(() => false)) {
    await desktopButton.click();
  } else {
    const compactShortcut = page.locator(".mobile-shortcut-rail")
      .getByRole("button", { name: "Workflows", exact: true });
    await compactShortcut.waitFor({ state: "visible" });
    await compactShortcut.click();
  }
  await page.waitForSelector(".workflow-page", { state: "visible" });
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
  await page.waitForSelector(".app.view-goals", { state: "visible" });
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

test("compact shortcut rail exposes Workflows on phones and tablets", async () => {
  for (const viewport of [
    { width: 320, height: 700 },
    { width: 375, height: 812 },
    { width: 768, height: 900 },
  ]) {
    const page = await openApp({ ...viewport, sessionId: SESSIONS.main });
    const rail = page.locator(".mobile-shortcut-rail");
    await rail.waitFor({ state: "visible" });
    const workflow = rail.getByRole("button", { name: "Workflows", exact: true });
    await workflow.waitFor({ state: "visible" });
    const firstDestinations = await rail.locator(".mobile-shortcut").evaluateAll((shortcuts) =>
      shortcuts.slice(0, 2).map((shortcut) => shortcut.getAttribute("aria-label")));
    assert.deepEqual(
      firstDestinations,
      ["Chat", "Workflows"],
      `compact rail must keep Workflows beside Chat at ${viewport.width}px`,
    );
    await workflow.click();
    await page.waitForSelector(".workflow-page", { state: "visible" });
    assert.equal(
      await workflow.getAttribute("aria-current"),
      "page",
      `compact shortcut did not activate Workflows at ${viewport.width}px`,
    );
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

  await page.getByRole("button", { name: "Back to chat" }).click();
  await page.waitForSelector(".app.mode-chat.view-session", { state: "visible" });

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
  await page.getByRole("button", { name: "Back to chat" }).click();
  await page.waitForSelector(".app.mode-chat.view-session", { state: "visible" });
  await page.getByRole("button", { name: "Run workflow" }).click();

  await dialog.getByRole("button", { name: "Run Release pipeline workflow" }).click();
  await page.waitForSelector(".app.mode-chat.view-session", { state: "visible" });
  assert.equal(await page.locator(".workflow-page").count(), 0, "composer launch must remain in Chat");
  const timeline = page.locator(".workflow-timeline-card");
  await timeline.waitFor({ state: "visible" });
  await page.waitForSelector(".workflow-run-indicator", { state: "visible" });
  await page.waitForSelector(".sb-workflow", { state: "visible" });
  assert.match(await timeline.getAttribute("aria-label") ?? "", /Workflow Release pipeline, Running/);
  assert.equal(await timeline.locator("li").count(), 6, "long runs start with a focused node window");
  await page.screenshot({ path: join(ARTIFACTS, "workflow_running_timeline.png") });

  const stop = timeline.getByRole("button", { name: "Stop Release pipeline workflow run" });
  await stop.click();
  await page.waitForSelector(".workflow-timeline-card.status-stopped", { state: "visible" });
  assert.match(await timeline.getAttribute("aria-label") ?? "", /Stopped/);
  await page.waitForSelector(".workflow-run-indicator", { state: "detached" });
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
  await manual.waitForSelector(".workflow-run-indicator.waiting", { state: "visible" });
  await manual.waitForSelector(".sb-workflow", { state: "visible" });
  assert.match(await manual.locator(".workflow-timeline-summary").textContent() ?? "", /1 waiting for you/);
  await manual.getByRole("button", { name: "View workflow", exact: true }).click();
  const childAction = manual.getByRole("button", { name: "Review and respond in Reviewer child session" });
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
    assert.ok(dialogBox && dialogBox.width <= width - 20 + 1, `launcher@${width}: dialog is too wide`);
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
      const header = document.querySelector<HTMLElement>(".workflow-page-header")!.getBoundingClientRect();
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
    assert.ok(compactGeometry.headerHeight >= 68 && compactGeometry.headerHeight <= 80,
      `workflow view@${width}: compact page header is ${compactGeometry.headerHeight}px`);
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
    "landscape launcher footer must remain immediately reachable");
  await landscape.screenshot({ path: join(ARTIFACTS, "workflow_mobile_landscape_launcher.png") });
  await landscape.context().close();
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
    const page = await openApp({ ...viewport, sessionId: SESSIONS.main, colorScheme: "dark" });
    await openWorkflowFromSwitcher(page);
    await page.locator(".workflow-definition").filter({ hasText: "Release pipeline" }).click();
    await page.waitForFunction(() =>
      (document.querySelector(".workflow-name-field input") as HTMLInputElement | null)?.value === "Release pipeline");
    assert.equal(await page.locator(".workflow-page").count(), 1, `workflow switcher failed at ${viewport.width}px`);
    if (viewport.width <= 820) {
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
        const savebar = document.querySelector<HTMLElement>(".workflow-mobile-savebar")!.getBoundingClientRect();
        const scrollport = document.querySelector<HTMLElement>(".workflow-layout")!.getBoundingClientRect();
        const status = document.querySelector<HTMLElement>(".statusbar")?.getBoundingClientRect();
        const nav = document.querySelector<HTMLElement>(".workspace-bottom-nav")?.getBoundingClientRect();
        const savebarPosition = getComputedStyle(document.querySelector<HTMLElement>(".workflow-mobile-savebar")!).position;
        return {
          toolbarHeight: toolbar.height,
          childrenHeight: Math.max(field.bottom, actions.bottom) - Math.min(field.top, actions.top),
          nameBasis: getComputedStyle(document.querySelector<HTMLElement>(".workflow-name-field")!).flexBasis,
          scrollportBottom: scrollport.bottom,
          savebarTop: savebar.top,
          savebarBottom: savebar.bottom,
          statusTop: status?.top ?? nav?.top ?? innerHeight,
          navTop: nav?.top ?? innerHeight,
          savebarPosition,
        };
      });
      assert.ok(geometry.toolbarHeight <= geometry.childrenHeight + 2,
        `toolbar@${viewport.width} has unexplained vertical space`);
      assert.equal(geometry.nameBasis, "auto", `name field still has a vertical flex basis at ${viewport.width}px`);
      assert.equal(geometry.savebarPosition, "sticky", `save bar is not an in-flow sticky action at ${viewport.width}px`);
      assert.ok(geometry.scrollportBottom <= geometry.savebarTop + 0.5,
        `save bar overlaps the editor scrollport at ${viewport.width}px`);
      assert.ok(geometry.savebarBottom <= geometry.statusTop + 0.5
        && geometry.savebarBottom <= geometry.navTop + 0.5,
      `save bar is not docked above persistent navigation at ${viewport.width}px`);
      assert.equal(await page.locator(".workflow-mobile-savebar").isVisible(), true,
        `mobile save bar is hidden at ${viewport.width}px`);
      const lastRole = page.locator(".workflow-node-card input").last();
      await lastRole.scrollIntoViewIfNeeded();
      await lastRole.focus();
      const persistentSavebar = await page.evaluate(() => {
        const savebar = document.querySelector<HTMLElement>(".workflow-mobile-savebar")!.getBoundingClientRect();
        const focused = (document.activeElement as HTMLElement).getBoundingClientRect();
        const scrollport = document.querySelector<HTMLElement>(".workflow-layout")!.getBoundingClientRect();
        return {
          savebar: savebar.toJSON(),
          focused: focused.toJSON(),
          scrollport: scrollport.toJSON(),
          scrollTop: document.querySelector<HTMLElement>(".workflow-layout")!.scrollTop,
        };
      });
      assert.ok(persistentSavebar.scrollTop > 10_000,
        `last node did not exercise deep mobile scrolling at ${viewport.width}px`);
      assert.ok(persistentSavebar.savebar.top >= persistentSavebar.scrollport.bottom - 0.5,
        `save bar disappeared while editing the last node at ${viewport.width}px`);
      assert.ok(persistentSavebar.focused.top >= persistentSavebar.scrollport.top - 0.5
        && persistentSavebar.focused.bottom <= persistentSavebar.scrollport.bottom + 0.5,
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
    const page = await openApp({ ...viewport, sessionId: SESSIONS.main });
    await openWorkflowLauncher(page);
    const dialog = page.locator(".workflow-launch-dialog");
    await dialog.getByRole("button", { name: "Run Release pipeline workflow" }).waitFor({ state: "visible" });
    const box = await dialog.boundingBox();
    const expectedWidth = viewport.width <= 480
      ? viewport.width - 20
      : Math.min(680, viewport.width - 48);
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
      probe.remove();
      return {
        radius: dialogStyle.borderRadius,
        sheetRadius,
        animation: dialogStyle.animationName,
        disabledOpacity: disabledStyle?.opacity,
        disabledBackground: disabledStyle?.backgroundColor,
        accent: rootStyle.getPropertyValue("--accent").trim(),
      };
    });
    assert.equal(
      styles.radius,
      styles.sheetRadius,
      `launcher@${viewport.width} radius ${styles.radius} does not match sheet radius ${styles.sheetRadius}`,
    );
    assert.equal(styles.disabledOpacity, "0.55", `launcher@${viewport.width} disabled primary is opacity-demoted`);
    assert.notEqual(styles.disabledBackground, styles.accent,
      `launcher@${viewport.width} disabled primary still uses the accent fill`);
    assert.equal(styles.animation, "workflow-dialog-in", `launcher@${viewport.width} normal motion is missing`);
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
      const closingBackdrop = page.locator(".workflow-launch-backdrop.is-closing");
      await closingBackdrop.waitFor({ state: "visible" });
      assert.equal(
        await closingBackdrop.evaluate((element) => getComputedStyle(element).animationName),
        "workflow-backdrop-out",
        "launcher exit motion is missing",
      );
      await closingBackdrop.waitFor({ state: "detached" });
    }
    await page.context().close();
  }

  const safeArea = await openApp({ width: 375, height: 812, sessionId: SESSIONS.main });
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
  "launcher dialog violates simulated safe areas");
  assert.ok(safeGeometry.footer.bottom <= safeGeometry.dialog.bottom + 0.5,
    `launcher footer is hidden by the simulated keyboard: ${JSON.stringify(safeGeometry)}`);
  await safeArea.screenshot({ path: join(ARTIFACTS, "workflow_launcher_keyboard_safe_area.png") });
  await safeArea.context().close();

  const reduced = await openApp({
    width: 375,
    height: 812,
    sessionId: SESSIONS.main,
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
    sessionId: SESSIONS.main,
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
  assert.equal(pointerFocus.boxShadow, "none", "pointer focus renders a competing shadow halo");
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
  assert.equal(keyboardFocus.boxShadow, "none", "keyboard focus renders a double focus halo");
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
      sessionId: SESSIONS.main,
      storage: { "polyth.locale": locale.id },
    });
    await localized.locator(".mobile-shortcut-rail")
      .getByRole("button", { name: locale.label, exact: true }).click();
    await localized.waitForSelector(".workflow-page", { state: "visible" });
    await localized.locator(".workflow-definition").filter({ hasText: "Release pipeline" }).click();
    await localized.waitForFunction(() =>
      (document.querySelector(".workflow-name-field input") as HTMLInputElement | null)?.value === "Release pipeline");
    await localized.mouse.move(0, 0);
    const localizedState = await localized.evaluate(() => ({
      lang: document.documentElement.lang,
      direction: document.documentElement.dir,
      taskPlaceholder: document.querySelector<HTMLTextAreaElement>(".workflow-run-form textarea")?.placeholder,
      rolePlaceholder: document.querySelector<HTMLInputElement>(".workflow-node-card input")?.placeholder,
      defaultModel: document.querySelector<HTMLOptionElement>(".workflow-node-card select option")?.textContent,
      nameLabel: document.querySelector<HTMLElement>(".workflow-name-field > span")?.textContent,
    }));
    assert.equal(localizedState.lang, locale.id);
    assert.equal(localizedState.direction, locale.direction);
    assert.equal(localizedState.taskPlaceholder, locale.taskPlaceholder);
    assert.equal(localizedState.rolePlaceholder, locale.rolePlaceholder);
    assert.equal(localizedState.defaultModel, locale.defaultModel);
    assert.equal(localizedState.nameLabel, locale.nameLabel);
    await assertNoOverflow(localized, `workflow ${locale.id} locale@${locale.width}`);
    const navLabels = await localized.locator(".workspace-bottom-nav .wbn-label").evaluateAll((labels) =>
      labels.map((label) => {
        const box = label.getBoundingClientRect();
        const button = label.parentElement!.getBoundingClientRect();
        return {
          text: label.textContent,
          left: box.left,
          right: box.right,
          buttonLeft: button.left,
          buttonRight: button.right,
        };
      }));
    assert.ok(
      navLabels.every((label) =>
        label.left >= label.buttonLeft - 0.5 && label.right <= label.buttonRight + 0.5),
      `workflow ${locale.id}: localized bottom-navigation labels collide: ${JSON.stringify(navLabels)}`,
    );
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
        const fade = getComputedStyle(document.querySelector(".workflow-definition-carousel")!, "::after");
        const backIcon = getComputedStyle(document.querySelector(".workflow-back-chat > svg")!);
        return {
          counter: counter.textContent?.replace(/\s/g, ""),
          expectedCounter: `${selected + 1}/${definitions.length}`,
          glyphLefts,
          counterDirection: getComputedStyle(counter).direction,
          counterBidi: getComputedStyle(counter).unicodeBidi,
          fadeLeft: fade.left,
          fadeImage: fade.backgroundImage,
          backTransform: backIcon.transform,
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
      assert.equal(rtlGeometry.fadeLeft, "0px", "RTL carousel fade is not attached to inline-end");
      assert.match(rtlGeometry.fadeImage, /to left|270deg/, "RTL carousel fade points the wrong way");
      assert.notEqual(rtlGeometry.backTransform, "none", "RTL compact Back icon is not mirrored");
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
  const zoomed = await openApp({ width: 750, height: 900, sessionId: SESSIONS.main });
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
