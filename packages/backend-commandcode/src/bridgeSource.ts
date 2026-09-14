export const COMMANDCODE_BRIDGE_SOURCE = String.raw`import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const bindingPath = process.env.POLYTH_COMMANDCODE_BINDING_FILE?.trim();
const requestedTitle = process.env.POLYTH_COMMANDCODE_TITLE?.trim();
const requestedOperationId = process.env.POLYTH_COMMANDCODE_OPERATION_ID?.trim();
let nativeSessionId = "";

const failClosed = (message) => {
  try { process.stderr.write("[polyth-commandcode] " + message + "\\n"); } catch {}
  process.exit(70);
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
  await mkdir(dirname(bindingPath), { recursive: true });
  const temp = bindingPath + "." + process.pid + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
    await rename(temp, bindingPath);
  } catch {
    failClosed("native session receipt could not be persisted");
  }
};

export default function polythCommandCodeBridge(cmd) {
  if (requestedTitle) cmd.setSessionName(requestedTitle);
  cmd.on("run_start", (event) => {
    if (event && typeof event.sessionId === "string" && event.sessionId) nativeSessionId = event.sessionId;
  });
  cmd.hooks({
    onTurnStart: async ({ state }) => {
      await persistBinding();
      return state;
    },
  });
}
`;
