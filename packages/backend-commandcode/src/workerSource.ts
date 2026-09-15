export const COMMANDCODE_WORKER_SOURCE = String.raw`import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { readFile, rm } from "node:fs/promises";

const command = process.env.POLYTH_COMMANDCODE_BIN;
const bridgePath = process.env.POLYTH_COMMANDCODE_BRIDGE_PATH;
if (!command || !bridgePath) process.exit(64);

const MAX_LINE = 8 * 1024 * 1024;
const MAX_CONTROL_LINE = 64 * 1024;
const MAX_STDERR = 64 * 1024;
const AGENT_TOOLS_PATH = "/internal/agent-tools";
const INVOCABLE_TOOL_ERROR_CODES = new Set(["permission-required", "forbidden", "tool-failed"]);
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
const safeError = (value) => String(value || "Command Code failed")
  .replace(/((?:authorization|cookie|credential|password|secret|token|api[-_ ]?key)\s*[=:]\s*)\S+/gi, "$1[redacted]")
  .replace(/[\u0000-\u001f\u007f]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runtimeRejected = (message) => Object.assign(new Error(message), { code: "runtime-rejected" });
const outcomeUnknown = (message) => Object.assign(new Error(message), { code: "outcome-unknown" });
const windowsShim = (value) => process.platform === "win32" && /\\.(?:cmd|bat)$/i.test(value);

const readTurnAdmission = async (path, operationId, mutationKind = "turn-submit") => {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const nativeSessionId = typeof value?.nativeSessionId === "string" && value.nativeSessionId
      ? value.nativeSessionId
      : undefined;
    if (!nativeSessionId || !operationId) return undefined;
    const accepted = Array.isArray(value?.acceptedMutations)
      ? value.acceptedMutations.some((entry) => entry?.operationId === operationId && entry?.mutationKind === mutationKind)
      : mutationKind === "turn-submit" && Array.isArray(value?.acceptedOperations)
        ? value.acceptedOperations.includes(operationId)
        : false;
    return accepted ? { nativeSessionId } : undefined;
  } catch {
    return undefined;
  }
};

const waitForTurnAdmission = async (path, turn, expected, operationId, mutationKind = "turn-submit") => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const admission = await readTurnAdmission(path, operationId, mutationKind);
    if (admission) {
      if (expected && admission.nativeSessionId !== expected) {
        throw new Error("Command Code resumed a different native session");
      }
      return admission.nativeSessionId;
    }
    if (turn.child.exitCode !== null || turn.child.signalCode) {
      throw new Error("Command Code exited before native operation admission");
    }
    await sleep(20);
  }
  throw new Error("Command Code did not persist the exact native operation receipt before timeout");
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
    const eventType = parsed?.type === "event" && typeof parsed?.event?.type === "string"
      ? parsed.event.type
      : undefined;
    if (eventType === "run_start" || eventType === "turn_start" || parsed?.type === "result") {
      turn.runObserved = true;
    }
    send({ type: "commandcode-record", operationId: turn.operationId, record: parsed });
  }
  if (turn.stdout.length > MAX_LINE) throw new Error("Command Code emitted an oversized partial NDJSON record");
};

const controlDescriptor = async (turn) => {
  let value;
  try { value = JSON.parse(await readFile(turn.controlPath, "utf8")); }
  catch { throw runtimeRejected("Command Code native control bridge is unavailable"); }
  const port = Number(value?.port);
  if (value?.version !== 1 || value?.host !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw runtimeRejected("Command Code native control bridge is invalid");
  }
  return { port };
};

const deliverControl = async (turn, request, labels) => {
  const { port } = await controlDescriptor(turn);
  const id = randomUUID();
  await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let bytes = Buffer.alloc(0);
    let settled = false;
    let sent = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve();
    };
    timer = setTimeout(() => finish(sent
      ? outcomeUnknown(labels.ackTimeout)
      : runtimeRejected(labels.connectTimeout)), 5_000);
    timer.unref?.();
    socket.once("connect", () => {
      sent = true;
      try {
        socket.write(JSON.stringify({ id, token: turn.controlToken, ...request }) + "\\n");
      } catch {
        finish(outcomeUnknown(labels.writeUnknown));
      }
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_CONTROL_LINE) {
        finish(outcomeUnknown(labels.tooLarge));
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      let value;
      try { value = JSON.parse(bytes.subarray(0, end).toString("utf8")); }
      catch { finish(outcomeUnknown(labels.malformed)); return; }
      if (value?.id !== id) {
        finish(outcomeUnknown(labels.idMismatch));
        return;
      }
      if (value?.ok !== true) {
        finish(runtimeRejected(typeof value?.error === "string" && value.error ? value.error : labels.rejected));
        return;
      }
      finish();
    });
    socket.once("error", () => finish(sent
      ? outcomeUnknown(labels.connectionUnknown)
      : runtimeRejected(labels.unavailable)));
    socket.once("close", () => {
      if (!settled) finish(sent
        ? outcomeUnknown(labels.closedUnknown)
        : runtimeRejected(labels.unavailable));
    });
  });
};

const deliverQueuedMessage = async (turn, content, deliverAs, operationId) => {
  if (!operationId || !content.trim() || Buffer.byteLength(content, "utf8") > 48 * 1024) {
    throw runtimeRejected("Command Code steering message is invalid");
  }
  await deliverControl(turn, {
    type: "queue",
    operationId,
    content,
    deliverAs,
  }, {
    ackTimeout: "Command Code steering acknowledgement timed out",
    connectTimeout: "Command Code native steering bridge timed out",
    writeUnknown: "Command Code steering request write outcome is unknown",
    tooLarge: "Command Code native steering response is too large",
    malformed: "Command Code native steering response is malformed",
    idMismatch: "Command Code native steering response id does not match",
    rejected: "Command Code rejected the steering message",
    connectionUnknown: "Command Code steering connection failed after submission",
    unavailable: "Command Code native steering bridge is unavailable",
    closedUnknown: "Command Code native steering bridge closed before acknowledgement",
  });
};

const deliverQuestionAnswer = async (turn, requestId, answer, operationId) => {
  if (!operationId || !requestId || !answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw runtimeRejected("Command Code question response is invalid");
  }
  const encoded = JSON.stringify(answer);
  if (Buffer.byteLength(encoded, "utf8") > 48 * 1024) {
    throw runtimeRejected("Command Code question response is too large");
  }
  await deliverControl(turn, {
    type: "answer_question",
    operationId,
    requestId,
    answer,
  }, {
    ackTimeout: "Command Code question acknowledgement timed out",
    connectTimeout: "Command Code question bridge timed out",
    writeUnknown: "Command Code question response write outcome is unknown",
    tooLarge: "Command Code question acknowledgement is too large",
    malformed: "Command Code question acknowledgement is malformed",
    idMismatch: "Command Code question acknowledgement id does not match",
    rejected: "Command Code rejected the question response",
    connectionUnknown: "Command Code question connection failed after submission",
    unavailable: "Command Code question bridge is unavailable",
    closedUnknown: "Command Code question bridge closed before acknowledgement",
  });
};

const validToolBridge = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  const rawCapabilityIds = Array.isArray(value.capabilityIds) ? value.capabilityIds : undefined;
  if (!url || url.length > 8192 || !token || token.length > 8192 || !rawCapabilityIds
    || rawCapabilityIds.length === 0 || rawCapabilityIds.length > 256) return undefined;
  const capabilityIds = rawCapabilityIds.map((item) => typeof item === "string" ? item.trim() : "");
  if (capabilityIds.some((item) => !item || item.length > 512) || new Set(capabilityIds).size !== capabilityIds.length) {
    return undefined;
  }
  let target;
  try { target = new URL(url); } catch { return undefined; }
  const host = target.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if ((target.protocol !== "http:" && target.protocol !== "https:") || !loopback || target.pathname !== AGENT_TOOLS_PATH) {
    return undefined;
  }
  return { url: target.toString(), token, capabilityIds: new Set(capabilityIds) };
};

const toolErrorResult = (message) => ({
  content: [{ type: "text", text: safeError(message) || "Polyth tool failed" }],
  isError: true,
});

const responseProvesToolInvocable = (statusCode, parsed) => {
  if (statusCode >= 200 && statusCode < 300) return true;
  const code = typeof parsed?.error?.code === "string" ? parsed.error.code : "";
  return INVOCABLE_TOOL_ERROR_CODES.has(code);
};

const invokeScopedTool = (turn, call, controller) => new Promise((resolve) => {
  const target = new URL(turn.toolBridge.url);
  const payload = JSON.stringify({ id: call.capabilityId, arguments: call.input ?? {} });
  let bytes = Buffer.alloc(0);
  let settled = false;
  const finish = (result, invocable = false) => {
    if (settled) return;
    settled = true;
    resolve({ invocable, result });
  };
  const request = (target.protocol === "https:" ? httpsRequest : httpRequest)({
    hostname: target.hostname,
    port: target.port || undefined,
    path: target.pathname + target.search,
    method: "POST",
    signal: controller.signal,
    headers: {
      authorization: "Bearer " + turn.toolBridge.token,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
  }, (res) => {
    const statusCode = res.statusCode ?? 500;
    res.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_LINE) {
        request.destroy();
        finish(toolErrorResult("Polyth tool response is too large"), statusCode >= 200 && statusCode < 300);
      }
    });
    res.on("end", () => {
      if (settled) return;
      let parsed;
      try { parsed = bytes.length ? JSON.parse(bytes.toString("utf8")) : {}; }
      catch { finish(toolErrorResult("Polyth tool bridge returned malformed JSON")); return; }
      const invocable = responseProvesToolInvocable(statusCode, parsed);
      if (statusCode >= 400) {
        finish(toolErrorResult(parsed?.error?.message ?? ("Polyth tool HTTP " + String(statusCode))), invocable);
        return;
      }
      finish({ content: [{ type: "text", text: String(parsed?.output ?? "") }] }, invocable);
    });
    res.on("error", (error) => finish(toolErrorResult(error)));
  });
  request.on("error", (error) => {
    if (controller.signal.aborted) finish(toolErrorResult("Polyth tool call aborted"));
    else finish(toolErrorResult(error));
  });
  try {
    request.write(payload);
    request.end();
  } catch (error) {
    finish(toolErrorResult(error));
  }
});

const attachToolRelay = (turn) => {
  if (!turn.toolBridge) return () => undefined;
  const requests = turn.child.stdio?.[3];
  const responses = turn.child.stdio?.[4];
  if (!requests || !responses) return () => undefined;
  let requestBytes = Buffer.alloc(0);
  let closed = false;
  const pending = new Map();
  const writeResponse = (value) => {
    if (closed) return;
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, "utf8") > MAX_LINE) {
      try { responses.write(JSON.stringify({ id: value?.id ?? "", result: toolErrorResult("Polyth tool response is too large") }) + "\\n"); }
      catch {}
      return;
    }
    try { responses.write(encoded + "\\n"); }
    catch { failRelay(); }
  };
  const failRelay = () => {
    if (closed) return;
    closed = true;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    try { responses.end(); } catch {}
  };
  const runCall = async (message) => {
    const id = typeof message?.id === "string" && message.id ? message.id : "";
    const capabilityId = typeof message?.capabilityId === "string" && message.capabilityId ? message.capabilityId : "";
    const toolName = typeof message?.name === "string" && message.name ? message.name : "";
    const callInput = message?.input && typeof message.input === "object" && !Array.isArray(message.input) ? message.input : {};
    if (!id || !capabilityId || !toolName || !turn.toolBridge.capabilityIds.has(capabilityId) || pending.has(id)) {
      writeResponse({ id, result: toolErrorResult("Invalid Polyth tool request") });
      return;
    }
    const controller = new AbortController();
    pending.set(id, controller);
    try {
      const outcome = await invokeScopedTool(turn, { capabilityId, input: callInput }, controller);
      if (outcome.invocable) send({
        type: "polyth-tool-invoked",
        operationId: turn.operationId,
        capabilityId,
        toolName,
      });
      writeResponse({ id, result: outcome.result });
    } finally {
      if (pending.get(id) === controller) pending.delete(id);
    }
  };
  requests.on("data", (chunk) => {
    requestBytes = Buffer.concat([requestBytes, chunk]);
    while (true) {
      const end = requestBytes.indexOf(10);
      if (end < 0) break;
      if (end > MAX_LINE) { failRelay(); return; }
      const raw = requestBytes.subarray(0, end);
      requestBytes = requestBytes.subarray(end + 1);
      if (!raw.length) continue;
      let message;
      try { message = JSON.parse(raw.toString("utf8")); }
      catch { failRelay(); return; }
      if (message?.type === "cancel") {
        const requestId = typeof message.requestId === "string" ? message.requestId : "";
        pending.get(requestId)?.abort();
        continue;
      }
      if (message?.type !== "call") {
        failRelay();
        return;
      }
      void runCall(message);
    }
    if (requestBytes.length > MAX_LINE) failRelay();
  });
  requests.on("error", failRelay);
  requests.on("close", failRelay);
  responses.on("error", failRelay);
  return failRelay;
};

const preAdmissionMessage = (stderr, controlAction) => {
  const detail = safeError(stderr);
  if (/untrusted|workspace.{0,20}trust|trust.{0,20}workspace/i.test(detail)) {
    return "Command Code requires this workspace to be trusted. Open Command Code in this workspace, approve trust, then retry in Polyth";
  }
  if (/not authenticated|sign.?in|log.?in|authentication required/i.test(detail)) {
    return "Command Code authentication is required. Sign in with Command Code, then retry in Polyth";
  }
  const operation = controlAction === "compact" ? "compaction" : "turn";
  return detail
    ? "Command Code rejected the " + operation + " before native admission: " + detail
    : "Command Code rejected the " + operation + " before native admission";
};

const startTurn = async (message) => {
  if (active) throw Object.assign(new Error("Command Code is already processing a turn"), { code: "busy" });
  const compactControl = message.controlAction === "compact";
  if (message.controlAction && !compactControl) throw runtimeRejected("Command Code received an unsupported native session control");
  if (compactControl && !message.nativeSessionId) throw runtimeRejected("Command Code compaction requires an exact native session id");
  const toolBridge = compactControl ? undefined : validToolBridge(message.toolBridge);
  if (!compactControl && message.toolBridge && !toolBridge) throw runtimeRejected("Command Code received an invalid Polyth tool bridge");
  const args = [
    "-p",
    "--output-format", "json",
    "--skip-onboarding",
    "--no-auto-update",
    "--tools-enable", "todo_write,ask_user_question",
    "--mod", bridgePath,
  ];
  if (!compactControl && typeof message.capabilityModPath === "string" && message.capabilityModPath.trim()) {
    args.push("--mod", message.capabilityModPath);
  }
  if (!compactControl && typeof message.toolModPath === "string" && message.toolModPath.trim() && toolBridge) {
    args.push("--mod", message.toolModPath);
  }
  if (!compactControl && Array.isArray(message.skillRoots)) {
    for (const root of message.skillRoots.slice(0, 64)) {
      if (typeof root === "string" && root.trim()) args.push("--skill", root);
    }
  }
  if (message.nativeSessionId) args.push("--resume", message.nativeSessionId);
  if (!compactControl && message.model) args.push("--model", message.model);
  if (!compactControl && message.effort) args.push("--effort", message.effort);
  const permissionMode = !compactControl && message.permissionMode === "auto-accept" ? "auto-accept" : "dont-ask";
  args.push("--permission-mode", permissionMode);
  const controlPath = String(message.bindingPath) + ".control." + randomUUID() + ".json";
  const controlToken = randomUUID() + randomUUID();
  await rm(controlPath, { force: true }).catch(() => undefined);
  const env = {
    ...process.env,
    POLYTH_COMMANDCODE_BINDING_FILE: message.bindingPath,
    // Polyth owns the canonical title. Every exact resume receives the latest
    // title seen by the session service, so manual renames converge natively
    // without transcript/config scraping.
    POLYTH_COMMANDCODE_TITLE: compactControl ? "" : message.title || "",
    POLYTH_COMMANDCODE_OPERATION_ID: message.operationId,
    POLYTH_COMMANDCODE_CONTROL_FILE: controlPath,
    POLYTH_COMMANDCODE_CONTROL_TOKEN: controlToken,
    POLYTH_COMMANDCODE_CONTROL_ACTION: compactControl ? "compact" : "",
  };
  const child = spawn(command, args, {
    cwd: message.cwd,
    env,
    windowsHide: true,
    shell: windowsShim(command),
    // fd3/fd4 are a private model-facing relay. The scoped Polyth bearer stays
    // only in this worker's memory and never enters Command Code env or disk.
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const turn = {
    child,
    toolBridge,
    operationId: message.operationId,
    bindingPath: message.bindingPath,
    mutationKind: compactControl ? "session-compact" : "turn-submit",
    controlAction: compactControl ? "compact" : undefined,
    stdout: Buffer.alloc(0),
    stderr: "",
    runObserved: false,
    controlPath,
    controlToken,
    closeToolRelay: () => undefined,
    closed: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
  };
  active = turn;
  turn.closeToolRelay = attachToolRelay(turn);
  send({ type: "turn-spawned", operationId: turn.operationId, ...(turn.controlAction ? { controlAction: turn.controlAction } : {}) });
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
  child.once("error", (error) => {
    turn.closeToolRelay();
    send({ type: "process-error", operationId: turn.operationId, error: safeError(error) });
  });
  child.once("close", (code, signal) => {
    turn.closeToolRelay();
    void rm(controlPath, { force: true }).catch(() => undefined);
    if (active === turn) active = null;
    void readTurnAdmission(turn.bindingPath, turn.operationId, turn.mutationKind).then((admission) => {
      // A process that died before run_start AND before the exact admission
      // receipt is a proven non-application. Do not manufacture a terminal
      // canonical turn event for it. Once either proof exists, the outcome can
      // no longer be silently downgraded to rejection.
      if (admission || turn.runObserved) {
        send({
          type: "turn-exit",
          operationId: turn.operationId,
          code,
          signal,
          stderr: safeError(turn.stderr),
          ...(turn.controlAction ? { controlAction: turn.controlAction } : {}),
        });
      }
    });
  });
  const submittedText = compactControl
    ? "__POLYTH_COMMANDCODE_COMPACT__:" + String(message.operationId || "")
    : String(message.text || "");
  child.stdin.end(submittedText);
  try {
    const nativeSessionId = await waitForTurnAdmission(
      message.bindingPath,
      turn,
      message.nativeSessionId,
      message.operationId,
      turn.mutationKind,
    );
    return { nativeSessionId };
  } catch (error) {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
    await turn.closed.catch(() => undefined);
    const durableAdmission = await readTurnAdmission(message.bindingPath, message.operationId, turn.mutationKind);
    if (!turn.runObserved && !durableAdmission) {
      throw runtimeRejected(preAdmissionMessage(turn.stderr, turn.controlAction));
    }
    throw outcomeUnknown(error instanceof Error ? error.message : String(error));
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
      if (!turn || turn.controlAction) throw runtimeRejected("Command Code has no active turn to steer");
      await deliverQueuedMessage(turn, String(message.text || ""), "steer", String(message.operationId || ""));
      return response(id, true, {});
    }
    if (message.type === "answer_question") {
      const turn = active;
      if (!turn || turn.controlAction) throw runtimeRejected("Command Code has no active question to answer");
      await deliverQuestionAnswer(
        turn,
        String(message.requestId || ""),
        message.answer,
        String(message.operationId || ""),
      );
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
