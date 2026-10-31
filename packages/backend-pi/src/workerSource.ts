export const PI_WORKER_SOURCE = String.raw`import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const command = process.env.POLYTH_PI_BIN;
const rawArgs = process.env.POLYTH_PI_ARGS;
const rawBridge = process.env.POLYTH_PI_TOOL_BRIDGE;
const extension = process.env.POLYTH_PI_EXTENSION;
const bootstrap = process.env.POLYTH_PI_BOOTSTRAP;
if (!command || !rawArgs || !rawBridge || !extension || !bootstrap) process.exit(64);

const MAX_LINE = 8 * 1024 * 1024;
const AGENT_TOOLS_PATH = "/internal/agent-tools";
const safeError = (value) => String(value ?? "Polyth tool failed")
  .replace(/((?:authorization|cookie|credential|password|secret|token|api[-_ ]?key)\s*[=:]\s*)\S+/gi, "$1[redacted]")
  .replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
const toolError = (value) => ({ content: [{ type: "text", text: safeError(value) }], isError: true });

let args;
let bridge;
try {
  args = JSON.parse(rawArgs);
  bridge = JSON.parse(rawBridge);
} catch { process.exit(64); }
if (!Array.isArray(args) || !bridge || !Array.isArray(bridge.capabilityIds)) process.exit(64);
let target;
try { target = new URL(bridge.url); } catch { process.exit(64); }
const host = target.hostname.toLowerCase();
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
  || !['http:', 'https:'].includes(target.protocol) || target.pathname !== AGENT_TOOLS_PATH
  || typeof bridge.token !== 'string' || !bridge.token) process.exit(64);
const allowed = new Set(bridge.capabilityIds);

const childEnv = { ...process.env };
delete childEnv.POLYTH_PI_BIN;
delete childEnv.POLYTH_PI_ARGS;
delete childEnv.POLYTH_PI_TOOL_BRIDGE;
delete childEnv.POLYTH_PI_EXTENSION;
delete childEnv.POLYTH_PI_BOOTSTRAP;
childEnv.POLYTH_PI_ENTRY = command;
childEnv.POLYTH_PI_NATIVE_ARGS = JSON.stringify(['--mode', 'rpc', ...args, '--extension', extension]);
const child = spawn(process.execPath, [bootstrap], {
  cwd: process.cwd(), env: childEnv, windowsHide: true,
  shell: false,
  stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const requests = child.stdio[3];
const responses = child.stdio[4];
let bytes = Buffer.alloc(0);
const pending = new Map();
let closed = false;
const write = (value) => {
  if (closed) return;
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_LINE) return;
  try { responses.write(encoded + '\n'); } catch { closeRelay(); }
};
const closeRelay = () => {
  if (closed) return;
  closed = true;
  for (const controller of pending.values()) controller.abort();
  pending.clear();
  try { responses.end(); } catch {}
};
const invoke = (message) => {
  const id = typeof message?.id === 'string' ? message.id : '';
  const capabilityId = typeof message?.capabilityId === 'string' ? message.capabilityId : '';
  if (!id || !allowed.has(capabilityId) || pending.has(id)) { write({ id, result: toolError('Invalid Polyth tool request') }); return; }
  const controller = new AbortController();
  pending.set(id, controller);
  const payload = JSON.stringify({ id: capabilityId, arguments: message.input ?? {} });
  let responseBytes = Buffer.alloc(0);
  const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)({
    hostname: target.hostname, port: target.port || undefined, path: target.pathname + target.search,
    method: 'POST', signal: controller.signal,
    headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
  }, (response) => {
    response.on('data', (chunk) => { responseBytes = Buffer.concat([responseBytes, chunk]); if (responseBytes.length > MAX_LINE) request.destroy(); });
    response.on('end', () => {
      if (pending.get(id) !== controller) return;
      pending.delete(id);
      let parsed;
      try { parsed = responseBytes.length ? JSON.parse(responseBytes.toString('utf8')) : {}; }
      catch { write({ id, result: toolError('Polyth tool bridge returned malformed JSON') }); return; }
      if ((response.statusCode ?? 500) >= 400) write({ id, result: toolError(parsed?.error?.message ?? 'Polyth tool failed') });
      else write({ id, result: { content: [{ type: 'text', text: String(parsed?.output ?? '') }], details: parsed?.metadata ?? {} } });
    });
  });
  request.on('error', (error) => { if (pending.get(id) === controller) { pending.delete(id); write({ id, result: toolError(controller.signal.aborted ? 'Polyth tool call aborted' : error) }); } });
  try { request.write(payload); request.end(); } catch (error) { pending.delete(id); write({ id, result: toolError(error) }); }
};
requests.on('data', (chunk) => {
  bytes = Buffer.concat([bytes, chunk]);
  while (true) {
    const end = bytes.indexOf(10);
    if (end < 0) break;
    if (end > MAX_LINE) { closeRelay(); return; }
    const raw = bytes.subarray(0, end); bytes = bytes.subarray(end + 1);
    if (!raw.length) continue;
    let message;
    try { message = JSON.parse(raw.toString('utf8')); } catch { closeRelay(); return; }
    if (message?.type === 'cancel') { pending.get(message.requestId)?.abort(); continue; }
    if (message?.type !== 'call') { closeRelay(); return; }
    invoke(message);
  }
  if (bytes.length > MAX_LINE) closeRelay();
});
requests.on('error', closeRelay);
requests.on('close', closeRelay);
responses.on('error', closeRelay);
child.once('error', () => process.exit(70));
child.once('close', (code, signal) => { closeRelay(); process.exit(signal ? 1 : code ?? 1); });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  try { child.stdin.end(); } catch {}
  try { child.kill(signal); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(1); }, 2_000);
});
`;
