import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

const appImage = resolve(process.argv[2] ?? "");
const outputPath = resolve(process.argv[3] ?? join(tmpdir(), "polyth-appimage-profile.json"));
const projectPath = resolve(process.argv[4] ?? process.cwd());
const profileMode = process.argv[5] === "low-resource" ? "low-resource" : "standard";
const sampleMs = Math.max(5_000, Number(process.env.POLYTH_PROFILE_SAMPLE_MS) || 30_000);
const work = await mkdtemp(join(tmpdir(), `polyth-profile-${profileMode}-`));
const dataDir = join(work, "data");
const configDir = join(work, "config");
const userDataDir = join(work, "user-data");
const desktopDir = join(userDataDir, "desktop");
const desktopLogPath = join(desktopDir, "polyth-desktop.log");
const screenshotPath = outputPath.replace(/\.json$/i, ".png");
await mkdir(dirname(outputPath), { recursive: true });

if (profileMode === "low-resource") {
  await mkdir(desktopDir, { recursive: true });
  await writeFile(join(desktopDir, "settings.json"), `${JSON.stringify({
    closeToTray: true,
    startMinimized: false,
    launchAtLogin: false,
    keepAwake: false,
    automaticUpdates: false,
    controlsPosition: "right",
    controlsTheme: "system",
    lowResourceMode: true,
  }, null, 2)}\n`, { mode: 0o600 });
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const run = (file, args, options = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(file, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
});
const exec = (file, args) => new Promise((resolveExec) => {
  execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
    resolveExec({ code: error?.code ?? 0, stdout, stderr });
  });
});
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

assert.ok((await stat(appImage)).isFile(), `AppImage not found: ${appImage}`);
const extracted = await run(appImage, ["--appimage-extract"], { cwd: work });
assert.equal(extracted.code, 0, `AppImage extraction failed:\n${extracted.stderr}`);
const appRun = join(work, "squashfs-root", "AppRun");
const cdpPort = await freePort();
const appOutput = [];
const launchAt = performance.now();
const child = spawn(appRun, [
  "--no-sandbox",
  `--remote-debugging-port=${cdpPort}`,
], {
  cwd: projectPath,
  env: {
    ...process.env,
    // Deliberately omit ~/.opencode/bin and npm's global bin. The packaged
    // desktop must pass its absolute, verified OpenCode resource path.
    PATH: "/usr/bin:/bin",
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

const readDesktopLog = () => readFile(desktopLogPath, "utf8").catch(() => "");
const waitForLog = async (pattern, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = await readDesktopLog();
    if (pattern.test(content)) return performance.now() - launchAt;
    if (child.exitCode !== null) throw new Error(`AppImage exited during startup with ${child.exitCode}`);
    await delay(50);
  }
  throw new Error(`Timed out waiting for desktop log pattern ${pattern}`);
};
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
    await delay(100);
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
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolveOpen, reject) => {
        this.socket.addEventListener("open", resolveOpen, { once: true });
        this.socket.addEventListener("error", reject, { once: true });
      });
    }
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
    const result = await Promise.race([
      this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
      delay(timeoutMs).then(() => { throw new Error(`CDP evaluation timed out after ${timeoutMs}ms`); }),
    ]);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

const connectCdp = async () => {
  const target = await waitForTarget();
  const connection = new Cdp(target.webSocketDebuggerUrl);
  await connection.ready();
  await connection.send("Page.enable");
  await connection.send("Runtime.enable");
  return connection;
};
let cdp;
const reconnectCdp = async () => {
  cdp?.socket.close();
  await delay(500);
  cdp = await connectCdp();
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const check = () => {
      if (window.polythDesktop && document.querySelector(".header")) resolve(true);
      else if (Date.now() > deadline) reject(new Error("renderer did not reload"));
      else setTimeout(check, 100);
    };
    check();
  })`, 35_000);
};

const classify = (pid, command) => {
  if (pid === child.pid) return "electron-main+server";
  if (command.includes("/opencode/") && command.includes(" serve")) return "opencode";
  if (command.includes("--type=renderer")) return "electron-renderer";
  if (command.includes("--type=gpu-process")) return "electron-gpu";
  if (command.includes("--type=utility")) return "electron-utility";
  if (command.includes("--type=zygote") || command.includes("chrome_crashpad")) return "electron-helper";
  if (/\b(node|bash|sh)\b/.test(command)) return "terminal-child";
  return "other";
};
const parseKb = (status, key) => Number(status.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"))?.[1] ?? 0);
const parseIo = (io, key) => Number(io.match(new RegExp(`^${key}:\\s+(\\d+)$`, "m"))?.[1] ?? 0);
const procSnapshot = async () => {
  const ids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  const entries = [];
  for (const pid of ids) {
    try {
      const [statLine, status, commandRaw, io] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8"),
        readFile(`/proc/${pid}/cmdline`),
        readFile(`/proc/${pid}/io`, "utf8").catch(() => ""),
      ]);
      const end = statLine.lastIndexOf(")");
      const fields = statLine.slice(end + 2).trim().split(/\s+/);
      const command = commandRaw.toString("utf8").replaceAll("\0", " ").trim();
      entries.push({
        pid,
        ppid: Number(fields[1]),
        ticks: Number(fields[11]) + Number(fields[12]),
        rssKb: parseKb(status, "VmRSS"),
        vmsKb: parseKb(status, "VmSize"),
        readBytes: parseIo(io, "read_bytes"),
        writeBytes: parseIo(io, "write_bytes"),
        command,
      });
    } catch {
      // Process exited between /proc enumeration and reads.
    }
  }
  const descendants = new Set([child.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!descendants.has(entry.pid) && descendants.has(entry.ppid)) {
        descendants.add(entry.pid);
        changed = true;
      }
    }
  }
  return entries.filter((entry) => descendants.has(entry.pid));
};
const round = (value, digits = 2) => Number(value.toFixed(digits));
const sampleState = async (name) => {
  const started = performance.now();
  let previous = new Map();
  let previousAt = started;
  const aggregate = new Map();
  const processCommands = new Map();
  const take = async () => {
    const now = performance.now();
    const entries = await procSnapshot();
    const current = new Map(entries.map((entry) => [entry.pid, entry]));
    const currentMemory = new Map();
    for (const entry of entries) {
      const group = classify(entry.pid, entry.command);
      processCommands.set(entry.pid, { group, command: entry.command });
      const memory = currentMemory.get(group) ?? { rssKb: 0, vmsKb: 0, count: 0 };
      memory.rssKb += entry.rssKb;
      memory.vmsKb += entry.vmsKb;
      memory.count += 1;
      currentMemory.set(group, memory);
      const old = previous.get(entry.pid);
      const totals = aggregate.get(group) ?? {
        cpuTicks: 0,
        readBytes: 0,
        writeBytes: 0,
        peakRssKb: 0,
        peakVmsKb: 0,
        peakCount: 0,
        lastRssKb: 0,
        lastVmsKb: 0,
        lastCount: 0,
      };
      if (old) {
        totals.cpuTicks += Math.max(0, entry.ticks - old.ticks);
        totals.readBytes += Math.max(0, entry.readBytes - old.readBytes);
        totals.writeBytes += Math.max(0, entry.writeBytes - old.writeBytes);
      }
      aggregate.set(group, totals);
    }
    for (const [group, memory] of currentMemory) {
      const totals = aggregate.get(group);
      totals.peakRssKb = Math.max(totals.peakRssKb, memory.rssKb);
      totals.peakVmsKb = Math.max(totals.peakVmsKb, memory.vmsKb);
      totals.peakCount = Math.max(totals.peakCount, memory.count);
      totals.lastRssKb = memory.rssKb;
      totals.lastVmsKb = memory.vmsKb;
      totals.lastCount = memory.count;
    }
    previous = current;
    previousAt = now;
  };
  await take();
  while (performance.now() - started < sampleMs) {
    await delay(Math.min(1_000, Math.max(0, sampleMs - (performance.now() - started))));
    await take();
  }
  const elapsedMs = Math.max(1, previousAt - started);
  const groups = Object.fromEntries([...aggregate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, value]) => [
    group,
    {
      rssMiB: round(value.lastRssKb / 1024),
      peakRssMiB: round(value.peakRssKb / 1024),
      vmsMiB: round(value.lastVmsKb / 1024),
      peakVmsMiB: round(value.peakVmsKb / 1024),
      cpuPercentAvg: round(value.cpuTicks * 1_000 / elapsedMs),
      processCount: value.lastCount,
      peakProcessCount: value.peakCount,
      diskReadMiB: round(value.readBytes / 1024 / 1024, 3),
      diskWriteMiB: round(value.writeBytes / 1024 / 1024, 3),
    },
  ]));
  const total = Object.values(groups).reduce((sum, group) => ({
    rssMiB: sum.rssMiB + group.rssMiB,
    peakRssMiB: sum.peakRssMiB + group.peakRssMiB,
    vmsMiB: sum.vmsMiB + group.vmsMiB,
    cpuPercentAvg: sum.cpuPercentAvg + group.cpuPercentAvg,
    processCount: sum.processCount + group.processCount,
    diskReadMiB: sum.diskReadMiB + group.diskReadMiB,
    diskWriteMiB: sum.diskWriteMiB + group.diskWriteMiB,
  }), {
    rssMiB: 0,
    peakRssMiB: 0,
    vmsMiB: 0,
    cpuPercentAvg: 0,
    processCount: 0,
    diskReadMiB: 0,
    diskWriteMiB: 0,
  });
  for (const key of Object.keys(total)) total[key] = round(total[key], key.includes("disk") ? 3 : 2);
  return {
    name,
    sampleSeconds: round(elapsedMs / 1_000),
    total,
    groups,
    processes: [...processCommands.entries()].map(([pid, value]) => ({ pid, ...value })),
  };
};

const report = {
  profileMode,
  appImage,
  appImageMiB: round((await stat(appImage)).size / 1024 / 1024),
  sampleSecondsPerState: sampleMs / 1_000,
  startup: {},
  checks: {},
  states: [],
  psSnapshot: "",
  screenshotPath,
};
let failure;
let terminalSocket;
try {
  const serverReadyPromise = waitForLog(/Polyth server started at/);
  cdp = await connectCdp();
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const check = () => {
      if (window.polythDesktop && document.querySelector(".header")) resolve(true);
      else if (Date.now() > deadline) reject(new Error("desktop bridge or app header did not load"));
      else setTimeout(check, 100);
    };
    check();
  })`, 35_000);
  report.startup.serverReadyMs = round(await serverReadyPromise);
  report.startup.uiReadyMs = round(performance.now() - launchAt);
  report.states.push(await sampleState("idle"));

  const health = await cdp.evaluate(`fetch("/api/health").then(async (response) => ({
    status: response.status,
    body: await response.json(),
  }))`);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  report.checks.health = health.body;
  report.states.push(await sampleState("server-running"));

  const active = await cdp.evaluate(`(async () => {
    const json = (method, body) => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const project = await fetch("/api/projects", json("POST", {
      path: ${JSON.stringify(projectPath)},
      name: "Desktop profile",
    })).then((response) => response.json());
    const session = await fetch("/api/sessions", json("POST", {
      projectId: project.id,
      title: "Desktop resource profile",
    })).then((response) => response.json());
    const models = await fetch("/api/models").then((response) => response.json());
    const terminal = await fetch("/api/terminals", json("POST", {
      projectId: project.id,
      cols: 97,
      rows: 31,
    })).then((response) => response.json());
    const workflow = await fetch("/api/workflows", json("POST", {
      projectId: project.id,
      name: "Profile workflow",
      nodes: [
        { id: "inspect", role: "Inspector", prompt: "Inspect the project." },
        { id: "review", role: "Reviewer", prompt: "Review the inspection." },
      ],
      edges: [{ id: "inspect-review", source: "inspect", target: "review" }],
      defaults: { pipe: "ancestors", permissions: "manual", maxParallel: 1, nodeTimeoutMs: 60000 },
    })).then((response) => response.json());
    const workflows = await fetch("/api/workflows?projectId=" + encodeURIComponent(project.id))
      .then((response) => response.json());
    return {
      project,
      session,
      modelCount: models.length,
      terminalId: terminal.terminalId,
      workflow,
      workflowListed: workflows.some((candidate) => candidate.id === workflow.id),
    };
  })()`, 120_000);
  assert.ok(active.project.id);
  assert.ok(active.session.id);
  assert.ok(active.modelCount > 0, "Bundled OpenCode returned no models");
  assert.equal(active.workflowListed, true);
  report.checks.activeSession = active;

  const terminalResultPromise = cdp.evaluate(`new Promise((resolve, reject) => {
    const id = ${JSON.stringify(active.terminalId)};
    const socket = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws/terminal/" + id);
    window.__polythProfileTerminal = socket;
    let output = "";
    const timer = setTimeout(() => reject(new Error("terminal command output timed out: " + output)), 15000);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "attached") {
        for (const command of [
          "stty -echo\\n",
          "printf 'POLYTH_PTY_BEGIN\\\\n'\\n",
          "printf 'TERM=%s\\\\n' \\"$TERM\\"\\n",
          "stty size\\n",
          "pwd\\n",
          "uname -s\\n",
          "printf 'UNICODE=✓\\\\n'\\n",
          "printf 'POLYTH_PTY_END\\\\n'\\n",
        ]) socket.send(JSON.stringify({ type: "data", data: command }));
      }
      if (message.type === "replay" || message.type === "data") output += message.data || "";
      // The line discipline can echo the command before stty -echo takes
      // effect. Wait for the second token, which is the command's real output.
      if ((output.match(/POLYTH_PTY_END/g) ?? []).length >= 2) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    socket.onerror = () => reject(new Error("terminal WebSocket failed"));
  })`, 20_000);
  const terminalOutput = await terminalResultPromise;
  assert.match(terminalOutput, /TERM=xterm-256color/);
  assert.match(terminalOutput, /31 97/);
  assert.match(terminalOutput, new RegExp(projectPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(terminalOutput, /Linux/);
  assert.match(terminalOutput, /UNICODE=✓/);
  assert.doesNotMatch(terminalOutput, /Inappropriate ioctl/);
  report.checks.terminalOutput = terminalOutput;

  await cdp.evaluate(`localStorage.setItem("polyth.locale", "fr"); location.reload()`).catch(() => {});
  await reconnectCdp();
  const localized = await cdp.evaluate(`(() => {
    window.dispatchEvent(new CustomEvent("polyth:open-settings"));
    return new Promise((resolve) => setTimeout(() => resolve({
      lang: document.documentElement.lang,
      locale: document.documentElement.dataset.locale,
      hasFrenchSettings: document.body.textContent.includes("Paramètres"),
    }), 500));
  })()`);
  assert.deepEqual(localized, { lang: "fr", locale: "fr", hasFrenchSettings: true });
  report.checks.locale = localized;
  await cdp.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "\`", ctrlKey: true, bubbles: true }));
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const check = () => {
        if (document.querySelector(".term-view")) resolve(true);
        else if (Date.now() > deadline) reject(new Error("terminal UI did not open"));
        else setTimeout(check, 100);
      };
      check();
    });
  })()`, 15_000);
  await cdp.evaluate(`new Promise((resolve, reject) => {
    const id = ${JSON.stringify(active.terminalId)};
    const socket = new WebSocket(location.origin.replace(/^http/, "ws") + "/ws/terminal/" + id);
    window.__polythProfileTerminal = socket;
    const timer = setTimeout(() => reject(new Error("terminal did not reattach after reload")), 10000);
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "attached") {
        clearTimeout(timer);
        resolve(true);
      }
    };
    socket.onerror = () => reject(new Error("terminal reattach failed"));
  })`, 15_000);
  report.states.push(await sampleState("active-session"));

  const capture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  await writeFile(screenshotPath, Buffer.from(capture.data, "base64"));

  const peakStarted = await cdp.evaluate(`(() => {
    const socket = window.__polythProfileTerminal;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("profile terminal socket is not open");
    const command = "node -e 'const crypto=require(\\\"node:crypto\\\");const end=Date.now()+${sampleMs + 3_000};let n=0;while(Date.now()<end){crypto.createHash(\\\"sha256\\\").update(String(n++)).digest();if(n%5000===0)process.stdout.write(\\\"LOAD \\\"+n+\\\"\\\\r\\\\n\\\")}console.log(\\\"PEAK_DONE\\\",n)'\\n";
    socket.send(JSON.stringify({ type: "data", data: command }));
    window.__polythProfileUiLoad = setInterval(() => {
      document.querySelectorAll("button, input, [role]").length;
      window.dispatchEvent(new Event("resize"));
    }, 250);
    return true;
  })()`);
  assert.equal(peakStarted, true);
  report.states.push(await sampleState("peak-load"));
  await cdp.evaluate(`clearInterval(window.__polythProfileUiLoad)`);

  report.psSnapshot = (await exec("ps", [
    "-eo", "pid,ppid,pcpu,pmem,rss,vsz,stat,etime,args", "--sort=pid",
  ])).stdout;
  const info = await cdp.evaluate(`window.polythDesktop.getInfo()`);
  assert.equal(info.opencodeVersion, "1.18.22");
  assert.equal(info.packaged, true);
  assert.equal(Boolean(info.lowResourceMode), profileMode === "low-resource");
  report.checks.desktopInfo = info;
  report.checks.noSystemOpenCodePath = !report.psSnapshot.includes(`${process.env.HOME}/.opencode/bin/opencode`);

  const quitAt = performance.now();
  await cdp.evaluate(`window.polythDesktop.quit()`);
  cdp.socket.close();
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  assert.notEqual(child.exitCode, null, "Desktop app did not quit");
  assert.equal(child.exitCode, 0, "Desktop app did not exit cleanly");
  report.startup.shutdownMs = round(performance.now() - quitAt);
  const desktopLog = await readDesktopLog();
  assert.match(desktopLog, /Polyth server stopped/);
  report.checks.gracefulShutdown = true;
} catch (error) {
  failure = error;
  report.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
} finally {
  terminalSocket?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && Date.now() < deadline) await delay(100);
  if (child.exitCode === null) child.kill("SIGKILL");
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  report.appOutput = appOutput.join("");
  report.desktopLog = await readDesktopLog();
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (failure) throw failure;
console.log(JSON.stringify({
  ok: true,
  outputPath,
  screenshotPath,
  profileMode,
  startup: report.startup,
  totals: Object.fromEntries(report.states.map((state) => [state.name, state.total])),
}, null, 2));
