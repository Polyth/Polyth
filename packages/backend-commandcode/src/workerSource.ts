export const COMMANDCODE_WORKER_SOURCE = String.raw`import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { readFile, rm } from "node:fs/promises";

const command = process.env.POLYTH_COMMANDCODE_BIN;
const bridgePath = process.env.POLYTH_COMMANDCODE_BRIDGE_PATH;
if (!command || !bridgePath) process.exit(64);

const MAX_LINE = 8 * 1024 * 1024;
const MAX_CONTROL_LINE = 64 * 1024;
const MAX_STDERR = 64 * 1024;
let input = Buffer.alloc(0);
let active = null;

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const response = (id, success, data, error, code) => send({
  type: "response",
  id,
  success,
  ...(data !== undefined ? { data } : {}),
  ...(error ? { error } : {}),
  ...(code ? { code } : {}),
});
const safeError = (value) => String(value || "Command Code failed").replace(/[\\r\\n]+/g, " ").slice(0, 500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runtimeRejected = (message) => Object.assign(new Error(message), { code: "runtime-rejected" });

const readNativeSessionId = async (path) => {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return typeof value?.nativeSessionId === "string" && value.nativeSessionId ? value.nativeSessionId : undefined;
  } catch {
    return undefined;
  }
};

const waitForNativeReceipt = async (path, child, expected) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const id = await readNativeSessionId(path);
    if (id) {
      if (expected && id !== expected) throw new Error("Command Code resumed a different native session");
      return id;
    }
    if (child.exitCode !== null || child.signalCode) throw new Error("Command Code exited before native session admission");
    await sleep(20);
  }
  throw new Error("Command Code did not expose a native session receipt before admission timeout");
};

const parseOutput = (turn, chunk) => {
  turn.stdout = Buffer.concat([turn.stdout, chunk]);
  while (true) {
    const end = turn.stdout.indexOf(10);
    if (end < 0) break;
    if (end > MAX_LINE) throw new Error("Command Code emitted an oversized NDJSON record");
    const raw = turn.stdout.subarray(0, end);
    turn.stdout = turn.stdout.subarray(end + 1);
    const line = raw.at(-1) === 13 ? raw.subarray(0, -1) : raw;
    if (!line.length) continue;
    let parsed;
    try { parsed = JSON.parse(line.toString("utf8")); }
    catch { throw new Error("Command Code emitted malformed NDJSON"); }
    send({ type: "commandcode-record", operationId: turn.operationId, record: parsed });
  }
  if (turn.stdout.length > MAX_LINE) throw new Error("Command Code emitted an oversized partial NDJSON record");
};

const controlDescriptor = async (turn) => {
  let value;
  try { value = JSON.parse(await readFile(turn.controlPath, "utf8")); }
  catch { throw runtimeRejected("Command Code native steering bridge is unavailable"); }
  const port = Number(value?.port);
  if (value?.version !== 1 || value?.host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw runtimeRejected("Command Code native steering bridge is invalid");
  }
  return { port };
};

const deliverQueuedMessage = async (turn, content, deliverAs) => {
  if (!content.trim() || Buffer.byteLength(content, "utf8") > 48 * 1024) {
    throw runtimeRejected("Command Code steering message is invalid");
  }
  const { port } = await controlDescriptor(turn);
  const id = randomUUID();
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(runtimeRejected("Command Code native steering bridge timed out")), 5_000);
    timer.unref?.();
    socket.once("connect", () => {
      socket.write(JSON.stringify({
        id,
        token: turn.controlToken,
        type: "queue",
        content,
        deliverAs,
      }) + "\\n");
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_CONTROL_LINE) {
        finish(runtimeRejected("Command Code native steering response is too large"));
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      let value;
      try { value = JSON.parse(bytes.subarray(0, end).toString("utf8")); }
      catch { finish(runtimeRejected("Command Code native steering response is malformed")); return; }
      if (value?.id !== id || value?.ok !== true) {
        finish(runtimeRejected("Command Code rejected the steering message"));
        return;
      }
      finish();
    });
    socket.once("error", () => finish(runtimeRejected("Command Code native steering bridge is unavailable")));
    socket.once("close", () => {
      if (!settled) finish(runtimeRejected("Command Code native steering bridge closed before acknowledgement"));
    });
  });
};

const startTurn = async (message) => {
  if (active) throw Object.assign(new Error("Command Code is already processing a turn"), { code: "busy" });
  const args = ["-p", "--output-format", "json", "--skip-onboarding", "--no-auto-update", "--mod", bridgePath];
  if (message.nativeSessionId) args.push("--resume", message.nativeSessionId);
  if (message.model) args.push("--model", message.model);
  if (message.effort) args.push("--effort", message.effort);
  if (message.permissionMode) args.push("--permission-mode", message.permissionMode);
  const controlPath = String(message.bindingPath) + ".control." + randomUUID() + ".json";
  const controlToken = randomUUID() + randomUUID();
  await rm(controlPath, { force: true }).catch(() => undefined);
  const env = {
    ...process.env,
    POLYTH_COMMANDCODE_BINDING_FILE: message.bindingPath,
    POLYTH_COMMANDCODE_TITLE: message.title || "",
    POLYTH_COMMANDCODE_OPERATION_ID: message.operationId,
    POLYTH_COMMANDCODE_CONTROL_FILE: controlPath,
    POLYTH_COMMANDCODE_CONTROL_TOKEN: controlToken,
  };
  const child = spawn(command, args, {
    cwd: message.cwd,
    env,
    windowsHide: true,
    shell: process.platform === "win32" && /\\.(?:cmd|bat)$/i.test(command),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const turn = {
    child,
    operationId: message.operationId,
    stdout: Buffer.alloc(0),
    stderr: "",
    controlPath,
    controlToken,
    closed: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
  };
  active = turn;
  send({ type: "turn-spawned", operationId: turn.operationId });
  child.stdout.on("data", (chunk) => {
    try { parseOutput(turn, chunk); }
    catch (error) {
      send({ type: "protocol-error", operationId: turn.operationId, error: safeError(error) });
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk) => {
    turn.stderr = (turn.stderr + chunk.toString("utf8")).slice(-MAX_STDERR);
  });
  child.once("error", (error) => send({ type: "process-error", operationId: turn.operationId, error: safeError(error) }));
  child.once("close", (code, signal) => {
    void rm(controlPath, { force: true }).catch(() => undefined);
    send({ type: "turn-exit", operationId: turn.operationId, code, signal, stderr: safeError(turn.stderr) });
    if (active === turn) active = null;
  });
  child.stdin.end(String(message.text || ""));
  try {
    const nativeSessionId = await waitForNativeReceipt(message.bindingPath, child, message.nativeSessionId);
    return { nativeSessionId };
  } catch (error) {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "outcome-unknown" });
  }
};

const handle = async (message) => {
  const id = typeof message?.id === "string" ? message.id : "";
  if (!id || typeof message?.type !== "string") return;
  try {
    if (message.type === "ping") return response(id, true, { ok: true });
    if (message.type === "start_turn") return response(id, true, await startTurn(message));
    if (message.type === "steer") {
      const turn = active;
      if (!turn) throw runtimeRejected("Command Code has no active turn to steer");
      await deliverQueuedMessage(turn, String(message.text || ""), "steer");
      return response(id, true, {});
    }
    if (message.type === "abort") {
      const turn = active;
      if (!turn) return response(id, true, {});
      if (turn.child.exitCode === null && !turn.child.signalCode) turn.child.kill("SIGTERM");
      await turn.closed;
      return response(id, true, {});
    }
    if (message.type === "shutdown") {
      if (active?.child && active.child.exitCode === null && !active.child.signalCode) active.child.kill("SIGTERM");
      if (active) await active.closed;
      response(id, true, {});
      process.exit(0);
    }
    throw Object.assign(new Error("unsupported worker request"), { code: "unsupported" });
  } catch (error) {
    const rawCode = error && typeof error === "object" ? error.code : undefined;
    const code = rawCode === "busy" || rawCode === "unsupported" || rawCode === "runtime-rejected"
      ? rawCode
      : "outcome-unknown";
    return response(id, false, undefined, safeError(error), code);
  }
};

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const end = input.indexOf(10);
    if (end < 0) break;
    if (end > MAX_LINE) process.exit(65);
    const line = input.subarray(0, end);
    input = input.subarray(end + 1);
    if (!line.length) continue;
    try { void handle(JSON.parse(line.toString("utf8"))); }
    catch { process.exit(65); }
  }
  if (input.length > MAX_LINE) process.exit(65);
});
`;
