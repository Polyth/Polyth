/**
 * Stable supervised facade for Antigravity. The native CLI is a child of this
 * process so Polyth can replace only the idle CLI leg when Auto-Approve changes
 * while retaining one durable process authority for the canonical session.
 */
export const ANTIGRAVITY_WORKER_SOURCE = String.raw`import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

let command = "";
let native;
let nativeId = "";
let mode = "";
let initialized = false;
let initialLaunch = true;
let stopping = false;
let switching = false;
let suppressNativeOutput = false;
let pending;
let buffer = "";
let errorBuffer = "";
let stopTimer;
let killTimer;

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const fail = (message) => send({ event: "polyth_error", polyth_error: { message } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const groupAlive = (pid) => {
  if (process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
};
const signalTree = (pid, signal) => {
  try {
    if (process.platform === "win32") native?.kill(signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};
const taskkill = (pid) => new Promise((resolve, reject) => {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore", windowsHide: true, shell: false,
  });
  const timer = setTimeout(() => { killer.kill(); reject(new Error("taskkill timed out")); }, 5000);
  killer.once("error", (error) => { clearTimeout(timer); reject(error); });
  killer.once("exit", (code) => {
    clearTimeout(timer);
    if (code === 0 || code === 128) resolve();
    else reject(new Error("taskkill did not release the native tree"));
  });
});
const proveNativeTreeReleased = async (pid) => {
  if (!pid) throw new Error("native process identity is missing");
  if (process.platform === "win32") { await taskkill(pid); return; }
  if (!groupAlive(pid)) return;
  signalTree(pid, "SIGTERM");
  const gentleDeadline = Date.now() + 1500;
  while (Date.now() < gentleDeadline) {
    if (!groupAlive(pid)) return;
    await sleep(25);
  }
  signalTree(pid, "SIGKILL");
  const hardDeadline = Date.now() + 3500;
  while (Date.now() < hardDeadline) {
    if (!groupAlive(pid)) return;
    await sleep(25);
  }
  throw new Error("native process tree did not terminate");
};
const clearStopTimers = () => {
  if (stopTimer) clearTimeout(stopTimer);
  if (killTimer) clearTimeout(killTimer);
  stopTimer = undefined;
  killTimer = undefined;
};
const validArgs = (args) => Array.isArray(args) && args.every((value) => typeof value === "string");
const writeUser = () => {
  if (!pending || !native?.stdin?.writable || !initialized) return;
  const input = pending.input;
  pending = undefined;
  native.stdin.write(JSON.stringify(input) + "\n", (error) => {
    if (error) fail("Antigravity input pipe rejected a Polyth turn");
  });
};
const forwardLine = (line, reinitializing) => {
  if (!line.trim()) return;
  let frame;
  try { frame = JSON.parse(line); } catch {
    if (!suppressNativeOutput) process.stdout.write(line + "\n");
    return;
  }
  if (frame?.event === "init") {
    initialized = true;
    nativeId = typeof frame.conversation_id === "string" ? frame.conversation_id : "";
    if (reinitializing) send({ event: "polyth_reinit", polyth_reinit: frame });
    else process.stdout.write(line + "\n");
    writeUser();
    return;
  }
  if (!suppressNativeOutput) process.stdout.write(line + "\n");
};
const forwardErrorLine = (line) => {
  if (suppressNativeOutput || !line.startsWith("AGY_ERROR:")) return;
  let parsed;
  try { parsed = JSON.parse(line.slice("AGY_ERROR:".length).trim()); } catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const safe = {};
  for (const key of [
    "status", "code", "http_status", "grpc_code", "retryable", "message", "details",
    "retryAfter", "retryAfterSec", "retry_after", "retryDelay", "retry_delay",
    "resetAt", "reset_at", "resetsAt", "resets_at", "resetTime", "reset_time",
  ]) {
    const value = parsed[key];
    if (typeof value === "boolean" || typeof value === "number") safe[key] = value;
    else if (typeof value === "string" && value.length <= 8192) safe[key] = value;
  }
  if (Object.keys(safe).length) send({ event: "polyth_native_error", polyth_native_error: safe });
};
const spawnNative = (args, nextMode, reinitializing) => {
  initialized = false;
  suppressNativeOutput = false;
  mode = nextMode;
  buffer = "";
  errorBuffer = "";
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  native = child;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      forwardLine(line, reinitializing);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    errorBuffer += chunk;
    let newline;
    while ((newline = errorBuffer.indexOf("\n")) >= 0) {
      const line = errorBuffer.slice(0, newline);
      errorBuffer = errorBuffer.slice(newline + 1);
      forwardErrorLine(line);
    }
    // Raw native diagnostics can contain credentials, auth URLs and prompts.
    // Retain only enough tail to recognize one bounded structured marker.
    if (errorBuffer.length > 64 * 1024) errorBuffer = "";
  });
  child.once("error", () => fail("Antigravity CLI could not be started by its owned worker"));
  const pid = child.pid;
  child.once("close", () => {
    if (buffer) forwardLine(buffer, reinitializing);
    buffer = "";
    if (errorBuffer) forwardErrorLine(errorBuffer);
    errorBuffer = "";
    clearStopTimers();
    if (stopping) process.exit(0);
    if (!switching) {
      fail("Antigravity CLI disconnected from its owned worker");
      return;
    }
    void proveNativeTreeReleased(pid).then(() => {
      const next = pending;
      switching = false;
      suppressNativeOutput = false;
      if (!next || !validArgs(next.args)) {
        fail("Antigravity permission-mode replacement lost its pending turn");
        return;
      }
      const conversationAt = next.args.indexOf("--conversation");
      if (!nativeId || conversationAt < 0 || next.args[conversationAt + 1] !== nativeId) {
        fail("Antigravity permission-mode replacement did not pin the native conversation");
        return;
      }
      spawnNative(next.args, next.mode, true);
    }, () => fail("Antigravity native process tree release was not proved"));
  });
};
const replaceNative = () => {
  if (!native || switching) return;
  switching = true;
  suppressNativeOutput = true;
  native.stdin?.end();
  const pid = native.pid;
  stopTimer = setTimeout(() => {
    try { signalTree(pid, "SIGTERM"); } catch { fail("Antigravity native process tree could not be stopped"); }
  }, 1000);
  killTimer = setTimeout(() => {
    try { signalTree(pid, "SIGKILL"); } catch { fail("Antigravity native process tree could not be killed"); }
  }, 3000);
};

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { fail("Antigravity worker received malformed control input"); return; }
  if (message?.event === "polyth_launch") {
    if (native || !validArgs(message.args) || typeof message.command !== "string" || !message.command) {
      fail("Antigravity worker received an invalid duplicate launch");
      return;
    }
    command = message.command;
    initialLaunch = false;
    spawnNative(message.args, message.mode, false);
    return;
  }
  if (message?.event === "polyth_user") {
    if (initialLaunch || pending || !message.input || !validArgs(message.args)) {
      fail("Antigravity worker received an invalid or concurrent turn");
      return;
    }
    pending = message;
    if (message.mode !== mode) replaceNative();
    else writeUser();
    return;
  }
  fail("Antigravity worker received an unsupported control event");
}).on("close", () => {
  stopping = true;
  if (!native || native.exitCode !== null || native.signalCode !== null) process.exit(0);
  native.kill("SIGTERM");
});

process.on("SIGTERM", () => {
  stopping = true;
  if (!native || native.exitCode !== null || native.signalCode !== null) process.exit(0);
  native.kill("SIGTERM");
  setTimeout(() => native?.kill("SIGKILL"), 1000).unref();
});
`;
