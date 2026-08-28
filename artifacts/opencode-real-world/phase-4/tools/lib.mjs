// Shared phase-4 runner helpers: start/stop the REAL Polyth server process,
// drive its HTTP API, read Polyth's own PID record for the owned OpenCode
// child, verify /proc identity, and signal exact PIDs only.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, createWriteStream, existsSync, mkdirSync,
  readFileSync, readlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const TOOLS = "/tmp/ocreal/phase-4/tools";
export const REAL_BIN = "/home/ubuntu/.local/bin/opencode";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const scenarioSetup = (id, port) => {
  const runId = `run-${Date.now().toString(36)}`;
  const base = `/tmp/ocreal/phase-4/${id}/${runId}`;
  const dirs = {
    base,
    project: join(base, "project"),
    polythData: join(base, "polyth-data"),
    ocConfig: join(base, "opencode-config"),
    xdgData: join(base, "xdg-data"),
    proxy: join(base, "proxy"),
    shim: join(base, "shim"),
    logs: `/workspace/logs/opencode-real-world/phase-4/${id}`,
    artifacts: `/workspace/artifacts/opencode-real-world/phase-4/${id}`,
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dirs.ocConfig, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
  }, null, 2));
  return { id, runId, port, dirs };
};

export const timeline = (ctx, entry) =>
  appendFileSync(join(ctx.dirs.logs, "fault-timeline.ndjson"),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");

export const startPolyth = async (ctx, options = {}) => {
  const label = options.label ?? "polyth";
  const log = createWriteStream(join(ctx.dirs.logs, `${label}.log`), { flags: "a" });
  const env = {
    ...process.env,
    PORT: String(ctx.port),
    POLYTH_DATA_DIR: ctx.dirs.polythData,
    OC_PROTOCOL: options.protocol ?? "legacy",
    OC_CONFIG_DIR: ctx.dirs.ocConfig,
    XDG_DATA_HOME: ctx.dirs.xdgData,
    ...(options.bin ? { OC_BIN: options.bin } : {}),
    ...(options.startupDeadlineMs ? { OC_STARTUP_DEADLINE_MS: String(options.startupDeadlineMs) } : {}),
    ...(options.env ?? {}),
  };
  const child = spawn(process.execPath, [join(TOOLS, "boot-polyth.mjs")], {
    cwd: "/workspace",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`polyth ${label} did not listen in 30s`)), 30000);
    const onChunk = (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes("[polyth] server on")) {
        clearTimeout(timer);
        resolveReady(undefined);
      }
      if (buffer.includes("[harness] polyth boot failed")) {
        clearTimeout(timer);
        rejectReady(new Error("polyth boot failed; see log"));
      }
    };
    child.stdout.on("data", (c) => { log.write(c); onChunk(c); });
    child.stderr.on("data", (c) => { log.write(c); onChunk(c); });
    child.on("exit", (code, signal) => {
      log.write(`\n[harness] polyth ${label} exited code=${code} signal=${signal}\n`);
      clearTimeout(timer);
      rejectReady(new Error(`polyth exited early code=${code} signal=${signal}`));
    });
  });
  await ready;
  timeline(ctx, { event: "polyth-started", label, pid: child.pid, port: ctx.port });
  return child;
};

export const api = async (ctx, method, path, body, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { __raw: text.slice(0, 2000) }; }
  return { status: response.status, json };
};

export const procIdentity = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const exe = readlinkSync(`/proc/${pid}/exe`);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ").trim();
    const close = stat.lastIndexOf(")");
    const startIdentity = stat.slice(close + 2).trim().split(/\s+/)[19];
    return { startIdentity, exe, cmdline };
  } catch {
    return undefined;
  }
};

export const pidFileFor = (cwd) => {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24);
  return `/tmp/polyth-opencode/${key}.pid.json`;
};

export const readPidRecord = (cwd) => {
  try {
    return JSON.parse(readFileSync(pidFileFor(cwd), "utf8"));
  } catch {
    return undefined;
  }
};

export const waitFor = async (predicate, { timeoutMs = 30000, intervalMs = 200, what = "condition" } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${what}`);
};

/** SIGKILL/SIGTERM exactly one PID after verifying its /proc identity. */
export const killExact = (ctx, pid, expect, signal = "SIGKILL") => {
  const identity = procIdentity(pid);
  if (!identity) throw new Error(`pid ${pid} is not alive; refusing to signal`);
  if (expect && !identity.cmdline.includes(expect)) {
    throw new Error(`pid ${pid} identity mismatch: ${identity.cmdline}`);
  }
  process.kill(pid, signal);
  timeline(ctx, { event: "kill-exact", pid, signal, identity });
  return identity;
};

export const dumpDb = (ctx, label, sessionId) => {
  const out = execFileSync(process.execPath, [
    join(TOOLS, "dbdump.mjs"),
    join(ctx.dirs.polythData, "sessions.db"),
    ...(sessionId ? [sessionId] : []),
  ], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  writeFileSync(join(ctx.dirs.logs, `db-${label}.json`), out);
  return JSON.parse(out);
};

export const gitSha = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: "/workspace" }).toString().trim();
export const ocSha256 = () => {
  const out = execFileSync("sha256sum", [REAL_BIN]).toString();
  return out.split(/\s+/)[0];
};

export const writeManifest = (ctx, extra = {}) => {
  const manifest = {
    id: ctx.id,
    runId: ctx.runId,
    startedAt: new Date().toISOString(),
    gitSha: gitSha(),
    opencode: { version: "1.18.18", binary: REAL_BIN, sha256: ocSha256() },
    node: process.version,
    os: `${process.platform} ${process.arch}`,
    protocol: "legacy (forced)",
    polythPort: ctx.port,
    projectPath: ctx.dirs.project,
    polythDataDir: ctx.dirs.polythData,
    opencodeConfigDir: ctx.dirs.ocConfig,
    xdgDataHome: ctx.dirs.xdgData,
    ...extra,
  };
  writeFileSync(join(ctx.dirs.artifacts, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
};

export const writeVerdict = (ctx, verdict) => {
  writeFileSync(join(ctx.dirs.artifacts, "verdict.json"), JSON.stringify({
    id: ctx.id,
    opencodeVersion: "1.18.18",
    protocol: "legacy (forced)",
    ...verdict,
  }, null, 2));
};

export const writeDetails = (ctx, details) =>
  writeFileSync(join(ctx.dirs.artifacts, "details.json"), JSON.stringify(details, null, 2));

export const stopPolyth = async (ctx, child, how = "SIGTERM") => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill(how);
  await Promise.race([exited, sleep(8000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.race([exited, sleep(2000)]);
  timeline(ctx, { event: "polyth-stopped", pid: child.pid, how });
};

export const eventsOf = async (ctx, sessionId) =>
  (await api(ctx, "GET", `/api/sessions/${sessionId}/events?afterSeq=0`)).json;

export const snapshotOf = async (ctx, sessionId) =>
  (await api(ctx, "GET", `/api/sessions/${sessionId}`)).json;
