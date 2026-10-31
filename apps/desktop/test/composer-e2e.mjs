// First-run composer check for a packaged desktop build: fresh data, the real
// in-window setup and its server restart, then the new-chat composer must
// offer a model. This is what a user sees after installing; the startup smoke
// stops at the setup server and the AppImage e2e checks only the API.
//
//   node apps/desktop/test/composer-e2e.mjs <packaged executable> [screenshot.png]
//
// On failure it reports the composer's own text, /api requests still pending,
// console errors and the desktop log.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "");
const screenshotPath = resolve(process.argv[3] ?? join(tmpdir(), "polyth-composer-e2e.png"));
const MODEL_DEADLINE_MS = Number(process.env.POLYTH_COMPOSER_E2E_DEADLINE_MS ?? 120_000);
// --unicode puts data and the project under a non-ASCII path with spaces, like
// a Windows profile named in Cyrillic.
const unicode = process.argv.includes("--unicode");
const work = await mkdtemp(join(tmpdir(), unicode ? "polyth e2e Користувач " : "polyth-composer-e2e-"));
const userDataDir = join(work, "user-data");
const projectDir = join(work, unicode ? "Мій проєкт" : "project");
await mkdir(projectDir, { recursive: true });
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const started = Date.now();
const say = (message) => console.log(`[composer-e2e +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

const cdpPort = await freePort();
const appOutput = [];
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("OPENCODE_") || key.startsWith("POLYTH_")) delete env[key];
const child = spawn(executable, [
  `--remote-debugging-port=${cdpPort}`,
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  ...(process.platform === "win32" ? ["--no-sandbox", "--disable-gpu"] : []),
], {
  env: { ...env, POLYTH_DESKTOP_USER_DATA: userDataDir, POLYTH_DATA_DIR: join(work, "data"), ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => appOutput.push(String(chunk)));
child.stderr.on("data", (chunk) => appOutput.push(String(chunk)));

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
  }
  async ready() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveMessage, reject) => this.pending.set(id, { resolve: resolveMessage, reject }));
  }
  async evaluate(expression, timeoutMs = 30_000) {
    let timer;
    const result = await Promise.race([
      this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`CDP evaluation timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}

const requests = new Map();
const consoleErrors = [];
const connect = async () => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited during startup with ${child.exitCode}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
      const target = targets.find((entry) => entry.type === "page" && entry.url.startsWith("http://127.0.0.1:"));
      if (target?.webSocketDebuggerUrl) {
        const cdp = new Cdp(target.webSocketDebuggerUrl);
        await cdp.ready();
        cdp.listeners.push((message) => {
          const { method, params } = message;
          if (method === "Network.requestWillBeSent" && params.request.url.includes("/api/")) {
            requests.set(params.requestId, { url: params.request.url.replace(/^https?:\/\/[^/]+/, ""), at: Date.now() });
          } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
            const entry = requests.get(params.requestId);
            if (entry) { entry.done = Date.now(); entry.failed = params.errorText; }
          } else if (method === "Network.responseReceived") {
            const entry = requests.get(params.requestId);
            if (entry) entry.status = params.response.status;
          } else if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "warning")) {
            consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? "").join(" ").slice(0, 600));
          } else if (method === "Runtime.exceptionThrown") {
            consoleErrors.push(String(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text).slice(0, 600));
          }
        });
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        await cdp.send("Network.enable");
        return cdp;
      }
    } catch {
      // The debugging endpoint or page is not up yet.
    }
    await delay(250);
  }
  throw new Error("timed out waiting for the renderer");
};

const evaluateWithRetry = async (cdp, expression, timeoutMs) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { cdp, value: await cdp.evaluate(expression, timeoutMs) };
    } catch (error) {
      if (attempt >= 6 || !/context was destroyed|Cannot find context|closed/i.test(String(error?.message ?? error))) throw error;
      try { cdp.socket.close(); } catch {}
      await delay(500 * attempt);
      cdp = await connect();
    }
  }
};

let failure;
let state;
let cdp;
try {
  cdp = await connect();
  say("renderer connected");
  ({ cdp } = await evaluateWithRetry(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 60000;
    const check = () => window.polythDesktop ? resolve(true) : Date.now() > deadline ? reject(new Error("desktop bridge did not load")) : setTimeout(check, 100);
    check();
  })`, 65_000));
  // Same setup sequence as the setup form (see appimage-e2e.mjs).
  let setup;
  ({ cdp, value: setup } = await evaluateWithRetry(cdp, `(async () => {
    const desktop = window.polythDesktop;
    const status = await (await fetch("/api/auth/status", { cache: "no-store" })).json();
    if (status.state === "ready") return "ready";
    const form = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 60000;
      const check = () => document.querySelector("input[name=setup-usage]") ? resolve("usage") : document.querySelector("input#setup-name") ? resolve("account") : Date.now() > deadline ? reject(new Error("desktop setup form did not load")) : setTimeout(check, 100);
      check();
    });
    if (form === "usage") {
      const local = await desktop.completeLocalSetup();
      if (!local?.ok) throw new Error("first run without a password failed: " + (local?.error ?? "no result"));
      await desktop.restartAfterSetup();
      return "restarted";
    }
    const claim = await desktop.requestSetupClaim();
    let csrfToken = status.csrfToken;
    const request = async (path, body) => {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-polyth-csrf": csrfToken }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (typeof payload.csrfToken === "string") csrfToken = payload.csrfToken;
      if (!response.ok) throw new Error(path + ": HTTP " + response.status + " " + (payload.message ?? payload.error ?? ""));
      return payload;
    };
    await request("/api/auth/setup/claim", { claimToken: claim.claimToken });
    const recovery = await request("/api/auth/setup/recovery", { claimToken: claim.claimToken });
    await request("/api/auth/setup/complete", {
      claimToken: claim.claimToken, name: "Composer E2E", organizationName: "Composer E2E", login: "e2e",
      password: "composer-e2e-test-passphrase", recoverySetId: recovery.setId, recoveryAcknowledged: true,
    });
    await desktop.restartAfterSetup();
    return "restarted";
  })()`, 120_000));
  say(`setup: ${setup}`);
  // SetupScreen.finishDesktop reloads the same window after the restart.
  if (setup === "restarted") await cdp.send("Page.reload", {});
  ({ cdp } = await evaluateWithRetry(cdp, `new Promise((resolve, reject) => {
    const deadline = Date.now() + 60000;
    const check = () => document.querySelector(".app-shell") ? resolve(true) : Date.now() > deadline ? reject(new Error("app shell did not load")) : setTimeout(check, 200);
    check();
  })`, 65_000));
  // Skip the first-open tour, then open a folder the way "Open project" does.
  let opened;
  ({ cdp, value: opened } = await evaluateWithRetry(cdp, `(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Skip tour")?.click();
    const status = await (await fetch("/api/auth/status", { cache: "no-store" })).json();
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-polyth-csrf": status.csrfToken ?? "" },
      body: JSON.stringify({ path: ${JSON.stringify(projectDir)} }),
    });
    return response.status + " " + (await response.text()).slice(0, 300);
  })()`, 30_000));
  say(`open project: ${opened}`);
  // Only the requests of the page the person ends up on are evidence.
  requests.clear();
  await cdp.send("Page.reload", {});

  // Read the composer until it offers a model or the deadline passes.
  const readComposer = `(() => {
    [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Skip tour")?.click();
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      href: location.pathname,
      shell: Boolean(document.querySelector(".app-shell")),
      composer: Boolean(document.querySelector(".composer-card")),
      note: text(".composer-runtime-unavailable"),
      config: text(".composer-config-row"),
      setupForm: Boolean(document.querySelector("input#setup-name")),
      intro: Boolean(document.querySelector(".shell-intro-card")),
    };
  })()`;
  const deadline = Date.now() + MODEL_DEADLINE_MS;
  let last = "";
  for (;;) {
    ({ cdp, value: state } = await evaluateWithRetry(cdp, readComposer, 15_000));
    const line = JSON.stringify(state);
    if (line !== last) { say(`composer ${line}`); last = line; }
    if (state.composer && !state.note && state.config && !/^No model/.test(state.config)) break;
    if (Date.now() > deadline) throw new Error(`composer offered no model within ${MODEL_DEADLINE_MS}ms`);
    await delay(1_000);
  }
  say(`PASS — composer offers a model: ${state.config}`);
} catch (error) {
  failure = error;
  console.error(`composer-e2e: FAILED — ${error?.stack ?? error}`);
} finally {
  if (cdp) {
    try {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      await mkdir(dirname(screenshotPath), { recursive: true });
      await writeFile(screenshotPath, Buffer.from(shot.data, "base64"));
      say(`screenshot ${screenshotPath}`);
    } catch {}
  }
  if (failure && cdp) {
    // What the server answers now, for the composer's own route and OpenCode.
    try {
      const answers = await cdp.evaluate(`(async () => {
        const projectId = location.pathname.match(/^\\/p\\/([^/]+)/)?.[1] ?? "";
        const read = async (path) => {
          const started = Date.now();
          try {
            const response = await fetch(path, { cache: "no-store", signal: AbortSignal.timeout(60000) });
            return { path, ms: Date.now() - started, status: response.status, body: await response.json().catch(() => null) };
          } catch (error) { return { path, ms: Date.now() - started, error: String(error) }; }
        };
        const rows = (answer) => Array.isArray(answer.body) ? answer.body.map((row) => ({
          id: row.identity?.id, state: row.availability?.state, installed: row.availability?.installed,
          message: row.message, models: row.catalog?.models?.length ?? null, stale: row.stale,
        })) : answer.body;
        const q = new URLSearchParams({ projectId });
        const auto = await read("/api/harnesses/snapshots?" + q + "&auto=1&detail=1");
        const opencode = await read("/api/harnesses/snapshots?" + q + "&harnessId=opencode&detail=1");
        const models = await read("/api/models");
        const diagnostics = await read("/api/runtime/diagnostics");
        return {
          auto: { ms: auto.ms, status: auto.status, error: auto.error, rows: rows(auto) },
          opencode: { ms: opencode.ms, status: opencode.status, error: opencode.error, rows: rows(opencode) },
          models: { ms: models.ms, count: Array.isArray(models.body) ? models.body.length : models.body },
          diagnostics: diagnostics.body,
          storage: Object.keys(localStorage).filter((key) => /catalog|harness|model/i.test(key)),
        };
      })()`, 150_000);
      console.log(`--- server answers now ---\n${JSON.stringify(answers, null, 2).slice(0, 12_000)}`);
    } catch (error) {
      console.log(`--- server answers unavailable: ${error?.message ?? error}`);
    }
  }
  const now = Date.now();
  const slow = [...requests.values()].filter((entry) => !entry.done ? now - entry.at > 5_000 : entry.done - entry.at > 5_000 || entry.failed);
  console.log(`--- /api requests pending or slow (>5s) or failed ---\n${slow.map((entry) => `${entry.done ? `${entry.done - entry.at}ms` : `PENDING ${now - entry.at}ms`} ${entry.status ?? ""} ${entry.failed ?? ""} ${entry.url}`).join("\n") || "none"}`);
  console.log(`--- /api requests (${requests.size}) ---\n${[...requests.values()].map((entry) => `${entry.done ? `${entry.done - entry.at}ms` : "PENDING"} ${entry.status ?? ""} ${entry.url}`).join("\n")}`);
  console.log(`--- console errors/warnings ---\n${consoleErrors.join("\n") || "none"}`);
  const desktopLog = await readFile(join(userDataDir, "desktop", "polyth-desktop.log"), "utf8").catch(() => "");
  console.log(`--- desktop log ---\n${desktopLog.slice(-12_000)}`);
  if (failure) console.log(`--- app output ---\n${appOutput.join("").slice(-12_000)}`);
  if (child.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  await rm(work, { recursive: true, force: true }).catch(() => {});
  process.exit(failure ? 1 : 0);
}
