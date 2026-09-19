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
let stopTimer;
let killTimer;

const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const fail = (message) => send({ event: "polyth_error", polyth_error: { message } });
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
const spawnNative = (args, nextMode, reinitializing) => {
  initialized = false;
  suppressNativeOutput = false;
  mode = nextMode;
  buffer = "";
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
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
  child.stderr.resume();
  child.once("error", () => fail("Antigravity CLI could not be started by its owned worker"));
  child.once("close", () => {
    if (buffer) forwardLine(buffer, reinitializing);
    buffer = "";
    clearStopTimers();
    if (stopping) process.exit(0);
    if (!switching) {
      fail("Antigravity CLI disconnected from its owned worker");
      return;
    }
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
  });
};
const replaceNative = () => {
  if (!native || switching) return;
  switching = true;
  suppressNativeOutput = true;
  native.stdin?.end();
  stopTimer = setTimeout(() => native?.kill("SIGTERM"), 1000);
  killTimer = setTimeout(() => native?.kill("SIGKILL"), 3000);
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
