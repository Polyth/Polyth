// Chat timeline motion live gate. Real Chromium with motion ON samples the top
// of every transcript row on every animation frame while (a) a live action
// names itself in its block's line and the turn ends, (b) a revert fades its
// cut, glides the survivors and shows the marker, (c) a long existing chat
// opens, (d) a long live chat opens on a phone over a slow link while its
// history lands. Contract: rows never move down while a turn is live or as it
// ends (a revert glide is the one allowed release), never down-then-up, and
// are never drawn over each other.
//
// Kept OUTSIDE the default *.test.ts glob on purpose; run it explicitly:
//
//   node --experimental-strip-types --test apps/web/test/timelineMotion.live.ts
//
// Self-booting like firstSendHandoff.live.ts: a disposable, claimed Polyth data
// dir and a synthetic `opencode` stand-in, so no paid provider turn is made.
// Uses apps/web/dist as built (build it first when sources changed).
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
import { ACTIVITY_TICKER_DWELL_MS } from "../src/activityTicker.ts";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;
const PORT = Number(process.env.POLYTH_LIVE_PORT ?? 4473);
const BASE = `http://127.0.0.1:${PORT}`;
const WORK_TITLE = "Motion work session";
const TOOLS_TITLE = "Motion tools session";
const LONG_TITLE = "Motion long session";
const CHROMIUM_CANDIDATES = [
  process.env.POLYTH_CHROMIUM_PATH,
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
].filter((value): value is string => Boolean(value));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root = "";
let dataDir = "";
let homeDir = "";
let binDir = "";
let projectDir = "";
let projectId = "";
let workSessionId = "";
let historySessionId = "";
let toolsSessionId = "";
let serverProc: ChildProcess | undefined;
let browser: Browser | undefined;
const contexts: BrowserContext[] = [];

// ---- isolated server -------------------------------------------------------------

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
    MSGACT_TURN_DELAY_MS: "400",
    MSGACT_STREAM_STEP_MS: "250",
  });
  serverProc = spawn(process.execPath, ["packages/server/src/index.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
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

const waitUntil = async (label: string, probe: () => Promise<boolean>, ms = 45_000): Promise<void> => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      if (await probe()) return;
    } catch { /* not ready yet */ }
    if (Date.now() > deadline) throw new Error(`${label} did not become ready`);
    await sleep(250);
  }
};

async function claimInstallation(): Promise<void> {
  const security = createCanonicalSecurity({ dataDir, origin: BASE, localOnly: true });
  try {
    const claim = security.identity.setup.issueClaim();
    const binding = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    security.identity.setup.bindClaim(claim.token, binding);
    const recovery = security.identity.setup.prepareRecovery(claim.token, binding);
    await security.identity.setup.complete({
      claimToken: claim.token,
      browserBinding: binding,
      name: "Timeline Motion Gate",
      organizationName: "Timeline Motion Gate",
      login: `timeline-motion-${randomUUID().slice(0, 8)}`,
      password: `TimelineMotion-${randomUUID()}-${randomUUID()}`,
      recoverySetId: recovery.setId,
      recoveryAcknowledged: true,
    });
  } finally {
    security.close();
  }
}

async function buildFixture(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "polyth-timeline-motion-"));
  dataDir = join(root, "data");
  homeDir = join(root, "home");
  binDir = join(root, "bin");
  projectDir = join(root, "project");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: projectDir, stdio: "pipe" });
  await writeFile(join(projectDir, "README.md"), "# timeline motion gate fixture\n");
  execFileSync("git", ["-C", projectDir, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", projectDir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "seed"], { stdio: "pipe" });
  const fake = join(REPO_ROOT, "apps/web/test/msgActionsFakeBackend.mjs");
  const wrapper = join(binDir, "opencode");
  await writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  await chmod(wrapper, 0o755);
  // The control plane only bootstraps into an otherwise empty data root.
  await claimInstallation();
  await writeFile(join(dataDir, "oc-seed.json"), JSON.stringify({
    sessions: [],
    createdTurnBehaviors: { [WORK_TITLE]: "work", [TOOLS_TITLE]: "tools", [LONG_TITLE]: "tools" },
  }, null, 2));
}

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${BASE}${path}`, init);
  const body = await response.text();
  assert.equal(response.status, 200, `${init?.method ?? "GET"} ${path} failed: ${body.slice(0, 240)}`);
  return JSON.parse(body) as T;
};
const post = <T>(path: string, body: unknown) => api<T>(path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

type EventRow = { seq: number; type: string; data: Record<string, unknown> };
const waitForTurnSettled = (sessionId: string, prompt: string) => waitUntil(`turn for "${prompt}"`, async () => {
  const events = await api<EventRow[]>(`/api/sessions/${sessionId}/events?afterSeq=0`);
  const sent = events.findLast((event) => event.type === "user/message" && event.data.text === prompt);
  return sent !== undefined && events.some((event) => event.seq > sent.seq && event.type === "turn/stopped");
}, 30_000);
const sendAndSettle = async (sessionId: string, prompt: string) => {
  await post(`/api/sessions/${sessionId}/message`, { text: prompt });
  await waitForTurnSettled(sessionId, prompt);
};

before(async () => {
  await buildFixture();
  assert.ok(existsSync(join(REPO_ROOT, "apps/web/dist/index.html")), "build apps/web/dist first (node apps/web/build.ts)");
  startServer();
  await waitUntil("server health", async () => (await fetch(`${BASE}/api/health`).then((r) => r.json()) as { ok?: boolean }).ok === true);
  projectId = (await post<{ id: string }>("/api/projects", { path: projectDir, name: basename(projectDir) })).id;
  await waitUntil("model catalog", async () => {
    const catalog = await fetch(`${BASE}/api/models`).then((r) => r.json()) as unknown;
    return Array.isArray(catalog) && catalog.length > 0;
  });
  workSessionId = (await post<{ id: string }>("/api/sessions", { projectId, title: WORK_TITLE })).id;
  historySessionId = (await post<{ id: string }>("/api/sessions", { projectId, title: "Motion history session" })).id;
  toolsSessionId = (await post<{ id: string }>("/api/sessions", { projectId, title: TOOLS_TITLE })).id;
  await sendAndSettle(workSessionId, "Warm-up prompt for the motion gate.");
  // Enough settled turns that the tools turn runs in an overflowing chat,
  // where the view follows the tail.
  for (let turn = 1; turn <= 8; turn += 1) {
    await sendAndSettle(toolsSessionId, `Padding prompt ${turn}: an earlier settled turn above the live actions.`);
  }
  for (let turn = 1; turn <= 14; turn += 1) {
    await sendAndSettle(historySessionId, `History prompt ${turn}: a settled turn in a long chat that opens at rest.`);
  }
  const pw = await import("playwright-core");
  const executablePath = await (async () => {
    for (const candidate of CHROMIUM_CANDIDATES) {
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch { /* keep looking */ }
    }
    throw new Error("No Chromium executable found; set POLYTH_CHROMIUM_PATH.");
  })();
  browser = await pw.chromium.launch({ executablePath, headless: true });
});

after(async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stopServer();
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
});

// ---- per-frame sampling --------------------------------------------------------------

type MotionRow = [id: number, top: number, kind: "row" | "leaving" | "marker", height: number, label: string, motion: string];
interface MotionFrame {
  t: number;
  rows: MotionRow[];
  /** Scroller geometry, for diagnosing a failing frame. */
  scroll: [top: number, height: number, client: number];
  /** The scroller's visible band in viewport coordinates. */
  view: [top: number, bottom: number];
  classes: string;
  /** Every in-flow child, `label:height`, and the scroller's tail spaces. */
  layout: string;
}

/** Runs in the page: on every animation frame, the top of each transcript row
 *  keyed by element identity. Self-contained so it also works as init script. */
function installMotionSampler(): void {
  const host = window as unknown as { __motion?: { frames: MotionFrame[]; stop: () => void } };
  if (host.__motion) return;
  const ids = new WeakMap<Element, number>();
  let next = 0;
  let running = true;
  const frames: MotionFrame[] = [];
  host.__motion = { frames, stop: () => { running = false; } };
  let lastExtent = -1;
  // Sample what is painted: in the frame's last ResizeObserver delivery, after
  // the app's own observers have written scroll and started lifts. A probe
  // whose size changes every frame keeps this observer due. Reading in rAF
  // would precede that work; a task after the frame can land between a React
  // commit and its refresh and record a state that is never painted.
  // (As an init script this runs before <body> exists; the probe joins later.)
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;height:1px;width:1px;visibility:hidden;pointer-events:none";
  let frameTime = 0;
  const observer = new ResizeObserver(() => { if (running) sample(frameTime); });
  observer.observe(probe);
  const tick = (time: number) => {
    if (!running) {
      observer.disconnect();
      probe.remove();
      return;
    }
    if (!probe.isConnected) document.body?.append(probe);
    frameTime = time;
    probe.style.width = probe.style.width === "1px" ? "2px" : "1px";
    requestAnimationFrame(tick);
  };
  const sample = (t: number) => {
    const timeline = document.querySelector<HTMLElement>(".timeline");
    if (timeline) {
      const rows: MotionRow[] = [];
      for (const child of Array.from(timeline.children)) {
        if (!(child instanceof HTMLElement)
          || !child.matches(".msg, .activity-group, .rewind-marker, .timeline-earlier")) continue;
        let id = ids.get(child);
        if (id === undefined) {
          id = ++next;
          ids.set(child, id);
        }
        const kind = child.classList.contains("rewind-marker") ? "marker"
          : child.classList.contains("rewind-leaving") ? "leaving" : "row";
        const rect = child.getBoundingClientRect();
        const label = child.classList.contains("user") ? "user"
          : child.classList.contains("activity-group") ? "group"
            : child.classList.contains("timeline-earlier") ? "earlier" : child.classList[1] ?? child.classList[0] ?? "?";
        // Running row animations: the send flight, the entrance, or a lift.
        const motion = child.getAnimations().filter((animation) => animation.playState === "running")
          .map((animation) => animation.id || (animation instanceof CSSTransition ? "css" : "lift")).join("+");
        rows.push([id, Math.round(rect.top * 10) / 10, kind, Math.round(rect.height), label, motion]);
      }
      const layout = Array.from(timeline.children)
        .filter((child) => child instanceof HTMLElement)
        .map((child) => {
          const position = getComputedStyle(child).position;
          return `${(child.className || child.tagName).toString().split(" ").slice(0, 2).join(".")}:${Math.round(child.getBoundingClientRect().height)}${position === "static" ? "" : `(${position})`}`;
        })
        .join(" ") + ` gap=${getComputedStyle(timeline).rowGap}`;
      // Name the element reaching lowest (scroll overflow), every frame.
      let deepest = "";
      let bottom = -Infinity;
      for (const node of Array.from(timeline.querySelectorAll<HTMLElement>("*"))) {
        const rect = node.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > bottom) {
          bottom = rect.bottom;
          deepest = `${node.tagName.toLowerCase()}.${node.className.toString().split(" ").slice(0, 3).join(".")}@${Math.round(rect.bottom - timeline.getBoundingClientRect().top)}(${getComputedStyle(node).position})`;
        }
      }
      lastExtent = timeline.scrollHeight;
      frames.push({
        t,
        rows,
        scroll: [Math.round(timeline.scrollTop), timeline.scrollHeight, timeline.clientHeight],
        view: [Math.round(timeline.getBoundingClientRect().top), Math.round(timeline.getBoundingClientRect().bottom)],
        classes: timeline.className,
        layout: `${layout} | sheet=${timeline.style.getPropertyValue("--timeline-turn-sheet-space") || 0} floor=${timeline.style.getPropertyValue("--timeline-extent-floor") || 0}`
          + ` before=${getComputedStyle(timeline, "::before").height} after=${getComputedStyle(timeline, "::after").height}`
          + ` pad=${getComputedStyle(timeline).paddingTop}/${getComputedStyle(timeline).paddingBottom}`
          + ` floorAt=${(timeline.querySelector<HTMLElement>(":scope > .timeline-extent-floor")?.offsetTop ?? -1)}`
          + ` padBottom=${getComputedStyle(timeline).getPropertyValue("--timeline-pad-bottom").trim().slice(0, 60)}${deepest ? ` deepest=${deepest}` : ""}`,
      });
    }
  };
  requestAnimationFrame(tick);
}

/** Frame pacing and the frames around a move, for failure messages. */
function describeFrames(frames: MotionFrame[], around = -1): string {
  const gaps = frames.slice(1).map((frame, index) => frame.t - frames[index]!.t).sort((a, b) => a - b);
  const pace = gaps.length ? `median ${gaps[gaps.length >> 1]!.toFixed(1)}ms, max ${gaps.at(-1)!.toFixed(1)}ms` : "n/a";
  const window = around < 0 ? [] : frames.slice(Math.max(0, around - 3), around + 3)
    .map((frame) => `t=${frame.t.toFixed(0)} scroll=${frame.scroll.join("/")} [${frame.classes}] rows=${frame.rows.map(([id, top, , height, label]) => `${id}${label}@${top}h${height}`).join(" ")}\n      layout=${frame.layout}`);
  return [`${frames.length} frames, ${pace}`, ...window].join("\n    ");
}

const startSampler = (page: Page) => page.evaluate(installMotionSampler);
const stopSampler = (page: Page): Promise<MotionFrame[]> => page.evaluate(() => {
  const host = window as unknown as { __motion?: { frames: MotionFrame[]; stop: () => void } };
  host.__motion?.stop();
  const frames = host.__motion?.frames ?? [];
  delete host.__motion;
  return frames;
});

/** Per row, its frame-to-frame moves of more than a pixel. */
function rowMoves(frames: MotionFrame[]): Map<number, Array<{ frame: number; delta: number }>> {
  const last = new Map<number, number>();
  const moves = new Map<number, Array<{ frame: number; delta: number }>>();
  frames.forEach((frame, index) => {
    for (const [id, top] of frame.rows) {
      const previous = last.get(id);
      last.set(id, top);
      if (previous === undefined || Math.abs(top - previous) <= 1) continue;
      const list = moves.get(id) ?? [];
      list.push({ frame: index, delta: Math.round((top - previous) * 10) / 10 });
      moves.set(id, list);
    }
  });
  return moves;
}

/** The first row that moved down and later up again (the forbidden jump),
 *  with the frames around both moves. */
function downThenUp(frames: MotionFrame[], ignore: ReadonlySet<number> = new Set()): string | null {
  for (const [id, list] of rowMoves(frames)) {
    if (ignore.has(id)) continue;
    const down = list.findIndex((move) => move.delta > 0);
    const up = list.findLastIndex((move) => move.delta < 0);
    if (down >= 0 && up > down) {
      return `row ${id} moved down ${list[down]!.delta}px at frame ${list[down]!.frame}, then up ${list[up]!.delta}px at frame ${list[up]!.frame}:\n    `
        + `${describeFrames(frames, list[down]!.frame)}\n    ${describeFrames(frames, list[up]!.frame)}`;
    }
  }
  return null;
}

/** Late page layout (lazy package slots, fonts) must be over before a gate acts:
 *  wait until the transcript's extent has been stable for a full second. */
const settleLayout = (page: Page) => page.waitForFunction(() => {
  const el = document.querySelector<HTMLElement>(".timeline");
  if (!el) return false;
  const host = window as unknown as { __extent?: { height: number; since: number } };
  const now = performance.now();
  if (!host.__extent || host.__extent.height !== el.scrollHeight) {
    host.__extent = { height: el.scrollHeight, since: now };
    return false;
  }
  return now - host.__extent.since > 1000;
}, undefined, { timeout: 15_000, polling: 100 });

async function openSession(sessionId: string, options: { ready: string; sampleFromStart?: boolean; uiSettings?: Record<string, unknown> }): Promise<{ page: Page; errors: string[] }> {
  const context = await browser!.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: "no-preference", serviceWorkers: "block" });
  contexts.push(context);
  await context.addInitScript((uiSettings) => {
    localStorage.setItem("polyth.prefs", JSON.stringify({ persona: "engineer", plugins: [] }));
    // The first-open shell tour covers the shell and holds focus: these gates
    // start from an account that has already seen it (any later version too).
    localStorage.setItem("polyth.shellIntro.v1", JSON.stringify({ seenVersion: 1_000_000 }));
    // Software-composited headless Chromium renders backdrop blur at a few
    // frames a second; the glass material is unrelated to timeline motion.
    localStorage.setItem("polyth.uiSettings.v1", JSON.stringify({ glassEffect: "off", ...uiSettings }));
  }, options.uiSettings ?? {});
  if (options.sampleFromStart) await context.addInitScript(installMotionSampler);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${BASE}/p/${projectId}/s/${sessionId}`, { waitUntil: "load" });
  await page.waitForSelector(".app", { timeout: 20_000 });
  await page.waitForSelector(options.ready, { state: "visible", timeout: 20_000 });
  return { page, errors };
}

// ---- gates -------------------------------------------------------------------------------

test("motion: a live action names itself in its block and the turn ends without a row moving down", async () => {
  const { page, errors } = await openSession(workSessionId, { ready: ".timeline > .msg" });
  await settleLayout(page);
  const idleFps = await page.evaluate(() => new Promise<number>((resolve) => {
    let frames = 0;
    const start = performance.now();
    const tick = () => {
      frames += 1;
      if (performance.now() - start < 1000) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  }));
  console.log(`# motion page idle frame rate: ${idleFps}/s`);
  await startSampler(page);
  const prompt = "Motion gate: fold one action, then settle the turn.";
  // Exercise the composer/optimistic echo path, including fast admission.
  await page.evaluate(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const motion = animate.call(this, frames, options);
      if (motion.id === "chat-send-flight") {
        (window as unknown as { __sendFlight: Animation }).__sendFlight = motion;
      }
      return motion;
    };
  });
  await page.fill("textarea[data-composer-input]", prompt);
  await page.click(".composer-chat button.send");
  await page.waitForFunction(() => {
    const motion = (window as unknown as { __sendFlight?: Animation }).__sendFlight;
    const target = (motion?.effect as KeyframeEffect | null)?.target;
    return motion?.playState === "running" && target?.isConnected
      && target.matches(".msg.user:not([data-pending-send])");
  }, undefined, { timeout: 5000, polling: "raf" });
  assert.equal(await page.locator('.timeline > .msg[role="status"]').count(), 0,
    "the activity dock owns waiting; no duplicate transcript status");
  await page.waitForSelector(".timeline > .activity-group .activity-ticker-step", { timeout: 15_000 });
  await waitForTurnSettled(workSessionId, prompt);
  // The handover beat, the live line settling on its summary, and a margin.
  await page.waitForTimeout(150 + ACTIVITY_TICKER_DWELL_MS + 600);
  const frames = await stopSampler(page);
  const moves = [...rowMoves(frames).values()].flat();
  console.log(`# motion live+end: ${describeFrames(frames)}; row moves down=${moves.filter((move) => move.delta > 0).length} up=${moves.filter((move) => move.delta < 0).length}; largest down=${Math.max(0, ...moves.map((move) => move.delta))}px`);
  assert.ok(frames.length >= 20, `too few animation frames sampled: ${describeFrames(frames)}`);
  // Only what the reader can see: rows above the scrollport may reflow freely.
  const visible = (frame: MotionFrame, id: number) => frame.rows.some(([row, top, , height]) =>
    row === id && top < frame.view[1] && top + height > frame.view[0]);
  const sink = [...rowMoves(frames)].flatMap(([id, list]) => list.map((move) => ({ id, ...move })))
    .filter((move) => move.delta > 0)
    .find((move) => visible(frames[move.frame - 1]!, move.id) || visible(frames[move.frame]!, move.id));
  assert.equal(sink, undefined, `row ${sink?.id} sank ${sink?.delta}px while the turn ran or ended:\n    ${describeFrames(frames, sink?.frame ?? -1)}`);
  const jump = downThenUp(frames);
  assert.equal(jump, null, `a row moved down and then back up: ${jump}`);
  const rest = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".timeline")!;
    const rows = Array.from(el.querySelectorAll<HTMLElement>(":scope > .msg")).filter((row) => row.offsetHeight > 0);
    return {
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      sheet: Number.parseFloat(el.style.getPropertyValue("--timeline-turn-sheet-space")) || 0,
      tailBelowView: Math.round(rows.at(-1)!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom),
    };
  });
  // The reserve is handed over in place: the reader stays at the end of the
  // extent, with the tail in view (blank the turn left under it may stay).
  assert.ok(rest.sheet === 0 && rest.distance <= 2 && rest.tailBelowView <= 0,
    `the ended turn did not keep its reader on the tail: ${JSON.stringify(rest)}`);
  assert.deepEqual(errors, []);
});

test("motion: revert fades the cut in place, glides the survivors once, then shows the marker", async () => {
  const { page, errors } = await openSession(workSessionId, { ready: ".timeline > .msg.user [data-revert-seq]" });
  await settleLayout(page);
  const seq = await page.evaluate(() => {
    const prompts = document.querySelectorAll<HTMLElement>(".timeline > .msg.user[data-message-seq]");
    return prompts[prompts.length - 1]!.dataset.messageSeq!;
  });
  await startSampler(page);
  // A DOM click: Playwright's click() would first scroll the control into view.
  await page.evaluate((target) => document.querySelector<HTMLButtonElement>(`[data-revert-seq="${target}"]`)!.click(), seq);
  await page.waitForSelector(".timeline > .rewind-marker", { timeout: 15_000 });
  await page.waitForTimeout(700);
  const frames = await stopSampler(page);
  const leaving = new Set<number>();
  let firstLeavingFrame = -1;
  let lastLeavingFrame = -1;
  let markerFrame = -1;
  frames.forEach((frame, index) => {
    for (const [id, , kind] of frame.rows) {
      if (kind !== "leaving") continue;
      leaving.add(id);
      if (firstLeavingFrame < 0) firstLeavingFrame = index;
      lastLeavingFrame = index;
    }
    if (markerFrame < 0 && frame.rows.some(([, , kind]) => kind === "marker")) markerFrame = index;
  });
  console.log(`# motion revert: ${frames.length} frames; ${leaving.size} rows faded in place over frames ${firstLeavingFrame}-${lastLeavingFrame}; marker from frame ${markerFrame}`);
  assert.ok(leaving.size > 0, "the confirmed cut faded in place");
  assert.ok(markerFrame > lastLeavingFrame, "the marker appears only after the cut is gone");
  // Survivors: still while the cut fades, then only the downward glide, all
  // before the marker (the restored draft may then lift the tail as usual).
  for (const [id, list] of rowMoves(frames.slice(0, markerFrame))) {
    if (leaving.has(id)) continue;
    const early = list.find((move) => move.frame <= lastLeavingFrame);
    assert.equal(early, undefined, `survivor ${id} moved ${early?.delta}px while the cut was fading:\n    ${describeFrames(frames, early?.frame ?? -1)}`);
    const upward = list.find((move) => move.delta < 0);
    assert.equal(upward, undefined, `survivor ${id} moved up ${upward?.delta}px during the glide:\n    ${describeFrames(frames, upward?.frame ?? -1)}`);
  }
  assert.deepEqual(errors, []);
});

test("motion: opening a long chat paints at rest and moves no row down", async () => {
  const { page, errors } = await openSession(historySessionId, { ready: ".timeline > .msg", sampleFromStart: true });
  await page.waitForTimeout(1_500);
  const frames = (await stopSampler(page)).filter((frame) => frame.rows.length > 0);
  const moved = [...rowMoves(frames)].flatMap(([id, list]) => list.map((move) => ({ id, ...move })));
  console.log(`# motion open: ${frames.length} frames with rows; ${moved.length} row moves after the first painted frame`);
  // Extent history, one entry per change, for diagnosing late layout on open.
  let extent = "";
  const history = frames.flatMap((frame) => {
    const key = `${frame.scroll.join("/")} ${frame.layout.replace(/^.*\| /, "")}`;
    if (key === extent) return [];
    extent = key;
    return [`t=${frame.t.toFixed(0)} scroll=${frame.scroll.join("/")} ${frame.layout.replace(/^.*\| /, "").replace(/ deepest=.*$/, "")}`];
  });
  console.log(`# motion open extent history:\n#   ${history.join("\n#   ")}`);
  assert.ok(frames.length > 10, `too few frames sampled (${frames.length})`);
  const down = moved.find((move) => move.delta > 0);
  assert.equal(down, undefined, `row ${down?.id} moved down ${down?.delta}px after the first painted frame:\n    ${describeFrames(frames, down?.frame ?? -1)}`);
  assert.equal(downThenUp(frames), null);
  assert.deepEqual(errors, []);
});

test("motion: a run of actions folds into a block that never bounces", async () => {
  const { page, errors } = await openSession(toolsSessionId, { ready: ".timeline > .msg", uiSettings: { density: "compact" } });
  await settleLayout(page);
  await startSampler(page);
  const prompt = "Motion tools: run several actions in a row.";
  await page.fill("textarea[data-composer-input]", prompt);
  await page.click(".composer-chat button.send");
  await page.waitForSelector(".timeline > .activity-group .activity-ticker-step", { timeout: 15_000 });
  await waitForTurnSettled(toolsSessionId, prompt);
  const liveEnd = await page.evaluate(() => (window as unknown as { __motion: { frames: MotionFrame[] } }).__motion.frames.length);
  await page.waitForTimeout(150 + ACTIVITY_TICKER_DWELL_MS + 600);
  const frames = await stopSampler(page);
  // Only what the reader can see: rows above the scrollport may reflow freely.
  const visible = (frame: MotionFrame, id: number) => frame.rows.some(([row, top, , height]) =>
    row === id && top < frame.view[1] && top + height > frame.view[0]);
  const moves = [...rowMoves(frames)].flatMap(([id, list]) => list.map((move) => ({ id, ...move })))
    .filter((move) => visible(frames[move.frame - 1]!, move.id) || visible(frames[move.frame]!, move.id));
  const live = moves.filter((move) => move.frame < liveEnd);
  console.log(`# motion tools: ${describeFrames(frames)}; row moves while live: down=${live.filter((m) => m.delta > 0).length} up=${live.filter((m) => m.delta < 0).length}`);
  // Raw frames for offline analysis of a failing run.
  if (process.env.POLYTH_MOTION_DUMP) await writeFile(process.env.POLYTH_MOTION_DUMP, JSON.stringify({ liveEnd, frames }));
  // While the turn is live no row ever sinks: an action folding into its block
  // must not let the transcript drop, so the next arrival cannot lift it back.
  const sink = live.find((move) => move.delta > 0);
  assert.equal(sink, undefined, `row ${sink?.id} sank ${sink?.delta}px while the turn was live:\n    ${describeFrames(frames, sink?.frame ?? -1)}`);
  assert.equal(downThenUp(frames), null);
  assert.deepEqual(errors, []);
});

test("motion: a long session's sliding window never lifts the live tail out of view", async () => {
  // More rows than the 150-row suffix window (two per settled turn) with tall
  // prompts: every row the live turn adds unmounts a tall one far above the
  // reader. That removal once fed the extent floor and lifted the live tail
  // above the reading area until enough new rows filled the held blank.
  const longSessionId = (await post<{ id: string }>("/api/sessions", { projectId, title: LONG_TITLE })).id;
  const filler = "This padding prompt is a tall settled row far above the live turn. ".repeat(28);
  for (let turn = 1; turn <= 78; turn += 1) {
    await sendAndSettle(longSessionId, `Long padding ${turn}: ${filler}`);
  }
  const { page, errors } = await openSession(longSessionId, { ready: ".timeline > .msg" });
  await page.waitForSelector(".timeline > .timeline-earlier", { timeout: 20_000 });
  // History that lands after the open waits above the window until the
  // reader asks for it; a full, sliding window is one whose earlier rows the
  // reader revealed. A DOM click: Playwright's click() would scroll the
  // control into view, away from the followed tail.
  await page.waitForFunction(() => {
    const bar = document.querySelector<HTMLElement>(".timeline > .timeline-earlier");
    if (!bar) return true;
    if (!bar.querySelector("[aria-busy='true'], .ui-spinner")) bar.querySelector<HTMLButtonElement>("button")?.click();
    return false;
  }, undefined, { timeout: 30_000, polling: 500 });
  await settleLayout(page);
  await startSampler(page);
  const prompt = "Motion tools: run several actions in a row.";
  await page.fill("textarea[data-composer-input]", prompt);
  await page.click(".composer-chat button.send");
  // ~5,000 transcript nodes make the per-frame sampler slow (about 20 fps).
  await page.waitForSelector(".timeline > .activity-group .activity-ticker-step", { timeout: 60_000 });
  await waitForTurnSettled(longSessionId, prompt);
  const liveEnd = await page.evaluate(() => (window as unknown as { __motion: { frames: MotionFrame[] } }).__motion.frames.length);
  await page.waitForTimeout(150 + ACTIVITY_TICKER_DWELL_MS + 600);
  const frames = await stopSampler(page);
  if (process.env.POLYTH_MOTION_DUMP) await writeFile(process.env.POLYTH_MOTION_DUMP, JSON.stringify({ liveEnd, frames }));
  // Rows the window unmounted at the top while the turn was live.
  const firstRows = new Set(frames.slice(0, liveEnd).map((frame) => frame.rows.find(([, , , , label]) => label !== "earlier")?.[0]));
  // How far below the top of the view the transcript's lowest row ends.
  const tails = frames.slice(0, liveEnd).map((frame, index) => {
    const bottoms = frame.rows.filter(([, , , height]) => height > 0).map(([, top, , height]) => top + height);
    return { index, below: bottoms.length > 0 ? Math.max(...bottoms) - frame.view[0] : Number.POSITIVE_INFINITY };
  });
  const lowest = tails.reduce((low, tail) => tail.below < low.below ? tail : low, tails[0]!);
  console.log(`# motion long session: ${describeFrames(frames)}; window slid ${firstRows.size - 1} times; tail at least ${Math.round(lowest.below)}px below the view top`);
  assert.ok(firstRows.size > 1, "the live turn slid the 150-row window");
  assert.ok(lowest.below >= 48, `the live tail left the reading area (${Math.round(lowest.below)}px below its top):\n    ${describeFrames(frames, lowest.index)}`);
  const visible = (frame: MotionFrame, id: number) => frame.rows.some(([row, top, , height]) =>
    row === id && top < frame.view[1] && top + height > frame.view[0]);
  const sink = [...rowMoves(frames)].flatMap(([id, list]) => list.map((move) => ({ id, ...move })))
    .filter((move) => move.frame < liveEnd && move.delta > 0)
    .find((move) => visible(frames[move.frame - 1]!, move.id) || visible(frames[move.frame]!, move.id));
  assert.equal(sink, undefined, `row ${sink?.id} sank ${sink?.delta}px while the turn was live:\n    ${describeFrames(frames, sink?.frame ?? -1)}`);
  assert.deepEqual(errors, []);
});

test("motion: a long live chat opened on a phone over a slow link never overlaps rows or moves one down", async () => {
  // The newest window of a long live chat holds neither the turn's prompt nor
  // the history before it: those arrive with the background backfill while
  // the reader already watches the tail. That arrival once read as a send —
  // the prompt was aligned on the focus line in an unpainted frame and every
  // row was lifted from there, across the rows still in place (text drawn
  // over text), and the backfill mounted a hundred rows under the reader.
  const longId = (await post<{ id: string }>("/api/sessions", { projectId, title: "Motion marathon session" })).id;
  for (let turn = 1; turn <= 3; turn += 1) {
    await sendAndSettle(longId, `Marathon 30 30: settled padding turn ${turn} above the live one.`);
  }
  await post(`/api/sessions/${longId}/message`, { text: "Marathon 400 700: the live turn opened on a phone." });
  await sleep(10_000);
  const context = await browser!.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    reducedMotion: "no-preference", serviceWorkers: "block",
  });
  contexts.push(context);
  await context.addInitScript(() => {
    localStorage.setItem("polyth.prefs", JSON.stringify({ persona: "engineer", plugins: [] }));
    localStorage.setItem("polyth.shellIntro.v1", JSON.stringify({ seenVersion: 1_000_000 }));
    localStorage.setItem("polyth.uiSettings.v1", JSON.stringify({ glassEffect: "off" }));
    // The longest travel any transcript row is given by a glide: a lift from
    // an unpainted position travelled 800-2,000 px (not every run samples
    // the overlapping frame, but every such run starts that glide).
    const host = window as unknown as { __longestGlide: number };
    host.__longestGlide = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const first = Array.isArray(keyframes) ? keyframes[0] : undefined;
      const travel = /translate3d\(0(?:px)?, (-?[\d.]+)px/.exec(String(first?.transform ?? ""));
      if (travel && this.parentElement?.classList.contains("timeline")) {
        host.__longestGlide = Math.max(host.__longestGlide, Math.abs(Number(travel[1])));
      }
      return animate.call(this, keyframes, options);
    } as typeof Element.prototype.animate;
  });
  // A slow phone link for API reads: the backfill lands after the first paint.
  await context.route(/\/api\//, async (route) => {
    try {
      const response = await route.fetch();
      await sleep(400);
      await route.fulfill({ response });
    } catch {
      // The context closed with this request in flight (a live poll).
    }
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // Start in another chat (the launch veil lifts over it), then open the long
  // one the way the navigator does: an in-app open, nothing covering it.
  await page.goto(`${BASE}/p/${projectId}/s/${workSessionId}`, { waitUntil: "load" });
  await page.waitForSelector(".timeline > .msg", { state: "visible", timeout: 20_000 });
  await settleLayout(page);
  await startSampler(page);
  await page.evaluate(() => { (window as unknown as { __longestGlide: number }).__longestGlide = 0; });
  await page.evaluate((path) => {
    history.pushState({}, "", path);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/p/${projectId}/s/${longId}`);
  await page.waitForTimeout(8_000);
  const all = await stopSampler(page);
  // Frames of the long chat only: from the first one without the rows of the
  // chat it came from.
  const known = new Set(all[0]?.rows.map(([id]) => id) ?? []);
  const first = all.findIndex((frame) => frame.rows.length > 0 && frame.rows.every(([id]) => !known.has(id)));
  assert.ok(first >= 0, "the long chat painted");
  const frames = all.slice(first);
  const inView = (frame: MotionFrame) => frame.rows.filter(([, top, , height]) => height > 0 && top < frame.view[1] && top + height > frame.view[0]);
  let overlap: string | null = null;
  frames.forEach((frame, index) => {
    const rows = inView(frame);
    for (let i = 1; i < rows.length && overlap === null; i += 1) {
      const [aId, aTop, , aHeight, aLabel, aMotion] = rows[i - 1]!;
      const [bId, bTop, , , bLabel, bMotion] = rows[i]!;
      if (aTop + aHeight - bTop > 3) {
        overlap = `frame ${index}: row ${aId} (${aLabel} ${aMotion}) ends ${Math.round(aTop + aHeight - bTop)}px below the top of row ${bId} (${bLabel} ${bMotion})\n    ${describeFrames(frames, index)}`;
      }
    }
  });
  const visible = (frame: MotionFrame, id: number) => frame.rows.some(([row, top, , height]) =>
    row === id && top < frame.view[1] && top + height > frame.view[0]);
  const sink = [...rowMoves(frames)].flatMap(([id, list]) => list.map((move) => ({ id, ...move })))
    .filter((move) => move.delta > 0)
    .find((move) => visible(frames[move.frame - 1]!, move.id) || visible(frames[move.frame]!, move.id));
  const mounted = frames.map((frame) => frame.rows.length);
  const longestGlide = await page.evaluate(() => (window as unknown as { __longestGlide: number }).__longestGlide);
  console.log(`# motion phone open: ${describeFrames(frames)}; rows mounted ${mounted[0]} → ${Math.max(...mounted)}; longest glide ${Math.round(longestGlide)}px`);
  assert.equal(overlap, null, `rows were drawn over each other: ${overlap}`);
  assert.ok(longestGlide <= 844, `a row glided ${Math.round(longestGlide)}px, more than the screen: it started from a position nobody saw`);
  // The live turn adds a row every second or two; the backfill adds none.
  assert.ok(Math.max(...mounted) - mounted[0]! <= 20,
    `history that landed above mounted ${Math.max(...mounted) - mounted[0]!} rows under the reader instead of waiting above the window`);
  assert.equal(sink, undefined, `row ${sink?.id} sank ${sink?.delta}px while the chat opened:\n    ${describeFrames(frames, sink?.frame ?? -1)}`);
  assert.deepEqual(errors, []);
});
