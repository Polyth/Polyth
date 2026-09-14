export const COMMANDCODE_BRIDGE_SOURCE = String.raw`import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:net";

const bindingPath = process.env.POLYTH_COMMANDCODE_BINDING_FILE?.trim();
const requestedTitle = process.env.POLYTH_COMMANDCODE_TITLE?.trim();
const requestedOperationId = process.env.POLYTH_COMMANDCODE_OPERATION_ID?.trim();
const controlPath = process.env.POLYTH_COMMANDCODE_CONTROL_FILE?.trim();
const controlToken = process.env.POLYTH_COMMANDCODE_CONTROL_TOKEN?.trim();
const MAX_CONTROL_BYTES = 64 * 1024;
let nativeSessionId = "";

const failClosed = (message) => {
  try { process.stderr.write("[polyth-commandcode] " + message + "\\n"); } catch {}
  process.exit(70);
};

const atomicJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + process.pid + ".tmp";
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
};

const persistBinding = async () => {
  if (!bindingPath) failClosed("binding file is missing");
  if (!requestedOperationId) failClosed("turn operation id is missing");
  if (!nativeSessionId) failClosed("Command Code did not expose a native session id before turn admission");
  let previous = {};
  try {
    const text = await readFile(bindingPath, "utf8");
    previous = JSON.parse(text);
  } catch {
    failClosed("binding file could not be read");
  }
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) failClosed("binding state is malformed");
  if (typeof previous.nativeSessionId === "string" && previous.nativeSessionId && previous.nativeSessionId !== nativeSessionId) {
    failClosed("native session identity changed unexpectedly");
  }
  const priorAccepted = Array.isArray(previous.acceptedOperations)
    ? previous.acceptedOperations.filter((value) => typeof value === "string" && value)
    : [];
  const acceptedOperations = priorAccepted.includes(requestedOperationId)
    ? priorAccepted
    : [...priorAccepted, requestedOperationId].slice(-64);
  const next = {
    ...previous,
    nativeSessionId,
    nativeBoundAt: Date.now(),
    acceptedOperations,
    updatedAt: Date.now(),
  };
  try {
    await atomicJson(bindingPath, next);
  } catch {
    failClosed("native session receipt could not be persisted");
  }
};

const startControlServer = async (cmd) => {
  if (!controlPath) failClosed("control file is missing");
  if (!controlToken) failClosed("control token is missing");
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    let handled = false;
    const reply = (id, ok, error) => {
      if (socket.destroyed) return;
      socket.end(JSON.stringify({ id, ok, ...(error ? { error } : {}) }) + "\\n");
    };
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_CONTROL_BYTES) {
        handled = true;
        reply("", false, "control request is too large");
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      handled = true;
      let request;
      try { request = JSON.parse(bytes.subarray(0, end).toString("utf8")); }
      catch { reply("", false, "invalid control request"); return; }
      const id = typeof request?.id === "string" ? request.id : "";
      if (!id || request?.token !== controlToken) { reply(id, false, "unauthorized control request"); return; }
      if (request?.type !== "queue") { reply(id, false, "unsupported control request"); return; }
      const content = typeof request?.content === "string" ? request.content : "";
      const deliverAs = request?.deliverAs === "follow-up" ? "follow-up" : request?.deliverAs === "steer" ? "steer" : undefined;
      if (!content.trim() || Buffer.byteLength(content, "utf8") > 48 * 1024 || !deliverAs) {
        reply(id, false, "invalid queued message");
        return;
      }
      try {
        cmd.queueMessage({ content, deliverAs });
        reply(id, true);
      } catch {
        reply(id, false, "Command Code rejected the queued message");
      }
    });
    socket.on("error", () => undefined);
  });
  server.unref();
  await new Promise((resolve, reject) => {
    const failed = (error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(0, "127.0.0.1");
  }).catch(() => failClosed("control bridge could not listen on loopback"));
  const address = server.address();
  if (!address || typeof address === "string") failClosed("control bridge did not expose a loopback port");
  try {
    await atomicJson(controlPath, { version: 1, host: "127.0.0.1", port: address.port });
  } catch {
    server.close();
    failClosed("control bridge receipt could not be persisted");
  }
  return server;
};

export default async function polythCommandCodeBridge(cmd) {
  const controlServer = await startControlServer(cmd);
  if (requestedTitle) cmd.setSessionName(requestedTitle);
  cmd.on("run_start", (event) => {
    if (event && typeof event.sessionId === "string" && event.sessionId) nativeSessionId = event.sessionId;
  });
  cmd.on("run_end", () => {
    try { controlServer.close(); } catch {}
  });
  cmd.hooks({
    onTurnStart: async ({ state }) => {
      await persistBinding();
      return state;
    },
  });
}
`;
