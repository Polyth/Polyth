import assert from "node:assert/strict";
import { createServer, createConnection } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const appImage = resolve(process.argv[2] ?? "");
const screenshotPath = resolve(process.argv[3] ?? join(tmpdir(), "polyth-appimage-e2e.png"));
const logArtifactPath = resolve(process.argv[4] ?? join(tmpdir(), "polyth-appimage-e2e.log"));
const projectPath = resolve(process.argv[5] ?? process.cwd());
const work = await mkdtemp(join(tmpdir(), "polyth-appimage-e2e-"));
const dataDir = join(work, "data");
const configDir = join(work, "config");
const homeDir = join(work, "home");
const userDataDir = join(work, "user-data");
await mkdir(dirname(screenshotPath), { recursive: true });
await mkdir(dirname(logArtifactPath), { recursive: true });
await mkdir(join(userDataDir, "desktop"), { recursive: true });
await mkdir(homeDir, { recursive: true });
await writeFile(join(userDataDir, "desktop", "window-state.json"), `${JSON.stringify({
  bounds: { x: 24, y: 32, width: 1120, height: 720 },
  maximized: false,
}, null, 2)}\n`);

const freePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Could not reserve CDP port"));
      return;
    }
    server.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});

const run = (file, args, options = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
});
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const extracted = await run(appImage, ["--appimage-extract"], { cwd: work });
assert.equal(extracted.code, 0, `AppImage extraction failed:\n${extracted.stderr}`);
const findHostBinary = async (root) => {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findHostBinary(path);
      if (nested) return nested;
    } else if (entry.name === "polyth-link-host") {
      return path;
    }
  }
  return null;
};
const packagedHost = await findHostBinary(join(work, "squashfs-root"));
assert.ok(packagedHost, "packaged AppImage is missing polyth-link-host");
const hostData = join(work, "link-host");
const hostSocket = join(work, "link-host.sock");
await mkdir(hostData, { recursive: true });
const hostProc = spawn(packagedHost, ["serve", hostData, hostSocket], { stdio: ["ignore", "pipe", "pipe"] });
try {
  const hostReady = Date.now();
  while (!existsSync(hostSocket)) {
    if (Date.now() - hostReady > 12_000) {
      throw new Error("packaged polyth-link-host did not create a control socket");
    }
    await delay(50);
  }
  const identityRpc = await new Promise((resolve, reject) => {
    const socket = createConnection(hostSocket);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("identity.status timed out"));
    }, 8_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "identity.status", params: {} })}\n`);
    });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += String(chunk);
      if (!buf.includes("\n")) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.slice(0, buf.indexOf("\n"))));
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
  });
  assert.equal(identityRpc.id, 1);
  assert.equal(typeof identityRpc.result?.fingerprint, "string");
  assert.ok(identityRpc.result.fingerprint.length >= 8);
} finally {
  hostProc.kill("SIGTERM");
  const hostDeadline = Date.now() + 3_000;
  while (hostProc.exitCode === null && Date.now() < hostDeadline) await delay(50);
  if (hostProc.exitCode === null) hostProc.kill("SIGKILL");
}
const appRun = join(work, "squashfs-root", "AppRun");
const cdpPort = await freePort();
const appOutput = [];
const appEnv = { ...process.env };
// Exercise the packaged binary, not the invoking developer's OpenCode DB or plugins.
for (const key of Object.keys(appEnv)) {
  if (key.startsWith("OPENCODE_")) delete appEnv[key];
}
const child = spawn(appRun, [
  "--no-sandbox",
  `--remote-debugging-port=${cdpPort}`,
], {
  cwd: projectPath,
  env: {
    ...appEnv,
    HOME: homeDir,
    POLYTH_DESKTOP_E2E: "1",
    POLYTH_DESKTOP_USER_DATA: userDataDir,
    POLYTH_DATA_DIR: dataDir,
    XDG_CONFIG_HOME: configDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => appOutput.push(String(chunk)));
child.stderr.on("data", (chunk) => appOutput.push(String(chunk)));

const waitForTarget = async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((response) => response.json());
      const target = targets.find((entry) => entry.type === "page" && entry.url.startsWith("http://127.0.0.1:"));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Electron has not opened its debugging endpoint yet.
    }
    if (child.exitCode !== null) throw new Error(`AppImage exited during startup with ${child.exitCode}`);
    await delay(250);
  }
  throw new Error("Timed out waiting for the AppImage renderer");
};

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async ready() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
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
    return new Promise((resolveMessage, reject) => {
      this.pending.set(id, { resolve: resolveMessage, reject });
    });
  }

  async evaluate(expression, timeoutMs = 30_000) {
    let timer;
    const result = await Promise.race([
      this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CDP evaluation timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

let report;
let failure;
try {
  const connectCdp = async () => {
    const target = await waitForTarget();
    const connection = new Cdp(target.webSocketDebuggerUrl);
    await connection.ready();
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    return connection;
  };
  let cdp = await connectCdp();
  const rendererReadyExpression = `new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000;
      const check = () => {
        if (window.polythDesktop && document.querySelector(".header")) resolve(true);
        else if (Date.now() > deadline) reject(new Error("desktop bridge or app header did not load"));
        else setTimeout(check, 100);
      };
      check();
    })`;
  const evaluateAcrossRendererReload = async (expression, timeoutMs) => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        return await cdp.evaluate(expression, timeoutMs);
      } catch (error) {
        const destroyed = String(error?.message ?? error).includes("Execution context was destroyed");
        if (attempt === 5 || !destroyed) throw error;
        try { cdp.socket.close(); } catch { /* already closed */ }
        await delay(500 * attempt);
        cdp = await connectCdp();
      }
    }
    throw new Error("renderer evaluation retry exhausted");
  };
  await evaluateAcrossRendererReload(rendererReadyExpression, 35_000);

  report = await evaluateAcrossRendererReload(`(async () => {
    const api = window.polythDesktop;
    const healthResponse = await fetch("/api/health");
    if (!healthResponse.ok) throw new Error("health endpoint " + healthResponse.status);
    const health = await healthResponse.json();
    const info = await api.getInfo();
    const initialSettings = await api.getSettings();
    let models = [];
    const modelsDeadline = Date.now() + 30_000;
    while (models.length === 0 && Date.now() < modelsDeadline) {
      const modelsResponse = await fetch("/api/models");
      if (!modelsResponse.ok) throw new Error("models endpoint " + modelsResponse.status + " " + await modelsResponse.text());
      models = await modelsResponse.json();
      if (models.length === 0) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const restoredBounds = {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth,
      height: window.outerHeight,
    };
    const security = {
      nodeGlobalAbsent: typeof window.require === "undefined" && typeof window.process === "undefined",
      frozenBridge: Object.isFrozen(api),
      relativePathRejected: await api.revealPath("package.json").then(() => false, () => true),
      unknownWindowActionRejected: await api.windowAction("not-an-action").then(() => false, () => true),
      fileWindowDenied: window.open("file:///etc/passwd") === null,
    };

    await api.setSettings({
      closeToTray: true,
      controlsPosition: "right",
      controlsTheme: "dark",
      launchAtLogin: true,
      keepAwake: true,
      automaticUpdates: false,
    });
    window.dispatchEvent(new CustomEvent("polyth:open-settings"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Skip all onboardings"))
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    window.dispatchEvent(new CustomEvent("polyth:settings-page", { detail: "desktop" }));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const page = document.querySelector(".settings-page-desktop");
    if (!page) throw new Error("Desktop settings page was not contributed");
    const lowResourceRow = document.querySelector('[data-settings-item="desktop.lowResourceMode"]');
    if (!lowResourceRow) throw new Error("Low resource mode setting was not contributed");
    const reduceAnimationsRow = document.querySelector('[data-settings-item="desktop.reduceAnimations"]');
    if (!reduceAnimationsRow) throw new Error("Reduce animations setting was not contributed");
    const controlButtons = [...document.querySelectorAll(".desktop-window-button")];
    if (controlButtons.length !== 3) throw new Error("Expected three desktop window buttons");
    const maximize = document.querySelector('[aria-label="Maximize window"]');
    maximize?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    document.querySelector('[aria-label="Restore window"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const positionRow = document.querySelector('[data-settings-item="desktop.controlsPosition"]');
    [...positionRow.querySelectorAll("button")].find((button) => button.textContent === "Left")?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const settings = await api.getSettings();
    const updatedInfo = await api.getInfo();
    if (settings.controlsPosition !== "left") throw new Error("Window control position did not persist");
    if (document.body.dataset.desktopControlsPosition !== "left") throw new Error("Window control position did not apply");
    const controlThemes = {};
    for (const theme of ["light", "system", "dark"]) {
      await api.setSettings({ controlsTheme: theme });
      await new Promise((resolve) => setTimeout(resolve, 100));
      controlThemes[theme] = document.body.dataset.desktopControlsTheme;
    }
    await api.setSettings({ reduceAnimations: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reductionApplied = document.documentElement.dataset.reduceAnimations === "true";
    await api.setSettings({ reduceAnimations: false });

    await api.revealPath(${JSON.stringify(join(projectPath, "package.json"))});
    const update = await api.checkForUpdates();
    lowResourceRow.scrollIntoView({ block: "center" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      health,
      info,
      initialSettings,
      settings,
      controlThemes,
      restoredBounds,
      security,
      update,
      modelCount: models.length,
      sampleModels: models.slice(0, 3).map((model) => model.providerID + "/" + model.modelID),
      desktopPage: !!page,
      windowButtonCount: controlButtons.length,
      trayAvailable: info.trayAvailable,
      canLaunchAtLogin: info.canLaunchAtLogin,
      keepAwakeActive: updatedInfo.keepAwakeActive,
      lowResourceSetting: !!lowResourceRow,
      reduceAnimationsSetting: !!reduceAnimationsRow && reductionApplied,
    };
  })()`, 120_000);

  assert.equal(report.health.ok, true);
  assert.equal(report.info.packaged, true);
  assert.equal(report.info.opencodeVersion, "1.18.22");
  assert.equal(report.desktopPage, true);
  assert.equal(report.windowButtonCount, 3);
  assert.equal(report.trayAvailable, true);
  assert.equal(report.canLaunchAtLogin, true);
  assert.equal(report.keepAwakeActive, true);
  assert.equal(report.lowResourceSetting, true);
  assert.equal(report.reduceAnimationsSetting, true);
  assert.deepEqual(report.controlThemes, { light: "light", system: "system", dark: "dark" });
  assert.deepEqual(report.security, {
    nodeGlobalAbsent: true,
    frozenBridge: true,
    relativePathRejected: true,
    unknownWindowActionRejected: true,
    fileWindowDenied: true,
  });
  // X11/GTK can report a small outer-decoration delta even for a frameless
  // BrowserWindow; this still distinguishes the restored size from defaults.
  const decorationTolerance = 24;
  assert.ok(Math.abs(report.restoredBounds.x - 24) <= decorationTolerance, `restored x was ${report.restoredBounds.x}`);
  assert.ok(Math.abs(report.restoredBounds.y - 32) <= decorationTolerance, `restored y was ${report.restoredBounds.y}`);
  assert.ok(Math.abs(report.restoredBounds.width - 1120) <= decorationTolerance, `restored width was ${report.restoredBounds.width}`);
  assert.ok(Math.abs(report.restoredBounds.height - 720) <= decorationTolerance, `restored height was ${report.restoredBounds.height}`);
  assert.ok(report.modelCount > 0, "Bundled OpenCode returned no models");

  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  const hiddenState = await cdp.evaluate(`window.polythDesktop.windowAction("close")`);
  assert.equal(hiddenState.visible, false, "Close-to-tray did not hide the window");
  report.closeToTrayHidden = true;
  await delay(800);
  await cdp.evaluate(`window.polythDesktop.quit()`);
  cdp.socket.close();
  const quitDeadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < quitDeadline) await delay(100);
  assert.notEqual(child.exitCode, null, "Desktop app did not quit after the native quit action");
  assert.equal(child.exitCode, 0, "Desktop app did not exit cleanly");
} catch (error) {
  failure = error;
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null) child.kill("SIGKILL");
  // Native file-manager processes may inherit the app's output descriptors
  // after Electron exits. Do not let those unrelated GUI processes keep the
  // Node harness alive indefinitely.
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

const desktopLog = await readFile(join(userDataDir, "desktop", "polyth-desktop.log"), "utf8").catch(() => "");
const autostartEntry = await readFile(join(configDir, "autostart", "polyth.desktop"), "utf8").catch(() => "");
const combined = [
  "POLYTH APPIMAGE END-TO-END REPORT",
  JSON.stringify(report ?? null, null, 2),
  ...(failure ? ["", "FAILURE", failure instanceof Error ? `${failure.message}\n${failure.stack ?? ""}` : String(failure)] : []),
  "",
  "APP OUTPUT",
  appOutput.join(""),
  "",
  "DESKTOP LOG",
  desktopLog,
  "",
  "LINUX AUTOSTART ENTRY",
  autostartEntry,
].join("\n");
await writeFile(logArtifactPath, combined);

if (failure) throw failure;
assert.match(combined, /System tray created with context menu/);
assert.match(combined, /Bundled OpenCode 1\.18\.22/);
assert.match(combined, /Revealed path in native file manager/);
assert.match(combined, /Window hidden to tray/);
assert.match(combined, /Polyth server stopped/);
assert.match(autostartEntry, /--background/);
console.log(JSON.stringify({
  ok: true,
  appImage,
  screenshotPath,
  logArtifactPath,
  ...report,
}, null, 2));
