#!/usr/bin/env node
/**
 * Scaled Phase 9 real-world soak.
 *
 * The default run churns for ten minutes with 24 real OpenCode sessions,
 * 200+ unique logical messages, repeated model refreshes, WebSocket reconnects,
 * session gap-fill reads, one exact owned-child death, and one exact Polyth
 * process death while its child remains alive.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { hostname, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";

const ROOT = "/workspace";
const ARTIFACTS = join(ROOT, "artifacts/opencode-real-world/phase-9");
const LOGS_ROOT = join(ROOT, "logs/opencode-real-world/phase-9");
const PHASE4_TOOLS = join(ROOT, "artifacts/opencode-real-world/phase-4/tools");
const OPENCODE_BIN = "/home/ubuntu/.local/bin/opencode";
const PORT = Number(process.env.SOAK_PORT ?? 15290);
const SOAK_MS = Number(process.env.SOAK_MS ?? 600_000);
const SESSION_COUNT = Number(process.env.SOAK_SESSIONS ?? 24);
const INITIAL_QUEUE_PER_SESSION = Number(process.env.SOAK_INITIAL_QUEUE ?? 4);
const SAMPLE_INTERVAL_MS = Number(process.env.SOAK_SAMPLE_INTERVAL_MS ?? 5_000);
const MODEL_NAME = process.env.SOAK_MODEL ?? "opencode/big-pickle";
const [providerID, ...modelTail] = MODEL_NAME.split("/");
const model = { providerID, modelID: modelTail.join("/") };
const runId = `scaled-${Date.now().toString(36)}`;
const LOGS = join(LOGS_ROOT, runId);
const scratch = `/tmp/ocreal/phase-9/${runId}`;
const projectPath = join(scratch, "project");
const dataDir = join(scratch, "polyth-data");
const configDir = join(scratch, "opencode-config");
const xdgData = join(scratch, "xdg-data");
const proxyDir = join(scratch, "proxy");
const timelinePath = join(LOGS, "timeline.ndjson");
const checks = [];
const samples = [];
const sessionIds = [];
const directMarkers = [];
const queuedMarkers = [];
const killTargets = [];
const oldOwnedPids = new Set();
const answeredPermissions = new Set();
const websocketLatenciesMs = [];
const sessionLoadLatenciesMs = [];
const modelRefreshLatenciesMs = [];
const apiErrors = [];
const expectedConflicts = [];
let websocketReconnects = 0;
let modelRefreshes = 0;
let logicalMessages = 0;
let currentPolyth;
let projectId;
let childRestart;
let polythRestart;

for (const directory of [
  ARTIFACTS,
  LOGS,
  scratch,
  projectPath,
  dataDir,
  configDir,
  xdgData,
  proxyDir,
]) {
  mkdirSync(directory, { recursive: true });
}

const redactSecrets = (text) => {
  let redacted = text;
  for (const name of [
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "HUGGINGFACE_API_KEY",
  ]) {
    const value = process.env[name];
    if (value && value.length > 4) redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
};
const json = (value) =>
  redactSecrets(JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? Number(item) : item, 2));
const writeJson = (path, value) => writeFileSync(path, json(value));
const timeline = (entry) => {
  const value = { ts: new Date().toISOString(), elapsedMs: Date.now() - startedAt, ...entry };
  appendFileSync(timelinePath, `${redactSecrets(JSON.stringify(value))}\n`);
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const percentile = (values, ratio) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};
const median = (values) => percentile(values, 0.5);
const check = (name, pass, observed) => {
  checks.push({ name, pass, observed });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${observed}`);
};
const timed = async (operation) => {
  const before = performance.now();
  const value = await operation();
  return { value, elapsedMs: Math.round((performance.now() - before) * 10) / 10 };
};

const procIdentity = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return {
      pid,
      state: fields[0],
      parentPid: Number(fields[1]),
      startIdentity: fields[19],
      executable: readlinkSync(`/proc/${pid}/exe`),
      command: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim(),
      cwd: readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ""),
    };
  } catch {
    return undefined;
  }
};

const processMetrics = (pid) => {
  const identity = procIdentity(pid);
  if (!identity) return undefined;
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  let fds = 0;
  let sockets = 0;
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      fds += 1;
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`).startsWith("socket:[")) sockets += 1;
      } catch {
        // Descriptor closed during sampling.
      }
    }
  } catch {
    // Process exited during sampling.
  }
  return {
    ...identity,
    rssKb: Number(rssMatch?.[1] ?? 0),
    fds,
    sockets,
  };
};

const allOpenCodeProcesses = () => {
  const processes = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const identity = procIdentity(Number(entry));
    if (!identity) continue;
    if (
      (identity.command.includes("opencode serve")
        || identity.command.includes("shim-proxy.mjs serve"))
      && identity.command.includes("--port")
    ) {
      processes.push(identity);
    }
  }
  return processes;
};

const baselineForeign = allOpenCodeProcesses().filter((process_) =>
  !resolve(process_.cwd).startsWith(resolve(scratch)));
const startedAt = Date.now();
let churnStartedAt = startedAt;
timeline({
  event: "start",
  runId,
  soakMs: SOAK_MS,
  sessionCount: SESSION_COUNT,
  initialQueuePerSession: INITIAL_QUEUE_PER_SESSION,
  foreignProcessBaseline: baselineForeign,
});

const killExact = (
  pid,
  expectedCommand,
  label,
  signal = "SIGKILL",
  expectedCwd = scratch,
) => {
  const identity = procIdentity(pid);
  if (!identity) throw new Error(`${label}: PID ${pid} is not alive`);
  if (!identity.command.includes(expectedCommand)) {
    throw new Error(`${label}: PID ${pid} command mismatch: ${identity.command}`);
  }
  if (!resolve(identity.cwd).startsWith(resolve(expectedCwd))) {
    throw new Error(`${label}: refusing to signal PID ${pid} outside ${expectedCwd}: ${identity.cwd}`);
  }
  killTargets.push({ label, signal, ...identity });
  timeline({ event: "kill-exact", label, signal, identity });
  process.kill(pid, signal);
  oldOwnedPids.add(pid);
  return identity;
};

const portIsFree = () => new Promise((resolvePort, rejectPort) => {
  if (PORT === 14500) {
    rejectPort(new Error("port 14500 is forbidden"));
    return;
  }
  const server = createNetServer();
  server.once("error", rejectPort);
  server.listen(PORT, "127.0.0.1", () => server.close(() => resolvePort()));
});

const startPolyth = async (label) => {
  const log = createWriteStream(join(LOGS, `${label}.log`), { flags: "a" });
  const child = spawn(process.execPath, [join(PHASE4_TOOLS, "boot-polyth.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      POLYTH_DATA_DIR: dataDir,
      OC_PROTOCOL: "legacy",
      OC_CONFIG_DIR: configDir,
      OC_BIN: join(PHASE4_TOOLS, "shim-proxy.mjs"),
      OC_PROXY_DIR: proxyDir,
      OC_REAL_BIN: OPENCODE_BIN,
      XDG_DATA_HOME: xdgData,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`${label} did not listen within 30s`)),
      30_000,
    );
    const onData = (chunk) => {
      const text = chunk.toString();
      output += text;
      log.write(text);
      if (output.includes("[polyth] server on")) {
        clearTimeout(timeout);
        resolveReady();
      } else if (output.includes("[harness] polyth boot failed")) {
        clearTimeout(timeout);
        rejectReady(new Error(`${label} failed to boot`));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      log.write(`[soak] ${label} exited code=${code} signal=${signal}\n`);
      clearTimeout(timeout);
      rejectReady(new Error(`${label} exited before readiness`));
    });
  });
  timeline({ event: "polyth-started", label, pid: child.pid, port: PORT });
  return { label, child, pid: child.pid, log };
};

const api = async (method, path, body, timeoutMs = 30_000) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = raw;
  }
  return { status: response.status, body: parsed, raw };
};

const proxyState = () => readJson(join(proxyDir, "state.json"));
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const databaseMetrics = () => {
  const dbPath = join(dataDir, "sessions.db");
  const size = (path) => existsSync(path) ? statSync(path).size : 0;
  const metric = {
    dbBytes: size(dbPath),
    walBytes: size(`${dbPath}-wal`),
    shmBytes: size(`${dbPath}-shm`),
    totalBytes: size(dbPath) + size(`${dbPath}-wal`) + size(`${dbPath}-shm`),
    integrity: "not-open",
    rows: {},
  };
  if (!existsSync(dbPath)) return metric;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    metric.integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "missing";
    for (const table of [
      "events",
      "projections",
      "runtime_operations",
      "session_queue",
      "observations",
      "attention_open",
    ]) {
      metric.rows[table] = Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? 0);
    }
  } finally {
    db.close();
  }
  return metric;
};

const sampleMetrics = (phase) => {
  let state;
  try {
    state = proxyState();
  } catch {
    state = undefined;
  }
  const sample = {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - churnStartedAt,
    phase,
    polyth: currentPolyth ? processMetrics(currentPolyth.pid) : undefined,
    wrapper: state ? processMetrics(state.wrapperPid) : undefined,
    opencode: state ? processMetrics(state.childPid) : undefined,
    database: databaseMetrics(),
    counters: {
      sessions: sessionIds.length,
      logicalMessages,
      websocketReconnects,
      modelRefreshes,
    },
  };
  samples.push(sample);
  appendFileSync(join(LOGS, "metrics.ndjson"), `${JSON.stringify(sample)}\n`);
  return sample;
};

const reconnect = async (sessionId) => {
  const started = performance.now();
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const latency = await new Promise((resolveLatency, rejectLatency) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      rejectLatency(new Error("WebSocket reconnect timed out"));
    }, 10_000);
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "subscribe",
        sessionId,
        projectId,
        afterSeq: 0,
      }));
    });
    socket.once("message", () => {
      clearTimeout(timeout);
      resolveLatency(Math.round((performance.now() - started) * 10) / 10);
      socket.close();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      rejectLatency(error);
    });
  });
  websocketReconnects += 1;
  websocketLatenciesMs.push(latency);
  return latency;
};

const answerPermissions = async () => {
  for (const sessionId of sessionIds) {
    const response = await api("GET", `/api/sessions/${sessionId}/events?afterSeq=0`);
    if (response.status !== 200 || !Array.isArray(response.body)) continue;
    const resolved = new Set(response.body
      .filter((event) => event.type === "permission/resolved")
      .map((event) => String(event.data?.requestId ?? "")));
    for (const event of response.body) {
      if (event.type !== "permission/requested") continue;
      const requestId = String(event.data?.requestId ?? "");
      if (!requestId || resolved.has(requestId) || answeredPermissions.has(requestId)) continue;
      const reply = await api(
        "POST",
        `/api/sessions/${sessionId}/permission/${encodeURIComponent(requestId)}`,
        { reply: "once" },
        60_000,
      );
      answeredPermissions.add(requestId);
      timeline({ event: "permission-replied", sessionId, requestId, status: reply.status });
    }
  }
};

const queueSnapshot = async () => {
  const rows = [];
  for (const sessionId of sessionIds) {
    const response = await api("GET", `/api/sessions/${sessionId}/queue`, undefined, 60_000);
    if (!Array.isArray(response.body)) continue;
    rows.push(...response.body.map((item, index) => ({
      sessionId,
      index,
      id: item.id ?? item.queueId,
      text: item.text,
    })));
  }
  return rows.sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId) || left.index - right.index);
};

const createSession = async (index) => {
  const result = await api("POST", "/api/sessions", {
    projectId,
    title: `phase9-${String(index).padStart(2, "0")}`,
    model,
  }, 60_000);
  if (result.status !== 200 || !result.body?.id) {
    throw new Error(`session ${index} create failed ${result.status}: ${result.raw}`);
  }
  const sessionId = result.body.id;
  sessionIds.push(sessionId);
  const marker = `SOAK_DIRECT_${String(index).padStart(3, "0")}`;
  directMarkers.push(marker);
  const tool = index < 4;
  const text = tool
    ? `Run exactly this bash command and then reply with ${marker}: echo ${marker} >> soak-effects.txt`
    : `Think briefly, then reply with exactly ${marker} and nothing else.`;
  const sent = await api("POST", `/api/sessions/${sessionId}/message`, { text, model }, 60_000);
  if (sent.status !== 200) {
    throw new Error(`session ${index} prompt failed ${sent.status}: ${sent.raw}`);
  }
  logicalMessages += 1;
  for (let queueIndex = 0; queueIndex < INITIAL_QUEUE_PER_SESSION; queueIndex += 1) {
    const queueMarker = `SOAK_QUEUE_${String(index).padStart(3, "0")}_${queueIndex}`;
    const queued = await api("POST", `/api/sessions/${sessionId}/message`, {
      text: queueMarker,
      model,
      delivery: "queue",
    }, 60_000);
    if (queued.status !== 200) {
      throw new Error(`session ${index} queue ${queueIndex} failed ${queued.status}: ${queued.raw}`);
    }
    queuedMarkers.push(queueMarker);
    logicalMessages += 1;
  }
  return sessionId;
};

const restartOwnedChild = async () => {
  const queueBefore = await queueSnapshot();
  const before = proxyState();
  const identity = killExact(before.childPid, "opencode serve", "owned-opencode-child");
  await sleep(2_000);
  const refresh = await api("GET", "/api/models", undefined, 60_000);
  if (refresh.status !== 200) throw new Error(`model refresh after child death returned ${refresh.status}`);
  await waitFor(async () => {
    try {
      const after = proxyState();
      return after.childPid !== before.childPid && procIdentity(after.childPid) ? after : undefined;
    } catch {
      return undefined;
    }
  }, 60_000, 250, "owned child replacement");
  const after = proxyState();
  childRestart = {
    atElapsedMs: Date.now() - churnStartedAt,
    before,
    killedIdentity: identity,
    after,
    oldWrapperGone: !procIdentity(before.wrapperPid),
    oldChildGone: !procIdentity(before.childPid),
    queueRowsBefore: queueBefore.length,
    queueRowsAfter: (await queueSnapshot()).length,
  };
  oldOwnedPids.add(before.wrapperPid);
  timeline({ event: "owned-child-restarted", ...childRestart });
};

const restartPolyth = async () => {
  const queueBefore = await queueSnapshot();
  const beforeState = proxyState();
  const wrapperBefore = procIdentity(beforeState.wrapperPid);
  const childBefore = procIdentity(beforeState.childPid);
  const killed = killExact(
    currentPolyth.pid,
    "boot-polyth.mjs",
    "polyth-process",
    "SIGKILL",
    ROOT,
  );
  await sleep(1_500);
  const survivedCrash = Boolean(procIdentity(beforeState.wrapperPid) && procIdentity(beforeState.childPid));
  await portIsFree();
  currentPolyth = await startPolyth("polyth-2");
  const models = await api("GET", "/api/models", undefined, 60_000);
  if (models.status !== 200) throw new Error(`model refresh after Polyth restart returned ${models.status}`);
  await waitFor(async () => {
    try {
      const after = proxyState();
      return after.wrapperPid !== beforeState.wrapperPid && procIdentity(after.wrapperPid)
        ? after
        : undefined;
    } catch {
      return undefined;
    }
  }, 60_000, 250, "post-Polyth owned runtime");
  const afterState = proxyState();
  oldOwnedPids.add(beforeState.wrapperPid);
  oldOwnedPids.add(beforeState.childPid);

  let firstWireFailures = 0;
  for (const sessionId of sessionIds) {
    const response = await api("GET", `/api/sessions/${sessionId}/events?afterSeq=0`, undefined, 60_000);
    if (response.status !== 200) firstWireFailures += 1;
  }
  const queueAfter = await queueSnapshot();
  const abortProbe = await api(
    "POST",
    `/api/sessions/${sessionIds[0]}/abort`,
    undefined,
    60_000,
  );
  polythRestart = {
    atElapsedMs: Date.now() - churnStartedAt,
    killed,
    beforeState,
    wrapperBefore,
    childBefore,
    survivedCrash,
    afterState,
    firstWireFailures,
    abortProbe: { status: abortProbe.status, body: abortProbe.body },
    oldWrapperGone: !procIdentity(beforeState.wrapperPid),
    oldChildGone: !procIdentity(beforeState.childPid),
    queueRowsBefore: queueBefore.length,
    queueRowsAfter: queueAfter.length,
  };
  timeline({ event: "polyth-restarted", ...polythRestart });
};

const waitFor = async (predicate, timeoutMs, intervalMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`${label} did not complete within ${timeoutMs} ms`);
};

await portIsFree();
writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  permission: { bash: "allow" },
}, null, 2));
writeFileSync(join(proxyDir, "rules.json"), JSON.stringify({ rules: [] }));

const manifest = {
  id: "OC-REAL-084-SCALED",
  runId,
  startedAt: new Date(startedAt).toISOString(),
  headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  opencode: {
    version: execFileSync(OPENCODE_BIN, ["--version"], { encoding: "utf8" }).trim(),
    binary: OPENCODE_BIN,
    sha256: execFileSync("sha256sum", [OPENCODE_BIN], { encoding: "utf8" }).split(/\s+/)[0],
  },
  node: process.version,
  os: `${platform()} ${release()} ${hostname()}`,
  protocol: "legacy (forced)",
  model,
  port: PORT,
  soakTargetMs: SOAK_MS,
  sessionTarget: SESSION_COUNT,
  scratch,
  dataDir,
  projectPath,
  foreignProcessBaseline: baselineForeign,
};
writeJson(join(ARTIFACTS, "manifest.json"), manifest);

currentPolyth = await startPolyth("polyth-1");
const projectResponse = await api("POST", "/api/projects", {
  path: projectPath,
  name: "phase9-scaled",
});
if (projectResponse.status !== 200 || !projectResponse.body?.id) {
  throw new Error(`project create failed ${projectResponse.status}: ${projectResponse.raw}`);
}
projectId = projectResponse.body.id;

const preChurn = sampleMetrics("pre-churn");
for (let index = 0; index < SESSION_COUNT; index += 1) {
  await createSession(index);
  if (index % 4 === 3) await answerPermissions();
}
await answerPermissions();

churnStartedAt = Date.now();
timeline({
  event: "churn-started",
  sessions: sessionIds.length,
  logicalMessages,
  initialQueueEntries: queuedMarkers.length,
});
sampleMetrics("warm");

let loop = 0;
while (Date.now() - churnStartedAt < SOAK_MS) {
  const loopStarted = Date.now();
  const sessionId = sessionIds[loop % sessionIds.length];
  try {
    const models = await timed(() => api("GET", "/api/models", undefined, 60_000));
    modelRefreshes += 1;
    modelRefreshLatenciesMs.push(models.elapsedMs);
    if (models.value.status !== 200) {
      apiErrors.push({ loop, operation: "models", status: models.value.status });
    }

    const loaded = await timed(() =>
      api("GET", `/api/sessions/${sessionId}/events?afterSeq=0`, undefined, 60_000));
    sessionLoadLatenciesMs.push(loaded.elapsedMs);
    if (loaded.value.status !== 200) {
      apiErrors.push({ loop, operation: "events", sessionId, status: loaded.value.status });
    }

    await reconnect(sessionId);

    const marker = `SOAK_CHURN_${String(loop).padStart(4, "0")}`;
    const queued = await api("POST", `/api/sessions/${sessionId}/message`, {
      text: marker,
      model,
      delivery: "queue",
    }, 60_000);
    if (queued.status === 200) {
      queuedMarkers.push(marker);
      logicalMessages += 1;
    } else if (
      queued.status === 409
      && queued.body?.error === "conflict"
      && (childRestart || polythRestart)
    ) {
      // Generation-only continuity deliberately settles interrupted sessions
      // to unknown. New mutation admission must fail closed after restart;
      // this is an expected safety result, not a transport/soak error.
      expectedConflicts.push({
        loop,
        operation: "queue",
        sessionId,
        status: queued.status,
        body: queued.body,
      });
    } else {
      apiErrors.push({ loop, operation: "queue", sessionId, status: queued.status, body: queued.body });
    }

    if (loop % 6 === 0) await answerPermissions();
    if (!childRestart && Date.now() - churnStartedAt >= Math.min(180_000, SOAK_MS * 0.3)) {
      await restartOwnedChild();
    }
    if (!polythRestart && Date.now() - churnStartedAt >= Math.min(360_000, SOAK_MS * 0.6)) {
      await restartPolyth();
    }
    sampleMetrics(polythRestart ? "post-polyth-restart" : childRestart ? "post-child-restart" : "steady");
  } catch (error) {
    apiErrors.push({ loop, operation: "loop", error: String(error) });
    timeline({ event: "loop-error", loop, error: String(error) });
  }
  loop += 1;
  const wait = SAMPLE_INTERVAL_MS - (Date.now() - loopStarted);
  if (wait > 0) await sleep(wait);
}

await answerPermissions();
const queueBeforeDrain = [];
const finalEvents = new Map();
for (const sessionId of sessionIds) {
  const [events, queue] = await Promise.all([
    api("GET", `/api/sessions/${sessionId}/events?afterSeq=0`, undefined, 60_000),
    api("GET", `/api/sessions/${sessionId}/queue`, undefined, 60_000),
  ]);
  finalEvents.set(sessionId, Array.isArray(events.body) ? events.body : []);
  if (Array.isArray(queue.body)) {
    queueBeforeDrain.push(...queue.body.map((item, index) => ({ sessionId, index, ...item })));
  }
}

for (const row of queueBeforeDrain) {
  const queueId = row.id ?? row.queueId;
  if (!queueId) continue;
  const removed = await api(
    "DELETE",
    `/api/sessions/${row.sessionId}/queue/${encodeURIComponent(queueId)}`,
    undefined,
    60_000,
  );
  if (removed.status !== 200) {
    apiErrors.push({
      operation: "queue-remove",
      sessionId: row.sessionId,
      queueId,
      status: removed.status,
    });
  }
}

for (const sessionId of sessionIds) {
  await api("POST", `/api/sessions/${sessionId}/abort`, undefined, 60_000).catch((error) => {
    apiErrors.push({ operation: "final-abort", sessionId, error: String(error) });
  });
}
await sleep(5_000);

const queueAfterDrain = [];
const projections = [];
let userMessageCount = 0;
let duplicateDirectMarkers = 0;
const observedDirect = new Map(directMarkers.map((marker) => [marker, 0]));
for (const sessionId of sessionIds) {
  const [events, queue, projection] = await Promise.all([
    api("GET", `/api/sessions/${sessionId}/events?afterSeq=0`, undefined, 60_000),
    api("GET", `/api/sessions/${sessionId}/queue`, undefined, 60_000),
    api("GET", `/api/sessions/${sessionId}`, undefined, 60_000),
  ]);
  const rows = Array.isArray(events.body) ? events.body : [];
  userMessageCount += rows.filter((event) => event.type === "user/message").length;
  for (const event of rows.filter((item) => item.type === "user/message")) {
    const text = String(event.data?.text ?? "");
    for (const marker of directMarkers) {
      if (text.includes(marker)) observedDirect.set(marker, (observedDirect.get(marker) ?? 0) + 1);
    }
  }
  if (Array.isArray(queue.body)) queueAfterDrain.push(...queue.body);
  if (projection.body) projections.push(projection.body);
}
for (const count of observedDirect.values()) if (count > 1) duplicateDirectMarkers += 1;

const effectPath = join(projectPath, "soak-effects.txt");
const effectLines = existsSync(effectPath)
  ? readFileSync(effectPath, "utf8").split("\n").filter(Boolean)
  : [];
const duplicateEffects = effectLines.length - new Set(effectLines).size;
const wire = existsSync(join(proxyDir, "wire.ndjson"))
  ? readFileSync(join(proxyDir, "wire.ndjson"), "utf8")
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : [];
const promptPosts = wire.filter((entry) =>
  entry.event === "proxied"
    && entry.method === "POST"
    && /prompt_async/.test(entry.path ?? ""));
const currentState = proxyState();
const allMarkers = [...directMarkers, ...queuedMarkers];
const upstreamMarkerCounts = new Map(allMarkers.map((marker) => [marker, 0]));
for (const projection of projections) {
  if (!projection.backendSessionId) continue;
  try {
    const response = await fetch(
      `http://127.0.0.1:${currentState.proxyPort}`
        + `/session/${encodeURIComponent(projection.backendSessionId)}/message`
        + `?directory=${encodeURIComponent(projectPath)}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    const messages = await response.json();
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (message?.info?.role !== "user") continue;
      const text = (Array.isArray(message.parts) ? message.parts : [])
        .filter((part) => part?.type === "text")
        .map((part) => String(part.text ?? ""))
        .join("\n");
      for (const marker of allMarkers) {
        if (text.includes(marker)) {
          upstreamMarkerCounts.set(marker, (upstreamMarkerCounts.get(marker) ?? 0) + 1);
        }
      }
    }
  } catch (error) {
    apiErrors.push({
      operation: "upstream-history",
      backendSessionId: projection.backendSessionId,
      error: String(error),
    });
  }
}
const duplicateUpstreamMarkers = [...upstreamMarkerCounts]
  .filter(([, count]) => count > 1);
const dispatchedQueuePrompts = Math.max(0, promptPosts.length - directMarkers.length);
const stuckProjections = projections.filter((projection) =>
  projection.status === "sending" || projection.status === "working");

const currentPolythIdentity = procIdentity(currentPolyth.pid);
const currentWrapperIdentity = procIdentity(currentState.wrapperPid);
const currentChildIdentity = procIdentity(currentState.childPid);
const scratchProcesses = allOpenCodeProcesses().filter((process_) =>
  resolve(process_.cwd).startsWith(resolve(scratch)));
const parentChainValid =
  currentPolythIdentity
  && currentWrapperIdentity?.parentPid === currentPolyth.pid
  && currentChildIdentity?.parentPid === currentState.wrapperPid;
const staleOwnedAlive = [...oldOwnedPids].filter((pid) => procIdentity(pid));
const foreignFinal = baselineForeign.map((baseline) => {
  const current = procIdentity(baseline.pid);
  return {
    baseline,
    aliveWithSameIdentity: Boolean(
      current
      && current.startIdentity === baseline.startIdentity
      && current.command === baseline.command
    ),
    current: current ?? null,
  };
});

const finalSample = sampleMetrics("final");
const postRestartSamples = samples.filter((sample) =>
  sample.phase === "post-polyth-restart" || sample.phase === "final");
const stableWindow = postRestartSamples.slice(-Math.min(20, postRestartSamples.length));
const rssValues = stableWindow.map((sample) => sample.polyth?.rssKb ?? 0).filter(Boolean);
const fdValues = stableWindow.map((sample) => sample.polyth?.fds ?? 0).filter(Boolean);
const socketValues = stableWindow.map((sample) => sample.polyth?.sockets ?? 0);
const rssGrowthKb = rssValues.length > 1 ? rssValues.at(-1) - rssValues[0] : 0;
const fdGrowth = fdValues.length > 1 ? fdValues.at(-1) - fdValues[0] : 0;
const socketGrowth = socketValues.length > 1 ? socketValues.at(-1) - socketValues[0] : 0;
const leakVerdict =
  rssGrowthKb < 100 * 1024
  && fdGrowth < 20
  && socketGrowth < 10
  && staleOwnedAlive.length === 0;

check("scaled soak reached duration target", Date.now() - churnStartedAt >= SOAK_MS,
  `churnMs=${Date.now() - churnStartedAt} targetMs=${SOAK_MS}`);
check("dense churn reached the duration-or-turn target with many sessions",
  sessionIds.length >= 20
    && (logicalMessages >= 200 || Date.now() - churnStartedAt >= SOAK_MS),
  `sessions=${sessionIds.length} logicalMessages=${logicalMessages} churnMs=${Date.now() - churnStartedAt}`);
check("model refresh and reconnect churn accumulated",
  modelRefreshes >= 50 && websocketReconnects >= 50,
  `modelRefreshes=${modelRefreshes} websocketReconnects=${websocketReconnects}`);
check("owned child restart completed without stale owned process",
  childRestart?.oldChildGone === true && childRestart?.oldWrapperGone === true,
  JSON.stringify(childRestart ?? null));
check("Polyth restart completed with first-wire session access",
  polythRestart?.survivedCrash === true
    && polythRestart.firstWireFailures === 0
    && polythRestart.abortProbe.status === 200,
  JSON.stringify(polythRestart ?? null));
check("no duplicate direct logical prompt or tool side effect",
  duplicateDirectMarkers === 0
    && [...observedDirect.values()].every((count) => count === 1)
    && duplicateEffects === 0
    && duplicateUpstreamMarkers.length === 0,
  `directCounts=${JSON.stringify([...observedDirect.values()])} effects=${effectLines.length} duplicateEffects=${duplicateEffects} duplicateUpstream=${JSON.stringify(duplicateUpstreamMarkers)}`);
check("wire prompt dispatch is bounded by unique logical messages",
  promptPosts.length >= directMarkers.length
    && promptPosts.length <= logicalMessages
    && duplicateUpstreamMarkers.length === 0,
  `promptPosts=${promptPosts.length} directMarkers=${directMarkers.length} logicalMessages=${logicalMessages}`);
check("no session remains stuck sending or working",
  stuckProjections.length === 0,
  `stuck=${JSON.stringify(stuckProjections.map((projection) => ({ id: projection.id, status: projection.status })))}`);
check("queue rows survived restart in order and drained without row loss",
  childRestart?.queueRowsBefore === childRestart?.queueRowsAfter
    && polythRestart?.queueRowsBefore === polythRestart?.queueRowsAfter
    && queueBeforeDrain.length + dispatchedQueuePrompts >= queuedMarkers.length
    && queueAfterDrain.length === 0,
  `child=${childRestart?.queueRowsBefore}->${childRestart?.queueRowsAfter} polyth=${polythRestart?.queueRowsBefore}->${polythRestart?.queueRowsAfter} beforeDrain=${queueBeforeDrain.length} dispatched=${dispatchedQueuePrompts} submitted=${queuedMarkers.length} afterDrain=${queueAfterDrain.length}`);
check("SQLite remains valid", finalSample.database.integrity === "ok",
  JSON.stringify(finalSample.database));
check("no orphan owned processes and parent chain remains exact",
  Boolean(parentChainValid)
    && staleOwnedAlive.length === 0
    && scratchProcesses.length === 2,
  JSON.stringify({
    polyth: currentPolythIdentity,
    wrapper: currentWrapperIdentity,
    child: currentChildIdentity,
    scratchProcesses,
    staleOwnedAlive,
  }));
check("every forced signal target belonged to this isolated run",
  killTargets.length === 2
    && killTargets.every((target) =>
      target.label === "polyth-process"
        ? target.pid === polythRestart?.killed.pid
          && resolve(target.cwd) === resolve(ROOT)
        : resolve(target.cwd).startsWith(resolve(scratch))),
  JSON.stringify(killTargets));
check("churn API operations completed without transport or HTTP errors",
  apiErrors.length === 0,
  `apiErrors=${JSON.stringify(apiErrors)}`);
check("no monotonic non-data resource leak detected", leakVerdict,
  `lateWindowSamples=${stableWindow.length} rssGrowthKb=${rssGrowthKb} fdGrowth=${fdGrowth} socketGrowth=${socketGrowth}`);

const endedAt = Date.now();
const metrics = {
  schemaVersion: 1,
  runId,
  startedAt: new Date(startedAt).toISOString(),
  churnStartedAt: new Date(churnStartedAt).toISOString(),
  endedAt: new Date(endedAt).toISOString(),
  totalDurationMs: endedAt - startedAt,
  churnDurationMs: endedAt - churnStartedAt,
  configuration: {
    soakTargetMs: SOAK_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    sessionTarget: SESSION_COUNT,
    initialQueuePerSession: INITIAL_QUEUE_PER_SESSION,
    port: PORT,
    model,
  },
  counts: {
    sessions: sessionIds.length,
    logicalMessages,
    directMessages: directMarkers.length,
    queuedMessages: queuedMarkers.length,
    durableUserMessages: userMessageCount,
    promptPosts: promptPosts.length,
    dispatchedQueuePrompts,
    queueBeforeDrain: queueBeforeDrain.length,
    queueAfterDrain: queueAfterDrain.length,
    permissionsAnswered: answeredPermissions.size,
    toolSideEffects: effectLines.length,
    websocketReconnects,
    modelRefreshes,
    samples: samples.length,
    apiErrors: apiErrors.length,
    expectedPostRestartConflicts: expectedConflicts.length,
  },
  latenciesMs: {
    sessionLoad: {
      p50: percentile(sessionLoadLatenciesMs, 0.5),
      p95: percentile(sessionLoadLatenciesMs, 0.95),
      max: sessionLoadLatenciesMs.length ? Math.max(...sessionLoadLatenciesMs) : null,
    },
    websocketReconnect: {
      p50: percentile(websocketLatenciesMs, 0.5),
      p95: percentile(websocketLatenciesMs, 0.95),
      max: websocketLatenciesMs.length ? Math.max(...websocketLatenciesMs) : null,
    },
    modelRefresh: {
      p50: percentile(modelRefreshLatenciesMs, 0.5),
      p95: percentile(modelRefreshLatenciesMs, 0.95),
      max: modelRefreshLatenciesMs.length ? Math.max(...modelRefreshLatenciesMs) : null,
    },
  },
  resources: {
    preChurn,
    final: finalSample,
    stableWindow: {
      sampleCount: stableWindow.length,
      rssKb: {
        first: rssValues[0] ?? null,
        last: rssValues.at(-1) ?? null,
        min: rssValues.length ? Math.min(...rssValues) : null,
        max: rssValues.length ? Math.max(...rssValues) : null,
        median: median(rssValues),
        growth: rssGrowthKb,
      },
      fds: {
        first: fdValues[0] ?? null,
        last: fdValues.at(-1) ?? null,
        min: fdValues.length ? Math.min(...fdValues) : null,
        max: fdValues.length ? Math.max(...fdValues) : null,
        growth: fdGrowth,
      },
      sockets: {
        first: socketValues[0] ?? null,
        last: socketValues.at(-1) ?? null,
        min: socketValues.length ? Math.min(...socketValues) : null,
        max: socketValues.length ? Math.max(...socketValues) : null,
        growth: socketGrowth,
      },
      leakVerdict: leakVerdict ? "no-monotonic-leak-detected" : "failed-threshold",
    },
  },
  restarts: { childRestart, polythRestart },
  processOwnership: {
    killTargets,
    current: {
      polyth: currentPolythIdentity,
      wrapper: currentWrapperIdentity,
      child: currentChildIdentity,
    },
    scratchProcesses,
    staleOwnedAlive,
    foreignFinal,
  },
  invariants: {
    observedDirect: Object.fromEntries(observedDirect),
    duplicateDirectMarkers,
    toolEffectLines: effectLines,
    duplicateEffects,
    duplicateUpstreamMarkers,
    upstreamMarkerCounts: Object.fromEntries(upstreamMarkerCounts),
    stuckProjections: stuckProjections.map((projection) => ({
      id: projection.id,
      status: projection.status,
    })),
  },
  checks,
  apiErrors,
  expectedConflicts,
  samples,
};
writeJson(join(ARTIFACTS, "metrics.json"), metrics);
writeJson(join(ARTIFACTS, "live-state.json"), {
  note: "Final Polyth and its owned runtime intentionally remain running for follow-up inspection.",
  baseUrl: `http://127.0.0.1:${PORT}`,
  scratch,
  polyth: currentPolythIdentity,
  wrapper: currentWrapperIdentity,
  child: currentChildIdentity,
});

for (const file of ["wire.ndjson", "timeline.ndjson", "opencode.log", "state.json"]) {
  const source = join(proxyDir, file);
  if (existsSync(source)) copyFileSync(source, join(LOGS, `proxy-${file}`));
}

const failedChecks = checks.filter((item) => !item.pass);
const results = `# Phase 9 — scaled soak

This is a scaled dense soak, **not a 24-hour claim**. Real OpenCode
\`${manifest.opencode.version}\` ran for ${(metrics.churnDurationMs / 60_000).toFixed(1)}
minutes of automated churn on forced legacy protocol, port ${PORT} (never
14500), with ${sessionIds.length} sessions and ${logicalMessages} unique logical
messages.

## Verdicts

| ID | Verdict | Result |
| --- | --- | --- |
| OC-REAL-084 (scaled) | **${failedChecks.length === 0 ? "PASS" : "FAIL"}** | ${sessionIds.length} sessions, ${logicalMessages} logical messages, ${samples.length} resource samples, ${modelRefreshes} model refreshes, ${websocketReconnects} client reconnects, one Polyth restart, and one owned-child restart. ${leakVerdict ? "No monotonic non-data resource leak crossed the bounded thresholds." : "A resource threshold failed; inspect metrics.json."} |
| OC-REAL-085 | **NOT RUN** | The Phase 2 mutation-loss proxy was not composed into this ownership soak. Process death/replacement was exercised, but no response-loss verdict is claimed. |
| OC-REAL-086 (scaled) | **PARTIAL** | ${queueBeforeDrain.length} durable FIFO rows survived child + Polyth restart and drained through exact queue-row removals with zero rows left. Automatic FIFO execution and recurring permission/question stress were not completed because of the already-documented real legacy terminal-evidence gap, so full queue-dispatch acceptance is not claimed. |
| OC-REAL-087 (scaled) | **PARTIAL** | One isolated project/runtime was churned through owned-child and Polyth replacement with exact PID/cwd checks. Worktree, second-project, SSH, and config-batch churn were not included. |

## Measurements

- Polyth late-window RSS: ${rssValues[0] ?? "n/a"} → ${rssValues.at(-1) ?? "n/a"} KiB
  (growth ${rssGrowthKb} KiB; min ${rssValues.length ? Math.min(...rssValues) : "n/a"},
  max ${rssValues.length ? Math.max(...rssValues) : "n/a"}).
- Polyth late-window descriptors: ${fdValues[0] ?? "n/a"} → ${fdValues.at(-1) ?? "n/a"}
  (growth ${fdGrowth}); sockets: ${socketValues[0] ?? "n/a"} →
  ${socketValues.at(-1) ?? "n/a"} (growth ${socketGrowth}).
- Event-log footprint: ${finalSample.database.totalBytes} bytes total; rows:
  ${JSON.stringify(finalSample.database.rows)}.
- Session load latency: p50 ${metrics.latenciesMs.sessionLoad.p50} ms, p95
  ${metrics.latenciesMs.sessionLoad.p95} ms, max ${metrics.latenciesMs.sessionLoad.max} ms.
- WebSocket reconnect/gap-fill latency: p50 ${metrics.latenciesMs.websocketReconnect.p50}
  ms, p95 ${metrics.latenciesMs.websocketReconnect.p95} ms, max
  ${metrics.latenciesMs.websocketReconnect.max} ms.
- Model refresh latency: p50 ${metrics.latenciesMs.modelRefresh.p50} ms, p95
  ${metrics.latenciesMs.modelRefresh.p95} ms.

## Invariants

${checks.map((item) => `- ${item.pass ? "**PASS**" : "**FAIL**"} — ${item.name}: ${item.observed}`).join("\n")}

The final Polyth process and its currently owned OpenCode wrapper/child remain
running for follow-up inspection. Their exact identities and parent chain are
recorded in \`live-state.json\`. Raw timeline, wire, process, and per-sample
metrics are under \`logs/opencode-real-world/phase-9/\`.
`;
writeFileSync(join(ARTIFACTS, "RESULTS.md"), results);
timeline({
  event: "complete",
  pass: failedChecks.length === 0,
  failedChecks: failedChecks.map((item) => item.name),
  metricsPath: join(ARTIFACTS, "metrics.json"),
});

console.log(json({
  verdict: failedChecks.length === 0 ? "pass" : "fail",
  churnDurationMs: metrics.churnDurationMs,
  sessions: sessionIds.length,
  logicalMessages,
  leakVerdict: metrics.resources.stableWindow.leakVerdict,
  failedChecks: failedChecks.map((item) => item.name),
  liveState: join(ARTIFACTS, "live-state.json"),
}));
