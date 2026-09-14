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
let bindingSerial = Promise.resolve();

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

const updateBinding = (update) => {
  const work = bindingSerial.then(async () => {
    if (!bindingPath) throw new Error("binding file is missing");
    let previous;
    try { previous = JSON.parse(await readFile(bindingPath, "utf8")); }
    catch { throw new Error("binding file could not be read"); }
    if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw new Error("binding state is malformed");
    if (typeof previous.nativeSessionId === "string" && previous.nativeSessionId && nativeSessionId && previous.nativeSessionId !== nativeSessionId) {
      throw new Error("native session identity changed unexpectedly");
    }
    const next = update(previous);
    await atomicJson(bindingPath, next);
    return next;
  });
  bindingSerial = work.then(() => undefined, () => undefined);
  return work;
};

const normalizedMutations = (previous) => {
  const explicit = Array.isArray(previous.acceptedMutations)
    ? previous.acceptedMutations.filter((entry) => entry && typeof entry.operationId === "string"
      && (entry.mutationKind === "turn-submit" || entry.mutationKind === "turn-steer"))
    : [];
  if (explicit.length) return explicit;
  const legacy = Array.isArray(previous.acceptedOperations)
    ? previous.acceptedOperations.filter((value) => typeof value === "string" && value)
    : [];
  return legacy.map((operationId) => ({ operationId, mutationKind: "turn-submit" }));
};

const persistTurnBinding = async () => {
  if (!requestedOperationId) failClosed("turn operation id is missing");
  if (!nativeSessionId) failClosed("Command Code did not expose a native session id before turn admission");
  try {
    await updateBinding((previous) => {
      const priorAccepted = Array.isArray(previous.acceptedOperations)
        ? previous.acceptedOperations.filter((value) => typeof value === "string" && value)
        : [];
      const acceptedOperations = priorAccepted.includes(requestedOperationId)
        ? priorAccepted
        : [...priorAccepted, requestedOperationId].slice(-64);
      const mutations = normalizedMutations(previous);
      const acceptedMutations = mutations.some((entry) => entry.operationId === requestedOperationId && entry.mutationKind === "turn-submit")
        ? mutations
        : [...mutations, { operationId: requestedOperationId, mutationKind: "turn-submit" }].slice(-128);
      return {
        ...previous,
        nativeSessionId,
        nativeBoundAt: Date.now(),
        acceptedOperations,
        acceptedMutations,
        updatedAt: Date.now(),
      };
    });
  } catch (error) {
    failClosed(error instanceof Error ? error.message : "native session receipt could not be persisted");
  }
};

const persistSteerReceipt = async (operationId) => {
  if (!operationId) throw new Error("steering operation id is missing");
  await updateBinding((previous) => {
    const mutations = normalizedMutations(previous);
    const acceptedMutations = mutations.some((entry) => entry.operationId === operationId && entry.mutationKind === "turn-steer")
      ? mutations
      : [...mutations, { operationId, mutationKind: "turn-steer" }].slice(-128);
    return { ...previous, acceptedMutations, updatedAt: Date.now() };
  });
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
    socket.on("data", async (chunk) => {
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
      const operationId = typeof request?.operationId === "string" ? request.operationId : "";
      if (!id || request?.token !== controlToken) { reply(id, false, "unauthorized control request"); return; }
      if (request?.type !== "queue" || request?.deliverAs !== "steer") { reply(id, false, "unsupported control request"); return; }
      const content = typeof request?.content === "string" ? request.content : "";
      if (!operationId || !content.trim() || Buffer.byteLength(content, "utf8") > 48 * 1024) {
        reply(id, false, "invalid steering message");
        return;
      }
      try {
        cmd.queueMessage({ content, deliverAs: "steer" });
      } catch {
        reply(id, false, "Command Code rejected the steering message");
        return;
      }
      try {
        await persistSteerReceipt(operationId);
      } catch {
        // The native queue may already contain the message. Without a durable
        // receipt Polyth must not retry it, so terminate the run fail-closed.
        failClosed("native steering receipt could not be persisted");
        return;
      }
      reply(id, true);
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
      await persistTurnBinding();
      return state;
    },
  });
}
`;
