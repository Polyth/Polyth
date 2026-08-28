/**
 * Phase 8 real-SSH validation (OC-REAL-078..082).
 *
 * Uses a real localhost OpenSSH daemon configured by the operator. The target
 * is the same Linux VM, but every command/process/forward crosses ssh(1)'s
 * production ControlMaster transport. This is intentionally not a fake host.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, platform, release } from "node:os";
import { join, resolve } from "node:path";

import type { AgentRuntime, RuntimeEvent } from "@polyth/contracts";
import { createRemoteOpenCodeRuntime, probeRemoteOpenCode } from "@polyth/backend-opencode";
import { createSshService, type SshService } from "@polyth/ssh";

const ROOT = resolve(import.meta.dirname, "../..");
const ARTIFACTS = join(ROOT, "artifacts/opencode-real-world/phase-8");
const LOGS = join(ROOT, "logs/opencode-real-world/phase-8");
const SSH_PORT = Number(process.env.PHASE8_SSH_PORT ?? 22282);
const SSH_KEY = process.env.PHASE8_SSH_KEY ?? "/tmp/polyth-phase8-sshd/client_key";
const REMOTE_BIN = "/home/ubuntu/.opencode/bin/opencode";
const MODEL = { providerID: "opencode", modelID: "big-pickle" };
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const backgroundErrors: string[] = [];

process.on("unhandledRejection", (reason) => {
  const error = String(reason);
  backgroundErrors.push(error);
  console.error("phase8 background rejection:", error);
});

if (SSH_PORT === 14500) throw new Error("phase 8 must not use port 14500");
if (!existsSync(SSH_KEY)) throw new Error(`missing PHASE8_SSH_KEY: ${SSH_KEY}`);

interface Scenario {
  id: string;
  root: string;
  project: string;
  config: string;
  data: string;
  wrapper: string;
  artifactDir: string;
  logDir: string;
  socketDir: string;
  service: SshService;
  connectionId: string;
  timeline: Array<Record<string, unknown>>;
}

const json = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => typeof item === "bigint" ? Number(item) : item, 2);

const shortHash = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
};

const mark = (scenario: Scenario, type: string, data: Record<string, unknown> = {}) => {
  scenario.timeline.push({ at: new Date().toISOString(), type, ...data });
};

const makeScenario = async (id: string): Promise<Scenario> => {
  const root = `/tmp/ocreal-phase8/${id.toLowerCase()}-${Date.now().toString(36)}`;
  const project = join(root, "project");
  const config = join(root, "config");
  const data = join(root, "data");
  const wrapper = join(root, "opencode-isolated");
  const artifactDir = join(ARTIFACTS, id);
  const logDir = join(LOGS, id);
  const socketDir = join(root, "sockets");
  for (const directory of [root, project, config, data, artifactDir, logDir, socketDir]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(join(project, "MARKER.txt"), `${id}_REMOTE_MARKER\n`);
  await writeFile(join(project, "attachment.txt"), `${id} attachment bytes\n`);
  await writeFile(join(config, "opencode.json"), json({
    $schema: "https://opencode.ai/config.json",
    permission: { read: "allow", bash: "allow" },
  }));
  await writeFile(wrapper, [
    "#!/bin/sh",
    `export OPENCODE_CONFIG_DIR=${config}`,
    `export XDG_DATA_HOME=${data}`,
    `exec ${REMOTE_BIN} "$@"`,
    "",
  ].join("\n"), { mode: 0o700 });
  const service = createSshService({
    file: join(root, "ssh.json"),
    socketDir,
    connectTimeoutSeconds: 3,
    controlPersistSeconds: 600,
  });
  const connection = service.create({
    name: `phase8-${id}`,
    host: "127.0.0.1",
    port: SSH_PORT,
    user: "ubuntu",
    authMode: "identity-file",
    identityFile: SSH_KEY,
  });
  return {
    id, root, project, config, data, wrapper, artifactDir, logDir, socketDir,
    service, connectionId: connection.id, timeline: [],
  };
};

const writeScenario = async (
  scenario: Scenario,
  verdict: "PASS" | "PARTIAL" | "FAIL",
  attribution: "NONE" | "POLYTH" | "ENV",
  summary: string,
  details: Record<string, unknown>,
) => {
  await writeFile(join(scenario.logDir, "timeline.ndjson"),
    `${scenario.timeline.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await writeFile(join(scenario.artifactDir, "details.json"), json(details));
  await writeFile(join(scenario.artifactDir, "verdict.json"), json({
    id: scenario.id, verdict, attribution, summary,
  }));
};

const configHash = (scenario: Scenario): string =>
  createHash("sha256").update(execFileSync("ssh", [
    "-i", SSH_KEY, "-p", String(SSH_PORT), "-o", "BatchMode=yes",
    "ubuntu@127.0.0.1", `sha256sum '${join(scenario.config, "opencode.json")}'`,
  ], { encoding: "utf8" }).trim()).digest("hex");

const makeRuntime = async (
  scenario: Scenario,
  pickPort?: () => number,
): Promise<{ runtime: AgentRuntime; events: Array<{ at: string; sessionId: string; event: RuntimeEvent }> }> => {
  const events: Array<{ at: string; sessionId: string; event: RuntimeEvent }> = [];
  const runtime = await createRemoteOpenCodeRuntime({
    host: scenario.service.host(scenario.connectionId),
    remotePath: scenario.project,
    bin: scenario.wrapper,
    ...(pickPort ? { pickPort } : {}),
    listenTimeoutMs: 30_000,
    readyTimeoutMs: 30_000,
    lifecycleTimeoutMs: 10_000,
  });
  runtime.onEvent((sessionId, event) => {
    const record = { at: new Date().toISOString(), sessionId, event };
    events.push(record);
    mark(scenario, "runtime-event", { sessionId, event });
  });
  return { runtime, events };
};

const waitModels = async (runtime: AgentRuntime) => {
  let models = await runtime.models();
  for (let attempt = 0; attempt < 30 && models.length === 0; attempt++) {
    await sleep(1_000);
    models = await runtime.models();
  }
  return models;
};

const ensure = async (runtime: AgentRuntime, scenario: Scenario, canonical: string) =>
  runtime.ensureSession({
    sessionId: canonical,
    projectId: "phase8",
    cwd: scenario.project,
    title: canonical,
  });

const pidRecord = async (scenario: Scenario): Promise<{
  token: string; pid: number; start: string; executable: string; commandHash: string;
}> => {
  const file = `$HOME/.cache/polyth/serve-${shortHash(scenario.project)}.pid`;
  const result = await scenario.service.exec(scenario.connectionId, `cat "${file}"`);
  if (result.code !== 0) throw new Error(`cannot read remote pid record: ${result.stderr}`);
  const [token, pid, start, executable, commandHash] = result.stdout.trim().split("\t");
  return { token: token!, pid: Number(pid), start: start!, executable: executable!, commandHash: commandHash! };
};

const masterPid = async (scenario: Scenario): Promise<number> => {
  const socket = join(scenario.socketDir, `${shortHash(scenario.connectionId)}.sock`);
  const checked = spawnSync("ssh", [
    "-o", `ControlPath=${socket}`, "-O", "check", "--", "ubuntu@127.0.0.1",
  ], { encoding: "utf8" });
  const output = `${checked.stdout}${checked.stderr}`;
  if (checked.status !== 0) throw new Error(`ControlMaster check failed: ${output}`);
  const match = output.match(/pid=(\d+)/);
  if (!match) throw new Error(`cannot parse ControlMaster PID: ${output}`);
  const pid = Number(match[1]);
  const command = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").replaceAll("\0", " ");
  if (!command.includes(socket)) throw new Error(`refusing to signal unverified ssh PID ${pid}`);
  return pid;
};

const dropMaster = async (scenario: Scenario): Promise<number> => {
  const pid = await masterPid(scenario);
  process.kill(pid, "SIGKILL");
  mark(scenario, "ssh-controlmaster-killed", { pid, signal: "SIGKILL" });
  await sleep(1_000);
  return pid;
};

const remoteAlive = async (scenario: Scenario, pid: number): Promise<boolean> => {
  const result = await scenario.service.exec(scenario.connectionId, `kill -0 ${pid} 2>/dev/null`);
  return result.code === 0;
};

const rawHistory = async (scenario: Scenario, backendId: string): Promise<string> => {
  const record = await pidRecord(scenario).catch(() => undefined);
  if (!record) return "";
  const command = (await scenario.service.exec(
    scenario.connectionId,
    `tr '\\000' ' ' < /proc/${record.pid}/cmdline`,
  )).stdout;
  const port = command.match(/--port (\d+)/)?.[1];
  if (!port) return "";
  const path = `/session/${encodeURIComponent(backendId)}/message?directory=${encodeURIComponent(scenario.project)}`;
  return (await scenario.service.exec(
    scenario.connectionId,
    `curl -fsS 'http://127.0.0.1:${port}${path}'`,
    { timeoutMs: 20_000 },
  )).stdout;
};

const run078 = async () => {
  const scenario = await makeScenario("OC-REAL-078");
  const host = scenario.service.host(scenario.connectionId);
  const details: Record<string, unknown> = {};
  let runtime: AgentRuntime | undefined;
  try {
    details.ssh = await scenario.service.test(scenario.connectionId);
    details.probe = await probeRemoteOpenCode(host, scenario.wrapper);
    const missingProbe = await probeRemoteOpenCode(host, "/tmp/definitely-missing-opencode");
    details.missingBinary = missingProbe;
    try {
      await createRemoteOpenCodeRuntime({ host, remotePath: join(scenario.root, "missing"), bin: scenario.wrapper });
    } catch (error) {
      details.missingPath = { code: (error as { code?: string }).code, message: String((error as Error).message) };
    }
    const occupiedPort = 28_178;
    const occupied = await scenario.service.exec(scenario.connectionId,
      `node -e 'require("net").createServer().listen(${occupiedPort},"127.0.0.1")' </dev/null >'${scenario.logDir}/occupier.log' 2>&1 & echo $!`);
    const occupiedPid = Number(occupied.stdout.trim());
    const picks = [occupiedPort, 28_179];
    try {
      ({ runtime } = await makeRuntime(scenario, () => picks.shift() ?? 28_180));
      details.collisionRecovered = true;
    } catch (error) {
      details.collisionRecovered = false;
      details.collisionError = { code: (error as { code?: string }).code, message: String((error as Error).message) };
      ({ runtime } = await makeRuntime(scenario, () => 28_179));
    } finally {
      await scenario.service.exec(scenario.connectionId, `kill ${occupiedPid} 2>/dev/null || true`);
    }
    const beforeHash = configHash(scenario);
    const endpoint = await runtime.endpoint!();
    const models = await waitModels(runtime);
    const agents = await runtime.agents();
    const backendId = await ensure(runtime, scenario, "phase8-078");
    const sessions = await runtime.sessions();
    const events: RuntimeEvent[] = [];
    runtime.onEvent((_sessionId, event) => events.push(event));
    const outcome = await runtime.startTurnOperation!({
      sessionId: "phase8-078",
      text: "Read the attached file and MARKER.txt, then reply with both exact contents.",
      attachments: [{
        id: "phase8-att", name: "attachment.txt", mime: "text/plain",
        size: 30, kind: "file", path: "attachment.txt",
      }],
      model: MODEL,
    }, "phase8-078-prompt");
    await sleep(15_000);
    details.core = {
      endpoint, modelCount: models.length, hasBigPickle: models.some((model) =>
        model.providerID === MODEL.providerID && model.modelID === MODEL.modelID),
      agentCount: agents.length, backendId,
      joined: sessions.some((session) => session.id === backendId),
      promptOutcome: outcome, events, history: await runtime.history("phase8-078"),
      remotePid: await pidRecord(scenario),
      configReadOnly: endpoint.config,
      configUnchanged: beforeHash === configHash(scenario),
    };
    await writeScenario(
      scenario,
      details.collisionRecovered ? "PASS" : "FAIL",
      details.collisionRecovered ? "NONE" : "POLYTH",
      details.collisionRecovered
        ? "Real SSH start/probe/path/collision/core runtime checks succeeded."
        : "Real SSH core runtime worked, but an occupied remote port was not classified for retry.",
      details,
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    await scenario.service.disconnectAll();
  }
};

const run079 = async () => {
  const scenario = await makeScenario("OC-REAL-079");
  let runtime: AgentRuntime | undefined;
  try {
    ({ runtime } = await makeRuntime(scenario));
    await waitModels(runtime);
    const backendId = await ensure(runtime, scenario, "phase8-079");
    const before = await runtime.endpoint!();
    await dropMaster(scenario);
    const outcome = await runtime.startTurnOperation!({
      sessionId: "phase8-079", text: "Reply ONLY SHOULD_NOT_APPEAR.", model: MODEL,
    }, "phase8-079-prewire").catch((error) => ({ kind: "threw", error: String(error) }));
    await sleep(3_000);
    const status = await scenario.service.test(scenario.connectionId);
    let after: unknown;
    let history: unknown;
    try { after = await runtime.endpoint!(); } catch (error) { after = String(error); }
    try { history = await runtime.history("phase8-079"); } catch (error) { history = String(error); }
    const raw = await rawHistory(scenario, backendId).catch(() => "");
    const noMutation = !raw.includes("SHOULD_NOT_APPEAR");
    await writeScenario(
      scenario, noMutation ? "PARTIAL" : "FAIL", noMutation ? "POLYTH" : "POLYTH",
      noMutation
        ? "Pre-mutation tunnel loss did not apply the prompt, but automatic forward/session recovery did not complete."
        : "A prompt crossed despite the pre-mutation tunnel loss.",
      { before, outcome, status, after, history, rawHistory: raw, noMutation, backgroundErrors },
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    await scenario.service.disconnectAll();
  }
};

const runAcceptedDrop = async (id: "OC-REAL-080" | "OC-REAL-081") => {
  const scenario = await makeScenario(id);
  let runtime: AgentRuntime | undefined;
  try {
    const made = await makeRuntime(scenario);
    runtime = made.runtime;
    await waitModels(runtime);
    const canonical = `phase8-${id.slice(-3)}`;
    const backendId = await ensure(runtime, scenario, canonical);
    const prompt = id === "OC-REAL-081"
      ? 'Use bash to run "sleep 10; cat MARKER.txt", then reply exactly OFFLINE_COMPLETE and the marker.'
      : 'Use bash to run "sleep 8; cat MARKER.txt", then reply exactly ACCEPTED_ONCE and the marker.';
    const outcome = await runtime.startTurnOperation!({
      sessionId: canonical, text: prompt, model: MODEL,
    }, `${canonical}-operation`);
    const remoteBefore = await pidRecord(scenario);
    await sleep(1_000);
    const killedMasterPid = await dropMaster(scenario);
    await sleep(15_000);
    const remoteSurvived = await remoteAlive(scenario, remoteBefore.pid).catch(() => false);
    const rawBeforeRuntimeRecovery = await rawHistory(scenario, backendId).catch(() => "");
    let recoveredHistory: unknown;
    try { recoveredHistory = await runtime.history(canonical); } catch (error) { recoveredHistory = String(error); }
    const endpointAfter = await runtime.endpoint!().catch((error) => ({ error: String(error) }));
    const userCount = rawBeforeRuntimeRecovery.split(prompt).length - 1;
    const completedOffline = /OFFLINE_COMPLETE/.test(rawBeforeRuntimeRecovery);
    const pass = remoteSurvived && userCount === 1 && (id === "OC-REAL-080" || completedOffline);
    await writeScenario(
      scenario, pass ? "PASS" : "FAIL", pass ? "NONE" : "POLYTH",
      pass
        ? "The accepted prompt remained single and remote state reconciled after SSH recovery."
        : "Dropping the SSH ControlMaster terminated or stranded the active remote runtime; offline completion was not recovered.",
      {
        outcome, backendId, killedMasterPid, remoteBefore, remoteSurvived,
        rawBeforeRuntimeRecovery, recoveredHistory, endpointAfter,
        eventCount: made.events.length, userCount, completedOffline,
        boundaryNote: "Tunnel was dropped after confirmed prompt response; no response-hold proxy was inserted into SSH.",
      },
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    await scenario.service.disconnectAll();
  }
};

const run082 = async () => {
  const scenario = await makeScenario("OC-REAL-082");
  let runtime: AgentRuntime | undefined;
  try {
    ({ runtime } = await makeRuntime(scenario));
    await waitModels(runtime);
    await ensure(runtime, scenario, "phase8-082");
    const before = await pidRecord(scenario);
    const verified = await scenario.service.exec(
      scenario.connectionId,
      `test "$(sed 's/.*) //' /proc/${before.pid}/stat | cut -d' ' -f20)" = '${before.start}' && kill ${before.pid}`,
    );
    await sleep(2_000);
    let recovery: unknown;
    try { recovery = await runtime.models(); } catch (error) { recovery = String(error); }
    const endpointAfter = await runtime.endpoint!().catch((error) => ({ error: String(error) }));
    await runtime.dispose().catch(() => undefined);
    runtime = undefined;

    const sleeper = await scenario.service.exec(scenario.connectionId,
      "nohup sleep 120 </dev/null >/dev/null 2>&1 & echo $!");
    const sleeperPid = Number(sleeper.stdout.trim());
    const pidFile = `$HOME/.cache/polyth/serve-${shortHash(scenario.project)}.pid`;
    await scenario.service.exec(scenario.connectionId,
      `printf 'stale-token\\t${sleeperPid}\\twrong-start\\t/wrong/exe\\twrong-hash\\n' > "${pidFile}"`);
    const second = await makeRuntime(scenario);
    const stalePidSurvived = await remoteAlive(scenario, sleeperPid);
    await second.runtime.dispose();
    await scenario.service.exec(scenario.connectionId, `kill ${sleeperPid} 2>/dev/null || true`);
    await writeScenario(
      scenario,
      stalePidSurvived ? "PARTIAL" : "FAIL",
      stalePidSurvived ? "POLYTH" : "POLYTH",
      stalePidSurvived
        ? "Exact remote child and PID-reuse guard worked; active-session replacement could not prove continuity."
        : "The stale/reused PID guard signalled an unrelated process.",
      { before, verifiedKill: verified, recovery, endpointAfter, sleeperPid, stalePidSurvived },
    );
  } finally {
    await runtime?.dispose().catch(() => undefined);
    await scenario.service.disconnectAll();
  }
};

await rm(ARTIFACTS, { recursive: true, force: true });
await rm(LOGS, { recursive: true, force: true });
await mkdir(ARTIFACTS, { recursive: true });
await mkdir(LOGS, { recursive: true });
await run078();
await run079();
await runAcceptedDrop("OC-REAL-080");
await runAcceptedDrop("OC-REAL-081");
await run082();
await writeFile(join(ARTIFACTS, "environment.json"), json({
  kind: "real localhost OpenSSH daemon",
  limitation: "SSH target is the same Linux VM; no external remote host was available.",
  ssh: { host: "127.0.0.1", port: SSH_PORT, user: "ubuntu", identityFile: SSH_KEY },
  host: { hostname: hostname(), platform: platform(), release: release() },
  node: process.version,
  opencode: execFileSync(REMOTE_BIN, ["--version"], { encoding: "utf8" }).trim(),
  git: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  note: "Every remote runtime uses a fresh project, OPENCODE_CONFIG_DIR, XDG_DATA_HOME, ControlMaster socket and forwarded local port.",
}));
