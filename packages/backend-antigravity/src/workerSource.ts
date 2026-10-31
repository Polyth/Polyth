/**
 * Stable supervised facade for Antigravity. The native CLI is a child of this
 * process so Polyth can replace the CLI leg — on an explicit launch-mode
 * change, after a stop, or after the leg exits — while retaining one durable
 * process authority for the canonical session. Polyth Auto-Approve itself stays
 * in the permission bridge.
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
let probePending = false;
let probeInit;
let probeTimer;
let probeLeg = false;
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
const writePendingInput = () => {
  if (!pending || !native?.stdin?.writable) return;
  const input = pending.input;
  pending = undefined;
  native.stdin.write(JSON.stringify(input) + "\n", (error) => {
    if (error) fail("Antigravity input pipe rejected a Polyth turn");
  });
};
const writeUser = () => {
  if (initialized) writePendingInput();
};
// Newer CLIs emit their own init frame about two seconds after launch. Wait a
// grace period for it before falling back to the CLI 1.2.10 deferred-init
// probe, so the normal path keeps one healthy native leg instead of booting a
// throwaway leg that is already exiting. The override exists for tests.
const PROBE_DELAY_MS = Number.parseInt(process.env.POLYTH_ANTIGRAVITY_PROBE_DELAY_MS || "", 10) > 0
  ? Number.parseInt(process.env.POLYTH_ANTIGRAVITY_PROBE_DELAY_MS, 10)
  : 4000;
const cancelProbe = () => {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = undefined;
};
// A content-less user frame is a no-model probe: the CLI returns init plus a
// zero-turn error, then exits this native leg. The worker stays alive and
// relaunches the recorded conversation with the first real Polyth prompt.
const probeNative = () => {
  probeTimer = undefined;
  if (!native?.stdin?.writable || initialized) return;
  // A real prompt already waiting is a stronger init trigger than the empty
  // probe. Deliver it so the turn is not stranded on a throwaway leg.
  if (pending) { writePendingInput(); return; }
  probePending = true;
  probeLeg = true;
  native.stdin.write(JSON.stringify({ event: "user", message: {} }) + "\n", (error) => {
    if (error && !initialized) {
      probePending = false;
      probeLeg = false;
      probeInit = undefined;
      fail("Antigravity native process rejected its initialization probe");
    }
  });
};
const flushProbeInit = () => {
  if (!probePending || !probeInit) return;
  const frame = probeInit;
  probePending = false;
  probeInit = undefined;
  process.stdout.write(JSON.stringify(frame) + "\n");
};
const isProbeResult = (frame) => frame?.event === "result"
  && frame.result?.num_turns === 0
  && typeof frame.result?.error === "string"
  && /no content|empty prompt/i.test(frame.result.error);
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
    cancelProbe();
    if (probePending) {
      probeInit = frame;
      return;
    }
    if (reinitializing) send({ event: "polyth_reinit", polyth_reinit: frame });
    else process.stdout.write(line + "\n");
    writeUser();
    return;
  }
  // Do not let the probe's zero-turn result race the first real prompt. Hold
  // its init until the result (or native close) has been consumed, then expose
  // only the initialization frame to the runtime.
  if (probePending) {
    if (frame?.event === "step_update") return;
    if (frame?.event === "result") {
      flushProbeInit();
      probePending = false;
      probeInit = undefined;
      return;
    }
    flushProbeInit();
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
const spawnNative = (args, nextMode, reinitializing, deliverPending = false) => {
  initialized = false;
  suppressNativeOutput = false;
  mode = nextMode;
  buffer = "";
  errorBuffer = "";
  probePending = false;
  probeInit = undefined;
  cancelProbe();
  probeLeg = false;
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
    if (probePending) {
      flushProbeInit();
      probePending = false;
      probeInit = undefined;
    }
    clearStopTimers();
    cancelProbe();
    native = undefined;
    initialized = false;
    if (stopping) process.exit(0);
    if (!switching) {
      // The native leg is gone, but this worker still is the authority-owned
      // containment boundary. Prove the leg's own group released, then keep the
      // worker so the next Polyth turn relaunches the recorded conversation
      // instead of stranding the canonical session on a runtime that can never
      // answer again. No proof escalates to the whole owned tree as before.
      void proveNativeTreeReleased(pid).then(
        () => send({ event: "polyth_native_closed" }),
        () => fail("Antigravity native process tree release was not proved"),
      );
      return;
    }
    void proveNativeTreeReleased(pid).then(() => {
      const next = pending;
      switching = false;
      suppressNativeOutput = false;
      // An explicit stop has no pending turn: report the proved release and
      // wait for the next turn to relaunch.
      if (!next) {
        send({ event: "polyth_released" });
        return;
      }
      if (!validArgs(next.args)) {
        fail("Antigravity native replacement lost its pending turn");
        return;
      }
      const conversationAt = next.args.indexOf("--conversation");
      if (!nativeId || conversationAt < 0 || next.args[conversationAt + 1] !== nativeId) {
        fail("Antigravity native replacement did not pin the native conversation");
        return;
      }
      spawnNative(next.args, next.mode, true, true);
    }, () => fail("Antigravity native process tree release was not proved"));
  });
  if (deliverPending) writePendingInput();
  else if (!reinitializing) probeTimer = setTimeout(probeNative, PROBE_DELAY_MS);
};
const stopNative = () => {
  // A stop abandons the pending turn; it must never reach a relaunched leg.
  pending = undefined;
  initialized = false;
  cancelProbe();
  if (!native) {
    send({ event: "polyth_released" });
    return;
  }
  if (switching) return; // a release proof is already in flight
  switching = true;
  suppressNativeOutput = true;
  const pid = native.pid;
  try { signalTree(pid, "SIGTERM"); } catch { fail("Antigravity native process tree could not be stopped"); return; }
  killTimer = setTimeout(() => {
    try { signalTree(pid, "SIGKILL"); } catch { fail("Antigravity native process tree could not be killed"); }
  }, 1000);
};
const replaceNative = () => {
  if (!native || switching) return;
  switching = true;
  suppressNativeOutput = true;
  cancelProbe();
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
  if (message?.event === "polyth_stop") {
    if (initialLaunch) {
      fail("Antigravity worker received a stop before its native launch");
      return;
    }
    stopNative();
    return;
  }
  if (message?.event === "polyth_user") {
    if (initialLaunch || pending || !message.input || !validArgs(message.args)) {
      fail("Antigravity worker received an invalid or concurrent turn");
      return;
    }
    pending = message;
    // A stopped, exited or disposable probe leg is relaunched on the recorded
    // conversation; the replacement init frame carries the pending turn. A
    // real prompt must never be written into the probe leg, which is already
    // exiting.
    if (!native) {
      const conversationAt = message.args.indexOf("--conversation");
      if (!nativeId || conversationAt < 0 || message.args[conversationAt + 1] !== nativeId) {
        pending = undefined;
        fail("Antigravity relaunch did not pin the native conversation");
        return;
      }
      spawnNative(message.args, message.mode, true, true);
      return;
    }
    if (probeLeg || message.mode !== mode) replaceNative();
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
